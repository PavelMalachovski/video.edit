"""Фикстуры движка: короткие клипы, которые ffmpeg рисует сам (lavfi), без файлов в репозитории.

Каждый клип собирается один раз и лежит в engine/tests/.cache/ (в .gitignore). В имени файла —
хэш команд: поправил команду — получил новый клип, а не устаревший из кэша. Клипы нарочно
«рукотворные» (однотонные кадры, тоны, маркер в углу), чтобы в тестах ожидаемое значение
выводилось из построения клипа, а не из проверяемого кода.

Речь для распознавания (`speech`) собирает espeak-ng по одному слову: начало каждого слова известно
точно, разметка лежит в JSON рядом с WAV.
"""
import hashlib
import inspect
import json
import math
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
import soundfile

CACHE = Path(__file__).parent / ".cache"

# кодирование коротких клипов: быстро; метки BT.709 — как у SDR-видео с iPhone
H264 = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p"]
BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
AAC = ["-c:a", "aac", "-b:a", "128k"]
# lavfi сам переводит RGB в yuv по BT.601, а клипы помечены BT.709 — «чистый» зелёный на экране выходит 0,215,0.
# Поэтому всё нарисованное переводим в yuv420p по матрице BT.709 явно, как кодирует настоящее видео.
YUV709 = "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p"


def ffmpeg(*args) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *map(str, args)],
        check=True,
        capture_output=True,
        text=True,
    )


def tone(freq: int, dur: float, rate: int = 48000) -> list[str]:
    """Вход ffmpeg: синусоида freq Гц."""
    return ["-f", "lavfi", "-i", f"sine=frequency={freq}:sample_rate={rate}:duration={dur}"]


def cached(name: str, *steps: list) -> Path:
    """Клип name из цепочки команд ffmpeg; в аргументах `{tmp}` — промежуточный файл, `{out}` — результат."""
    key = hashlib.sha1(json.dumps(steps, default=str).encode()).hexdigest()[:8]
    path = CACHE / f"{name}-{key}.mp4"
    if path.exists():
        return path
    CACHE.mkdir(parents=True, exist_ok=True)
    for stale in CACHE.glob(f"{name}-*.mp4"):  # команды поменялись — старый клип больше не нужен
        stale.unlink()
    tmp, partial = CACHE / f".{name}.{os.getpid()}.tmp.mp4", CACHE / f".{name}.{os.getpid()}.partial.mp4"  # два прогона не мешают
    try:
        for step in steps:
            ffmpeg(*(str(arg).replace("{tmp}", str(tmp)).replace("{out}", str(partial)) for arg in step))
        os.replace(partial, path)  # недоделанный клип в кэш не попадает
    finally:
        tmp.unlink(missing_ok=True)
        partial.unlink(missing_ok=True)
    return path


@pytest.fixture
def render_shot() -> Callable[[str, Path], None]:
    """Лист кадров готового ролика (2 кадра в секунду, по 6 в ряд) — в папку VM_RENDER_SHOTS. CI кладёт её в ветку
    ci-screens/render/<ветка>: так после каждого изменения видно, как выглядит смонтированный ролик. Без переменной —
    ничего не делает."""
    folder = os.environ.get("VM_RENDER_SHOTS")

    def shot(name: str, video: Path) -> None:
        if not folder:
            return
        out = Path(folder)
        out.mkdir(parents=True, exist_ok=True)
        seconds = float(subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
            check=True, capture_output=True, text=True).stdout.strip() or 0)
        rows = max(1, math.ceil(seconds * 2 / 6))
        ffmpeg("-i", video, "-vf", f"fps=2,scale=270:480,tile=6x{rows}", "-frames:v", "1", out / f"{name}.png")

    return shot


@pytest.fixture(scope="session")
def landscape() -> Path:
    """1920×1080@30, 2 с, звук 440 Гц стерео; чёрный кадр с красным квадратом 300×300 в левом верхнем углу."""
    return cached(
        "landscape",
        [
            "-f", "lavfi", "-i", f"color=c=black:s=1920x1080:r=30:d=2,format=rgb24,drawbox=x=0:y=0:w=300:h=300:color=red:t=fill,{YUV709}",
            *tone(440, 2),
            *H264, *BT709, *AAC, "-ac", "2", "{out}",
        ],
    )  # fmt: skip


@pytest.fixture(scope="session")
def rotated(landscape) -> Callable[[int], Path]:
    """rotated(градусы) — тот же клип с поворотом показа в метаданных (против часовой, как `-display_rotation`)."""

    def make(degrees: int) -> Path:
        return cached(
            f"landscape_rot{degrees}",
            ["-display_rotation", str(degrees), "-i", str(landscape), "-c", "copy", "{out}"],
        )

    return make


@pytest.fixture(scope="session")
def vertical_rot90(rotated) -> Path:
    """Как снимает iPhone: кадр лежит 1920×1080, а показывается вертикально 1080×1920 (поворот в метаданных)."""
    return rotated(90)


@pytest.fixture(scope="session")
def hlg_sdr_source() -> Path:
    """SDR-картинка 540×960, из которой сделан `hlg`: эталон яркости для проверки перевода HDR → SDR."""
    return cached("hlg_sdr_source", ["-f", "lavfi", "-i", "testsrc2=s=540x960:r=30:d=2", *H264, *BT709, "{out}"])


def _hdr_clip(name: str, transfer: str, dur: int, size: str) -> Path:
    # настоящий HDR, а не SDR с чужой меткой: цвета переведены в BT.2020 с кривой HLG/PQ, 10 бит (как в Плане 1)
    convert = (
        f"zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t={transfer}:m=bt2020nc:p=bt2020:r=tv:npl=100,"
        "format=yuv420p10le"
    )
    return cached(
        name,
        [
            "-f", "lavfi", "-i", f"testsrc2=s={size}:r=30:d={dur}",
            *tone(330, dur),
            "-vf", convert,
            "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p10le",
            "-color_primaries", "bt2020", "-color_trc", transfer, "-colorspace", "bt2020nc",
            *AAC, "-ac", "2", "{out}",
        ],
    )  # fmt: skip


@pytest.fixture(scope="session")
def hlg() -> Path:
    """HLG (так пишет iPhone): 540×960@30, 2 с, звук 330 Гц; картинка та же, что в `hlg_sdr_source`."""
    return _hdr_clip("hlg", "arib-std-b67", 2, "540x960")


@pytest.fixture(scope="session")
def pq() -> Path:
    """PQ (HDR10): 360×640@30, 1 с."""
    return _hdr_clip("pq", "smpte2084", 1, "360x640")


@pytest.fixture(scope="session")
def part_a() -> Path:
    """Часть 1: 1080×1920@30, 2,5 с, красный кадр, 440 Гц стерео 48 кГц; в тегах — место съёмки, как у iPhone."""
    return cached(
        "part_a",
        [
            "-f", "lavfi", "-i", f"color=c=0xFF0000:s=1080x1920:r=30:d=2.5,format=rgb24,{YUV709}",
            *tone(440, 2.5),
            *H264, *BT709, *AAC, "-ac", "2",
            "-metadata", "location=+55.7558+037.6173/", "-metadata", "title=private title", "{out}",
        ],
    )  # fmt: skip


@pytest.fixture(scope="session")
def part_b() -> Path:
    """Часть 2: 720×1280@60, 2 с, синий кадр, 880 Гц моно 44,1 кГц — всё не так, как в части 1."""
    return cached(
        "part_b",
        [
            "-f", "lavfi", "-i", f"color=c=0x0000FF:s=720x1280:r=60:d=2,format=rgb24,{YUV709}",
            *tone(880, 2, rate=44100),
            *H264, *BT709, *AAC, "-ac", "1", "{out}",
        ],
    )  # fmt: skip


@pytest.fixture(scope="session")
def long_audio() -> Path:
    """1080×1920@30: красный кадр 2 с, а звук 440 Гц идёт 2,4 с — звук длиннее картинки (так бывает у телефона)."""
    return cached(
        "long_audio",
        [
            "-f", "lavfi", "-i", f"color=c=0xFF0000:s=1080x1920:r=30:d=2,format=rgb24,{YUV709}",
            *tone(440, 2.4),
            *H264, *BT709, *AAC, "-ac", "2", "{out}",
        ],
    )  # fmt: skip


@pytest.fixture(scope="session")
def short_audio() -> Path:
    """1080×1920@30: красный кадр 2 с, а звук 440 Гц кончается на 1,5 с — звук короче картинки."""
    return cached(
        "short_audio",
        [
            "-f", "lavfi", "-i", f"color=c=0xFF0000:s=1080x1920:r=30:d=2,format=rgb24,{YUV709}",
            *tone(440, 1.5),
            *H264, *BT709, *AAC, "-ac", "2", "{out}",
        ],
    )  # fmt: skip


@pytest.fixture(scope="session")
def colors() -> Path:
    """1080×1920@30, 3 с: секунда красного, секунда зелёного, секунда синего; звук 500 Гц."""
    return cached(
        "colors",
        [
            "-f", "lavfi", "-i", f"color=c=0xFF0000:s=1080x1920:r=30:d=1,format=rgb24,{YUV709}",
            "-f", "lavfi", "-i", f"color=c=0x00FF00:s=1080x1920:r=30:d=1,format=rgb24,{YUV709}",
            "-f", "lavfi", "-i", f"color=c=0x0000FF:s=1080x1920:r=30:d=1,format=rgb24,{YUV709}",
            *tone(500, 3),
            "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]",
            "-map", "[v]", "-map", "3:a",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", *BT709, *AAC, "-ac", "2", "{out}",
        ],
    )  # fmt: skip


@pytest.fixture(scope="session")
def silent() -> Path:
    """720×1280@25, 1,2 с, серый кадр, без звуковой дорожки и без меток цвета (так бывает у записей экрана и старого видео)."""
    return cached(
        "silent",
        ["-f", "lavfi", "-i", f"color=c=0x808080:s=720x1280:r=25:d=1.2,format=rgb24,{YUV709}", *H264, "{out}"],
    )


@pytest.fixture(scope="session")
def portrait_4x3() -> Path:
    """1080×1440@30, 1 с, красный кадр, без звука: вертикальный, но не 9:16 (так снимает «Фото» на iPhone)."""
    return cached(
        "portrait_4x3",
        ["-f", "lavfi", "-i", f"color=c=0xFF0000:s=1080x1440:r=30:d=1,format=rgb24,{YUV709}", *H264, *BT709, "{out}"],
    )


# ---------- речь для распознавания ----------

SPEECH_RATE = 16000  # как отдаёт media.extract_wav
SPEECH_PHRASES = [
    ["сегодня", "я", "расскажу"],
    ["как", "я", "учу", "чешский", "каждый", "день"],
    ["добавь", "сюда", "логотип"],
]
# тишина, с: до речи, между словами фразы, между фразами, после речи (как в docs/spikes/asr_bench.py)
SPEECH_GAPS = {"lead": 0.5, "word": 0.12, "phrase": 0.8, "tail": 0.5}
ESPEAK = ["espeak-ng", "-v", "ru", "-s", "150"]
LONG_SPEECH_SECONDS = 80  # длиннее минуты: запись режется на куски; повторов столько, чтобы набралось не меньше


@dataclass(frozen=True)
class Spoken:
    """Слово фикстуры: что сказано и где оно на самом деле (секунды от начала файла)."""

    text: str
    t0: float
    t1: float


@dataclass(frozen=True)
class Speech:
    wav: Path  # 16 кГц, моно, PCM 16 бит
    words: list[Spoken]
    duration: float


def _espeak_word(word: str, tmp: Path) -> np.ndarray:
    """Слово голосом espeak-ng, 16 кГц, без тишины по краям: начало слова — первый слышный отсчёт."""
    wav = tmp / "word.wav"
    subprocess.run([*ESPEAK, "-w", str(wav), word], check=True, capture_output=True)
    samples, rate = soundfile.read(wav, dtype="float32")
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    count = int(len(samples) * SPEECH_RATE / rate)
    samples = np.interp(np.linspace(0, len(samples) - 1, count), np.arange(len(samples)), samples).astype("float32")
    loud = np.flatnonzero(np.abs(samples) > 0.02)
    return samples[loud[0] : loud[-1] + 1]


def _build_speech() -> tuple[np.ndarray, list[Spoken]]:
    def gap(seconds: float) -> np.ndarray:
        return np.zeros(int(seconds * SPEECH_RATE), "float32")

    pieces, words = [gap(SPEECH_GAPS["lead"])], []
    at = len(pieces[0])  # положение в отсчётах: время слова считаем из них, а не копим секундами
    with tempfile.TemporaryDirectory() as tmp:
        for p, phrase in enumerate(SPEECH_PHRASES):
            for w, word in enumerate(phrase):
                audio = _espeak_word(word, Path(tmp))
                words.append(Spoken(word, at / SPEECH_RATE, (at + len(audio)) / SPEECH_RATE))
                last_of_phrase, last_phrase = w == len(phrase) - 1, p == len(SPEECH_PHRASES) - 1
                after = gap(SPEECH_GAPS["tail" if last_of_phrase and last_phrase else "phrase" if last_of_phrase else "word"])
                pieces += [audio, after]
                at += len(audio) + len(after)
    return np.concatenate(pieces), words


def _speech_paths() -> tuple[Path, Path]:
    # в хэше всё, от чего зависит результат: слова, паузы, голос и код сборки
    voice = subprocess.run(["espeak-ng", "--version"], check=True, capture_output=True, text=True).stdout
    recipe = [SPEECH_PHRASES, SPEECH_GAPS, ESPEAK, voice, inspect.getsource(_espeak_word), inspect.getsource(_build_speech)]
    key = hashlib.sha1(json.dumps(recipe).encode()).hexdigest()[:8]
    return CACHE / f"speech-{key}.wav", CACHE / f"speech-{key}.json"


@pytest.fixture(scope="session")
def speech() -> Speech:
    """Русская речь espeak-ng (`-v ru -s 150`) по одному слову, 12 слов в 3 фразах, 8,4 с.

    Паузы: 0,12 с между словами фразы, 0,8 с между фразами. Начало и конец каждого слова известны точно
    (`words`); разметка лежит в JSON рядом с WAV.
    """
    if shutil.which("espeak-ng") is None:
        pytest.skip("espeak-ng is not installed")
    wav, markup = _speech_paths()
    if not markup.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        for stale in (*CACHE.glob("speech-*.wav"), *CACHE.glob("speech-*.json")):  # рецепт поменялся — старое не нужно
            if stale not in (wav, markup):  # а недоделанное другим прогоном с тем же рецептом — не трогаем
                stale.unlink(missing_ok=True)
        audio, words = _build_speech()
        pid = os.getpid()  # два прогона не мешают друг другу; разметка пишется последней и значит «готово»
        partial_wav, partial_json = CACHE / f".speech.{pid}.partial.wav", CACHE / f".speech.{pid}.partial.json"
        try:
            soundfile.write(partial_wav, audio, SPEECH_RATE, subtype="PCM_16")
            body = {"duration": len(audio) / SPEECH_RATE, "words": [{"text": w.text, "t0": w.t0, "t1": w.t1} for w in words]}
            partial_json.write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(partial_wav, wav)
            os.replace(partial_json, markup)
        finally:
            partial_wav.unlink(missing_ok=True)
            partial_json.unlink(missing_ok=True)
    data = json.loads(markup.read_text(encoding="utf-8"))
    return Speech(wav, [Spoken(**w) for w in data["words"]], data["duration"])


@pytest.fixture(scope="session")
def long_speech(speech, tmp_path_factory) -> Speech:
    """Та же речь, повторённая встык до 80+ с (по 8,4 с — 10 раз, 84 с), как одна длинная запись."""
    reps = math.ceil(LONG_SPEECH_SECONDS / speech.duration)
    samples, rate = soundfile.read(speech.wav, dtype="int16")
    wav = tmp_path_factory.mktemp("long-speech") / "speech-long.wav"
    soundfile.write(wav, np.tile(samples, reps), rate, subtype="PCM_16")
    words = [Spoken(w.text, w.t0 + k * speech.duration, w.t1 + k * speech.duration) for k in range(reps) for w in speech.words]
    return Speech(wav, words, reps * speech.duration)
