"""Маска человека для затемнения фона (`edit.dim`, решение Павла 11.10.2026): где человек, а где фон за ним.

Маску даёт RobustVideoMatting (mobilenetv3, ONNX, лицензия GPL-3.0; Lin и др., 2021) через onnxruntime. Это модель для
видео, с памятью между кадрами: край не дрожит. Файл лежит там, куда его кладёт setup/cloud-setup.sh (кэш моделей,
`$VM_CACHE`), или по пути `$MATTE_MODEL`. Кадр уменьшается вдвое (540×960 для 1080×1920): ~85 мс на кадр на 4 ядрах;
маску потом растягивает до кадра `media.dim_filter`.

`write_mattes` — маска на каждый кадр плана (`render.segment_frames`: отрезки финала по порядку, тизер — первым) —
серое видео ffv1 без потерь, кадр в кадр со склейкой. У каждого отрезка память модели начинается с нуля (стык бывает
между разными планами) и разгоняется на `WARMUP` кадрах перед ним — поэтому рендер хранит маски по отрезкам и
склеивает их `join`: готовый отрезок второй раз не считается. `frame_matte` — маска одного кадра (картинка к вопросу,
обложка) с тем же разгоном.

`predict` — подмена модели в тестах: `(кадр RGB uint8 H×W×3, память или None) → (маска uint8 H×W, память)`.
"""
import math
import os
import subprocess
from collections.abc import Callable, Iterator
from functools import cache
from pathlib import Path

import numpy as np
from PIL import Image

from .media import FPS, probe

MODEL = "rvm_mobilenetv3_fp32.onnx"
WARMUP = 8  # кадров перед отрезком: память модели успевает сойтись (0,27 с)
RATIO = 0.5  # downsample_ratio модели для кадра 540×960 (совет авторов: 0,4–0,5 для HD и меньше)

Predict = Callable[[np.ndarray, object], tuple[np.ndarray, object]]


def model_path() -> Path:
    """Файл модели: `$MATTE_MODEL`, иначе кэш моделей setup/cloud-setup.sh."""
    cache_dir = Path(os.environ.get("VM_CACHE") or "~/.cache/vm")
    return Path(os.environ.get("MATTE_MODEL") or cache_dir / MODEL).expanduser()


def unavailable() -> str | None:
    """Почему маску не посчитать (по-русски, для Павла), или None — можно."""
    try:
        import onnxruntime  # noqa: F401 — тяжёлый импорт, только проверка
    except ImportError:
        return "нет onnxruntime (setup/cloud-setup.sh)"
    if not model_path().is_file():
        return f"нет модели {MODEL} (setup/cloud-setup.sh)"
    return None


@cache
def _session(path: str):
    import onnxruntime as ort

    return ort.InferenceSession(path, providers=["CPUExecutionProvider"])


def _rvm() -> Predict:
    session = _session(str(model_path()))
    ratio = np.array([RATIO], np.float32)

    def predict(rgb: np.ndarray, state: object) -> tuple[np.ndarray, object]:
        rec = state or [np.zeros((1, 1, 1, 1), np.float32)] * 4
        src = (rgb.astype(np.float32) / 255).transpose(2, 0, 1)[None]
        _, pha, *rec = session.run(
            None, {"src": src, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio}
        )
        return (np.clip(pha[0, 0], 0, 1) * 255 + 0.5).astype(np.uint8), rec

    return predict


def matte_size(width: int, height: int) -> tuple[int, int]:
    """Размер маски: вдвое меньше кадра, чётный."""
    return max(2, width // 4 * 2), max(2, height // 4 * 2)


def _frames(source: Path, first: int, count: int, size: tuple[int, int]) -> Iterator[np.ndarray]:
    """`count` кадров исходника с номера `first` (RGB, размер `size`). Начало — посередине перед кадром: кадр
    `first` (его время `first`/30) берётся, предыдущий — нет, как `trim=start_frame` склейки."""
    w, h = size
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{max(0.0, (first - 0.5) / FPS):.6f}", "-i", str(source),
         "-frames:v", str(count), "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE,
    )
    frame = w * h * 3
    try:
        while len(buf := proc.stdout.read(frame)) == frame:
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        proc.wait()


def write_mattes(source: Path, plan: list[tuple[int, int]], out: Path, predict: Predict | None = None) -> Path:
    """Маска на каждый кадр плана `[(первый, после последнего), ...]` по порядку → `out` (серое видео ffv1, 30 к/с,
    вдвое меньше кадра). Кадров в исходнике не хватило — маска добивается пустой (фон), чтобы шла кадр в кадр."""
    predict = predict or _rvm()
    info = probe(source)
    w, h = matte_size(info.width, info.height)
    out = Path(out)
    part = out.with_name(f".{out.stem}.part{out.suffix}")
    writer = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{w}x{h}",
         "-r", str(FPS), "-i", "-", "-c:v", "ffv1", str(part)],
        stdin=subprocess.PIPE,
    )
    empty = np.zeros((h, w), np.uint8)
    try:
        for f0, f1 in plan:
            start, state, written = max(0, f0 - WARMUP), None, 0
            for i, rgb in enumerate(_frames(source, start, f1 - start, (w, h))):
                mask, state = predict(rgb, state)
                if start + i >= f0:
                    writer.stdin.write(mask.tobytes())
                    written += 1
            for _ in range(f1 - f0 - written):
                writer.stdin.write(empty.tobytes())
    finally:
        writer.stdin.close()
        code = writer.wait()
    if code != 0:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"маска затемнения фона не записалась (ffmpeg, код {code})")
    os.replace(part, out)
    return out


def join(parts: list[Path], out: Path) -> Path:
    """Маски отрезков подряд → одно видео `out` (ffv1, 30 к/с): время кадров заново по их номеру — кадр в кадр со
    склейкой, как бы ни округлил время контейнер кусков."""
    out = Path(out)
    listing = out.with_name(f".{out.stem}.ffconcat")
    listing.write_text("ffconcat version 1.0\n" + "".join(f"file '{p.resolve()}'\n" for p in parts), encoding="utf-8")
    part = out.with_name(f".{out.stem}.part{out.suffix}")
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
             "-vf", f"setpts=N/{FPS}/TB", "-r", str(FPS), "-c:v", "ffv1", str(part)],
            check=True, capture_output=True, timeout=600,
        )
    except subprocess.CalledProcessError as err:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"маска затемнения фона не склеилась: {err.stderr.decode(errors='replace')[-300:]}") from None
    finally:
        listing.unlink(missing_ok=True)
    os.replace(part, out)
    return out


def frame_matte(source: Path, t: float, out: Path, predict: Predict | None = None) -> Path:
    """Маска кадра в момент `t` (первого, что начинается в `t` или сразу после, — как `media.extract_frame`) → `out`
    (серая PNG вдвое меньше кадра). Модель разгоняется на `WARMUP` кадрах перед ним."""
    predict = predict or _rvm()
    info = probe(source)
    size = matte_size(info.width, info.height)
    n = math.ceil(t * FPS - 1e-6)
    start, state, mask = max(0, n - WARMUP), None, None
    for rgb in _frames(source, start, n - start + 1, size):
        mask, state = predict(rgb, state)
    if mask is None:
        raise RuntimeError(f"нет кадра {t:g} с в {source}")
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(mask).save(out)
    return out
