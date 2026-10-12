"""Файлы для редактора на странице (бета): прокси-видео, волна звука и лента кадров исходника `source.mp4`.

- `out/proxy.mp4` — 540×960, H.264 и AAC, ключевой кадр каждые 0,5 с (быстрый переход по кускам); битрейт — чтобы
  файл уместился в git (до 95 МБ): Action job-outputs переносит его в черновик релиза, как готовый ролик, и
  страница отдаёт его плееру ссылкой на ассет.
- `film.jpg` — лента кадров одной картинкой: кадр каждые `step` с, 54×96.
- `editor.json` — что где: длительность, прокси, лента и волна (`peaks`: пиков в секунду и base64 байтов 0–255).
Времена — по исходнику, как в words.json и edit.json.
"""
import base64
import math
import os
import tempfile
import wave
from pathlib import Path

import numpy as np

from .job import Job
from .media import MediaError, _atomic, _ffmpeg, extract_wav, probe

PROXY = {"width": 540, "height": 960, "key": 0.5}
FILM = {"w": 54, "h": 96, "step": 0.5, "max": 1000}  # не больше 1000 кадров: ширина JPEG — до 65 535 px
PEAKS_PER_S = 50
PEAKS_RATE = 8000  # Гц — звук для волны: пики по 20 мс, этого хватает
MB = 1024 * 1024
PROXY_BUDGET = 80 * MB  # байт на картинку прокси: со звуком (96 кбит/с) — в пределах 95 МБ даже у часового исходника
MAX_RATE = 1_500_000  # бит/с — для 540×960 больше не нужно
AUDIO_RATE = 96_000


def film_step(duration: float) -> float:
    """Шаг ленты кадров, с: 0,5 с, а у длинного исходника реже — не больше FILM['max'] кадров."""
    return max(FILM["step"], duration / FILM["max"])


def proxy_rate(duration: float) -> int:
    """Битрейт картинки прокси, бит/с: MAX_RATE, а у длинного исходника меньше — файл в PROXY_BUDGET."""
    return int(min(MAX_RATE, PROXY_BUDGET * 8 / max(duration, 1.0)))


def _proxy(source: Path, out: Path, duration: float, fps: float, audio: bool) -> None:
    rate = proxy_rate(duration)
    gop = max(1, round(PROXY["key"] * fps))
    with _atomic(out) as tmp:
        _ffmpeg(
            "-i", source, "-map", "0:v:0", *(["-map", "0:a:0"] if audio else []),
            "-vf", f"scale={PROXY['width']}:{PROXY['height']}:flags=bicubic,format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", 28, "-maxrate", rate, "-bufsize", 2 * rate,
            "-g", gop, "-keyint_min", gop, "-sc_threshold", 0,
            *(["-c:a", "aac", "-b:a", AUDIO_RATE, "-ac", 2] if audio else []),
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


def _peaks(source: Path, work: Path, duration: float) -> bytes:
    """Пик громкости каждые 1/PEAKS_PER_S с, 0–255 (255 — громкий голос: 99,9-й перцентиль); звука нет — нули."""
    n = max(1, math.ceil(duration * PEAKS_PER_S))
    try:
        wav = extract_wav(source, work / "peaks.wav", rate=PEAKS_RATE)
    except MediaError:  # у исходника нет звука
        return bytes(n)
    try:
        with wave.open(str(wav)) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    finally:
        wav.unlink(missing_ok=True)
    per = PEAKS_RATE // PEAKS_PER_S
    x = np.pad(np.abs(x), (0, max(0, n * per - len(x))))[: n * per]
    top = float(np.percentile(x, 99.9)) if x.size else 0.0
    if top < 1e-4:  # тишина
        return bytes(n)
    return bytes(np.clip(x.reshape(n, per).max(axis=1) / top * 255, 0, 255).astype(np.uint8))


def make(job: Job) -> dict:
    """Прокси, ленту и волну по `source.mp4` задачи заново → данные `editor.json` (он записан)."""
    source = job.path("source.mp4")
    info = probe(source)
    duration = info.duration
    if not (math.isfinite(duration) and duration > 0):
        raise ValueError(f"source.mp4: непонятная длительность {duration!r}")
    _proxy(source, job.path("out/proxy.mp4"), duration, info.fps or 30, info.has_audio)
    film = _film(source, job.path("film.jpg"), duration)
    peaks = _peaks(source, job.path("work"), duration) if info.has_audio else bytes(max(1, math.ceil(duration * PEAKS_PER_S)))
    data = {
        "duration": round(duration, 3),
        "proxy": {"file": "out/proxy.mp4", **PROXY},
        "film": film,
        "peaks": {"perS": PEAKS_PER_S, "data": base64.b64encode(peaks).decode("ascii")},
    }
    job.write("editor.json", data)
    return data


def ensure(job: Job) -> dict | None:
    """Как `make`, но только если `editor.json` ещё нет (прокси к тому времени уже в релизе) → данные или None."""
    return None if job.path("editor.json").is_file() else make(job)
