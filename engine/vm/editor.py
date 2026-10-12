"""Файлы для редактора на странице (бета): прокси-видео, волна звука и лента кадров исходника `source.mp4`.

- `out/proxy.mp4` — 540×960, H.264 и AAC, ключевой кадр каждые 0,5 с (быстрый переход по кускам); битрейт картинки и
  звука вместе — чтобы файл уместился в git (до 95 МБ): Action job-outputs переносит его в черновик релиза, как готовый
  ролик, и страница отдаёт его плееру ссылкой на ассет. Исходник длиннее MAX_PROXY_SECONDS или прокси всё-таки больше
  предела — прокси нет (`proxy: null`), редактор показывает дорожки без видео.
- `film.jpg` — лента кадров одной картинкой: кадр каждые `step` с, 54×96.
- `editor.json` — что где: длительность, прокси, лента и волна (`peaks`: пиков в секунду и base64 байтов 0–255);
  `videos` — где в исходнике каждое видео задачи (их несколько — `normalize` склеил их по порядку).
Времена — по исходнику, как в words.json и edit.json.
"""
import base64
import math
import os
import tempfile
import wave
from pathlib import Path

import numpy as np

from .audio import LOUDNORM
from .git import MAX_FILE_BYTES
from .job import Job
from .media import (
    MediaError,
    _atomic,
    _ffmpeg,
    extract_wav,
    part_spans,
    probe,
    source_parts,
)

PROXY = {"width": 540, "height": 960, "key": 0.5}
FILM = {"w": 54, "h": 96, "step": 0.5, "max": 1000}  # не больше 1000 кадров: ширина JPEG — до 65 535 px
PEAKS_PER_S = 50
PEAKS_RATE = 8000  # Гц — звук для волны: пики по 20 мс, этого хватает
MB = 1024 * 1024
TOTAL_BUDGET = 75 * MB  # байт на весь прокси — картинка и звук; запас до 95 МБ git — на перелёт битрейта x264
MAX_PROXY_BYTES = MAX_FILE_BYTES  # больше — в git не положить: прокси не будет
MAX_PROXY_SECONDS = 2 * 3600  # исходник длиннее — прокси не делаем: в бюджет влезла бы только каша
MAX_RATE = 1_500_000  # бит/с картинки — для 540×960 больше не нужно
MIN_RATE = 64_000
AUDIO_RATE = 96_000  # бит/с звука; у длинного исходника меньше, но не ниже MIN_AUDIO
MIN_AUDIO = 24_000


def film_step(duration: float) -> float:
    """Шаг ленты кадров, с: 0,5 с, а у длинного исходника реже — не больше FILM['max'] кадров."""
    return max(FILM["step"], duration / FILM["max"])


def _total_rate(duration: float) -> float:
    return TOTAL_BUDGET * 8 / max(duration, 1.0)


def audio_rate(duration: float) -> int:
    """Битрейт звука прокси, бит/с: AUDIO_RATE, у длинного исходника — пятая часть бюджета (не ниже MIN_AUDIO)."""
    return int(max(MIN_AUDIO, min(AUDIO_RATE, _total_rate(duration) / 5)))


def proxy_rate(duration: float) -> int:
    """Битрейт картинки прокси, бит/с: MAX_RATE, у длинного исходника — что осталось от бюджета после звука."""
    return int(max(MIN_RATE, min(MAX_RATE, _total_rate(duration) - audio_rate(duration))))


def _proxy(source: Path, out: Path, duration: float, fps: float, audio: bool) -> None:
    rate = proxy_rate(duration)
    gop = max(1, round(PROXY["key"] * fps))
    with _atomic(out) as tmp:
        _ffmpeg(
            "-i", source, "-map", "0:v:0", *(["-map", "0:a:0"] if audio else []),
            "-vf", f"scale={PROXY['width']}:{PROXY['height']}:flags=bicubic,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", 28, "-maxrate", rate, "-bufsize", 2 * rate,
            "-g", gop, "-keyint_min", gop, "-sc_threshold", 0,
            # голос — на громкости голоса в ролике (как его выравнивает движок): редактор сводит его с музыкой как в ролике
            *(["-af", f"{LOUDNORM},aresample=48000,atrim=end={duration:.3f}", "-c:a", "aac", "-b:a", audio_rate(duration), "-ac", 2]
              if audio else []),
            "-movflags", "+faststart", tmp,
        )


def _film(source: Path, out: Path, duration: float) -> dict:
    step = film_step(duration)
    w, h = FILM["w"], FILM["h"]
    with tempfile.TemporaryDirectory() as tmp:
        # select, а не fps: на коротком клипе fps с редким шагом может не отдать ни кадра (как у contact_sheet)
        _ffmpeg("-i", source, "-vf", f"select='gte(t,selected_n*{step})',scale={w}:{h}", "-fps_mode", "vfr", "-q:v", 5,
                f"{tmp}/%05d.jpg")
        n = len(os.listdir(tmp))
        with _atomic(out) as sheet:
            _ffmpeg("-framerate", 1, "-i", f"{tmp}/%05d.jpg", "-vf", f"tile={n}x1", "-frames:v", 1, "-q:v", 5, sheet)
    return {"file": "film.jpg", "step": round(step, 3), "w": w, "h": h, "n": n}


PEAKS_CHUNK = 60  # с звука за раз: длинный исходник не читается в память целиком


def _peaks(source: Path, work: Path, duration: float) -> bytes:
    """Пик громкости каждые 1/PEAKS_PER_S с, 0–255 (255 — громкий голос: 99-й перцентиль пиков); звука нет — нули."""
    n = max(1, math.ceil(duration * PEAKS_PER_S))
    try:
        wav = extract_wav(source, work / "peaks.wav", rate=PEAKS_RATE)
    except MediaError:  # у исходника нет звука
        return bytes(n)
    per = PEAKS_RATE // PEAKS_PER_S
    found = []
    try:
        with wave.open(str(wav)) as w:
            while True:
                block = w.readframes(per * PEAKS_PER_S * PEAKS_CHUNK)
                if not block:
                    break
                x = np.abs(np.frombuffer(block, dtype=np.int16).astype(np.float32)) / 32768
                x = np.pad(x, (0, -len(x) % per))
                found.append(x.reshape(-1, per).max(axis=1))
    finally:
        wav.unlink(missing_ok=True)
    peaks = np.concatenate(found) if found else np.zeros(0, dtype=np.float32)
    peaks = np.pad(peaks, (0, max(0, n - len(peaks))))[:n]
    top = float(np.percentile(peaks, 99)) if peaks.size else 0.0
    if top < 1e-4:  # тишина
        return bytes(n)
    return bytes(np.clip(peaks / top * 255, 0, 255).astype(np.uint8))


def video_marks(job: Job, parts: list[Path], duration: float) -> list[dict]:
    """Где каждое видео задачи в исходнике длиной `duration`: имя, как у Павла (job.json), и [t0, t1] с. Стоп-кадр под
    озвучку длиннее видео — у последнего; озвучка короче — видео за её концом нет."""
    named: dict[str, str] = {}
    meta = job.read("job.json") if job.path("job.json").is_file() else {}
    for v in meta.get("videos") or []:
        if isinstance(v, dict) and isinstance(v.get("file"), str) and isinstance(v.get("name"), str):
            named[Path(v["file"]).name] = v["name"]
    if parts and not named and isinstance(meta.get("name"), str):  # задача из одного видео (как до нескольких)
        named[parts[0].name] = meta["name"]
    marks = []
    for k, (part, (a, b)) in enumerate(zip(parts, part_spans(parts), strict=True)):
        if a >= duration - 1e-3:
            break
        end = duration if k == len(parts) - 1 else min(b, duration)
        marks.append({"name": named.get(part.name, part.name), "t0": round(a, 3), "t1": round(end, 3)})
    return marks


def make(job: Job) -> dict:
    """Прокси, ленту и волну по `source.mp4` задачи заново → данные `editor.json` (он записан)."""
    source = job.path("source.mp4")
    info = probe(source)
    duration = info.duration
    if not (math.isfinite(duration) and duration > 0):
        raise ValueError(f"source.mp4: непонятная длительность {duration!r}")
    proxy_path = job.path("out/proxy.mp4")
    proxy = None
    if duration <= MAX_PROXY_SECONDS:
        _proxy(source, proxy_path, duration, info.fps or 30, info.has_audio)
        if proxy_path.stat().st_size > MAX_PROXY_BYTES:  # в git не положить — редактор без видео
            proxy_path.unlink()
        else:
            proxy = {"file": "out/proxy.mp4", **PROXY}
    film = _film(source, job.path("film.jpg"), duration)
    peaks = _peaks(source, job.path("work"), duration) if info.has_audio else bytes(max(1, math.ceil(duration * PEAKS_PER_S)))
    data = {
        "duration": round(duration, 6),  # как у ffprobe: последний кадр исходника страница считает как render.timeline
        "proxy": proxy,
        "film": film,
        "peaks": {"perS": PEAKS_PER_S, "data": base64.b64encode(peaks).decode("ascii")},
    }
    if parts := source_parts(job.path("in")):  # из каких видео склеен исходник (без них — задача без in/)
        data["videos"] = video_marks(job, parts, duration)
    job.write("editor.json", data)
    return data


def ensure(job: Job) -> dict | None:
    """Как `make`, но только если `editor.json` ещё нет (прокси к тому времени уже в релизе) → данные или None."""
    return None if job.path("editor.json").is_file() else make(job)
