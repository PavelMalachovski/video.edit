"""Фикстуры движка: короткие клипы, которые ffmpeg рисует сам (lavfi), без файлов в репозитории.

Каждый клип собирается один раз и лежит в engine/tests/.cache/ (в .gitignore). В имени файла —
хэш команд: поправил команду — получил новый клип, а не устаревший из кэша. Клипы нарочно
«рукотворные» (однотонные кадры, тоны, маркер в углу), чтобы в тестах ожидаемое значение
выводилось из построения клипа, а не из проверяемого кода.
"""
import hashlib
import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import pytest

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
