"""Маска человека для затемнения фона (`edit.dim`, решение Павла 11.10.2026): где человек, а где фон за ним.

Маску даёт RobustVideoMatting (mobilenetv3, ONNX, лицензия GPL-3.0; Lin и др., 2021) через onnxruntime. Это модель для
видео, с памятью между кадрами: край не дрожит. Файл лежит там, куда его кладёт setup/cloud-setup.sh (кэш моделей,
`$VM_CACHE`), или по пути `$MATTE_MODEL`. Кадр уменьшается вдвое (540×960 для 1080×1920): ~85 мс на кадр на 4 ядрах;
маску потом растягивает до кадра `media.dim_filter`.

`write_mattes` — маска на каждый кадр плана (`render.segment_frames`: отрезки финала по порядку, тизер — первым) —
серое видео ffv1 без потерь, кадр в кадр со склейкой. У каждого отрезка память модели начинается с нуля (стык бывает
между разными планами) и разгоняется на `WARMUP` кадрах перед ним — поэтому рендер хранит маски по отрезкам и
склеивает их `join`: готовый отрезок второй раз не считается — и в следующей сессии (правка): рендер, что посчитал
новое, кладёт маску плана в out/ (`keep`, уходит в черновик), `vm fetch` приносит её назад, `restore` берёт из неё
готовые отрезки (ключ — `job_key`). Отрезки считают `WORKERS` потоков (`write_parts`), у
каждого своя сессия onnxruntime на свою долю ядер: на 4 ядрах 51 мс на кадр против 75 у одной сессии на все ядра
(маленькая сеть плохо делится по ядрам). Длинный отрезок на куски не делится: память модели и после разгона уводит
маску в своё (на настоящем ролике у шва 4 % кадра расходились на 16+ уровней и через секунду) — внутри плана это был
бы скачок затемнения. `frame_matte` — маска одного кадра (картинка к вопросу, обложка) с тем же разгоном.

`predict` — подмена модели в тестах: `(кадр RGB uint8 H×W×3, память или None) → (маска uint8 H×W, память)`.
"""
import hashlib
import json
import math
import os
import select
import subprocess
import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from pathlib import Path

import numpy as np

from . import source as ready_source
from .job import Job
from .media import FPS, probe

MODEL = "rvm_mobilenetv3_fp32.onnx"
WARMUP = 8  # кадров перед отрезком: память модели успевает сойтись (0,27 с)
RATIO = 0.5  # downsample_ratio модели для кадра 540×960 (совет авторов: 0,4–0,5 для HD и меньше)
WORKERS = 4  # потоков маски (не больше ядер и отрезков): на 4 ядрах рутины 51 мс на кадр против 75 у одной сессии
STRIDE = 2  # модель видит каждый второй кадр отрезка (и последний); маска между ними — среднее соседних
STALL = 120  # с — столько декодер кадров может молчать; дольше — завис (битый исходник), он останавливается

Predict = Callable[[np.ndarray, object], tuple[np.ndarray, object]]


def model_path() -> Path:
    """Файл модели: `$MATTE_MODEL`, иначе кэш моделей setup/cloud-setup.sh."""
    cache_dir = Path(os.environ.get("VM_CACHE") or "~/.cache/vm")
    return Path(os.environ.get("MATTE_MODEL") or cache_dir / MODEL).expanduser()


def unavailable() -> str | None:
    """Почему маску не посчитать (по-русски, для Павла), или None — можно. Модель пробно открывается: битый файл —
    причина, а не исключение посреди рендера."""
    try:
        import onnxruntime  # noqa: F401 — тяжёлый импорт, только проверка
    except ImportError:
        return "нет onnxruntime (setup/cloud-setup.sh)"
    path = model_path()
    if not path.is_file():
        return f"нет модели {MODEL} (setup/cloud-setup.sh)"
    try:
        _session(str(path))
    except Exception as err:  # noqa: BLE001 — onnxruntime бросает свои исключения (InvalidProtobuf и др.)
        return f"модель {path.name} не открывается ({str(err)[:120]})"
    return None


@cache
def _session(path: str):
    import onnxruntime as ort

    return ort.InferenceSession(path, providers=["CPUExecutionProvider"])


def _own_session(path: str, threads: int):
    """Своя сессия потока маски: `threads` ядер на вычисления, без своих потоков между узлами сети."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    return ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])


def _rvm(threads: int | None = None) -> Predict:
    """Модель: `threads` — своя сессия на столько ядер (поток `write_parts`), None — общая на все ядра."""
    session = _session(str(model_path())) if threads is None else _own_session(str(model_path()), threads)
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


def _decoder(source: Path, first: int, count: int, size: tuple[int, int]) -> list[str]:
    """ffmpeg, что отдаёт кадры для маски сырым RGB в stdout (подменяется в тестах)."""
    w, h = size
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{max(0.0, (first - 0.5) / FPS):.6f}",
            "-i", str(source), "-an", "-frames:v", str(count), "-vf", f"scale={w}:{h}", "-fps_mode", "passthrough",
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]


def _read(fd: int, size: int, proc: subprocess.Popen) -> bytes:
    """Ровно `size` байт из трубы (меньше — кадры кончились). Молчит дольше STALL с — процесс остановлен, RuntimeError:
    рендер узнаёт о зависшем декодере, а не ждёт вечно."""
    chunks, got = [], 0
    while got < size:
        if not select.select([fd], [], [], STALL)[0]:
            proc.kill()
            raise RuntimeError(f"декодер кадров для маски молчит {STALL:g} с — остановлен")
        chunk = os.read(fd, min(size - got, 1 << 20))
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def _frames(source: Path, first: int, count: int, size: tuple[int, int]) -> Iterator[np.ndarray]:
    """`count` кадров исходника с номера `first` (RGB, размер `size`). Начало — посередине перед кадром: кадр
    `first` (его время `first`/30) берётся, предыдущий — нет, как `trim=start_frame` склейки. Кадры — как есть, без
    добивки: со звуком AAC (как в source.mp4) перемотка давала видео начало чуть позже нуля, и выход с постоянной
    частотой повторял первый кадр — маска отставала на кадр."""
    w, h = size
    proc = subprocess.Popen(_decoder(source, first, count, size), stdout=subprocess.PIPE, bufsize=0)
    frame = w * h * 3
    try:
        while len(buf := _read(proc.stdout.fileno(), frame, proc)) == frame:
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        proc.stdout.close()
        if proc.poll() is None:  # кадров хватило раньше конца или ошибка выше — декодер дальше не нужен
            proc.kill()
        proc.wait()


def write_mattes(source: Path, plan: list[tuple[int, int]], out: Path, predict: Predict | None = None) -> Path:
    """Маска на каждый кадр плана `[(первый, после последнего), ...]` по порядку → `out` (серое видео ffv1, 30 к/с,
    вдвое меньше кадра). Кадров в исходнике не хватило — маска добивается пустой (фон), чтобы шла кадр в кадр.

    Разгон — все `WARMUP` кадров подряд; дальше модель видит каждый `STRIDE`-й кадр отрезка и его последний, маска
    кадра между ними — среднее соседних: вдвое быстрее, а на настоящем ролике отличие от полной — у 0,8 % точек больше
    16 уровней из 255 (края на движении; при затемнении на 30 % — меньше 2 % яркости)."""
    predict = predict or _rvm()
    info = probe(source)
    w, h = matte_size(info.width, info.height)
    out = Path(out)
    part = out.with_name(f".{out.stem}.part{out.suffix}")
    writer = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "gray",
         "-s", f"{w}x{h}", "-r", str(FPS), "-i", "-", "-c:v", "ffv1", str(part)],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    empty = np.zeros((h, w), np.uint8)
    try:
        for f0, f1 in plan:
            start, state, written = max(0, f0 - WARMUP), None, 0
            last, skipped = None, 0  # последняя посчитанная маска и сколько кадров после неё ждут следующую
            for i, rgb in enumerate(_frames(source, start, f1 - start, (w, h))):
                n = start + i
                if n >= f0 and (n - f0) % STRIDE and n != f1 - 1:
                    skipped += 1
                    continue
                mask, state = predict(rgb, state)
                if n < f0:
                    continue
                for k in range(1, skipped + 1):  # между двумя посчитанными — по прямой
                    between = (last.astype(np.uint16) * (skipped + 1 - k) + mask.astype(np.uint16) * k + (skipped + 1) // 2) // (skipped + 1)
                    writer.stdin.write(between.astype(np.uint8).tobytes())
                writer.stdin.write(mask.tobytes())
                written += skipped + 1
                last, skipped = mask, 0
            for _ in range(skipped):  # кадры кончились раньше отрезка: пропущенные — как последняя маска
                writer.stdin.write(last.tobytes())
            written += skipped
            for _ in range(f1 - f0 - written):
                writer.stdin.write(empty.tobytes())
        writer.stdin.close()
    except BrokenPipeError:  # ffmpeg-писатель умер — причина в его выводе ниже
        pass
    finally:
        if not writer.stdin.closed:
            try:
                writer.stdin.close()
            except BrokenPipeError:
                pass
        code = writer.wait()
    if code != 0:
        part.unlink(missing_ok=True)
        err = writer.stderr.read().decode(errors="replace")[-300:]
        raise RuntimeError(f"маска затемнения фона не записалась (ffmpeg, код {code}): {err}")
    os.replace(part, out)
    return out


def write_parts(source: Path, jobs: list[tuple[tuple[int, int], Path]], workers: int | None = None,
                models: Callable[[int], Predict] | None = None) -> None:
    """Маски отрезков `[((первый, после последнего), файл), ...]` — каждая в свой файл (как `write_mattes` с одним
    отрезком), в `workers` потоков (по умолчанию `WORKERS`, не больше ядер и отрезков). У каждого потока — своя модель
    `models(ядер на поток)` (по умолчанию — своя сессия onnxruntime). Сбой одного отрезка — остальные потоки не берут
    новых, ошибка — наружу; готовые файлы остаются (их возьмёт следующий рендер)."""
    if not jobs:
        return
    models = models or _rvm
    cores = os.cpu_count() or 1
    workers = max(1, min(workers or WORKERS, cores, len(jobs)))
    threads = max(1, cores // workers)
    queue = iter(jobs)
    lock = threading.Lock()
    failed = threading.Event()

    def work() -> None:
        predict = models(threads)
        while not failed.is_set():
            with lock:
                job = next(queue, None)
            if job is None:
                return
            (f0, f1), part = job
            try:
                write_mattes(source, [(f0, f1)], part, predict=predict)
            except BaseException:
                failed.set()
                raise

    with ThreadPoolExecutor(workers, thread_name_prefix="matte") as pool:
        futures = [pool.submit(work) for _ in range(workers)]
    for future in futures:
        future.result()


def join(parts: list[Path], out: Path) -> Path:
    """Маски отрезков подряд → одно видео `out` (ffv1, 30 к/с): время кадров заново по их номеру — кадр в кадр со
    склейкой, как бы ни округлил время контейнер кусков."""
    out = Path(out)
    listing = out.with_name(f".{out.stem}.ffconcat")
    listing.write_text("ffconcat version 1.0\n" + "".join(f"file '{p.resolve()}'\n" for p in parts), encoding="utf-8")
    part = out.with_name(f".{out.stem}.part{out.suffix}")
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i",
             str(listing), "-vf", f"setpts=N/{FPS}/TB", "-r", str(FPS), "-c:v", "ffv1", str(part)],
            check=True, capture_output=True, timeout=600,
        )
    except subprocess.SubprocessError as err:  # и ошибка ffmpeg, и TimeoutExpired
        part.unlink(missing_ok=True)
        detail = (getattr(err, "stderr", None) or b"").decode(errors="replace")[-300:] or str(err)
        raise RuntimeError(f"маска затемнения фона не склеилась: {detail}") from None
    finally:
        listing.unlink(missing_ok=True)
    os.replace(part, out)
    return out


def cache_key(source: str) -> str:
    """Ключ маски: исходник (ключ его входов — `source.key`) и всё, от чего зависит маска."""
    return hashlib.sha1(json.dumps([source, MODEL, WARMUP, RATIO, STRIDE]).encode()).hexdigest()[:12]


def job_key(job: Job) -> str:
    """Ключ маски задачи: по входам исходника из job.json — тот же в каждой сессии, хоть исходник скачан готовым, хоть
    нормализован заново (маска прошлой сессии подходит); без job.json — по размеру и времени файла (только эта сессия)."""
    if job.path("job.json").is_file():
        return cache_key(ready_source.key(job))
    stat = job.path("source.mp4").stat()
    return cache_key(f"{stat.st_size}-{stat.st_mtime_ns}")


def keep(parts: list[Path], plan: list[tuple[int, int]], out: Path) -> None:
    """Маски отрезков `plan` (файлы `parts`) подряд → `out`.mkv (серое H.264, crf 12, без B-кадров: маска плавная — в
    разы легче ffv1, расхождение — уровень-другой из 255) и `out`.json с отрезками по порядку. Их уносит в черновик
    Action (out/), следующая сессия берёт оттуда готовые отрезки (`restore`)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    listing = out.with_name(f".{out.name}.ffconcat")
    listing.write_text("ffconcat version 1.0\n" + "".join(f"file '{p.resolve()}'\n" for p in parts), encoding="utf-8")
    video, part = out.with_suffix(".mkv"), out.with_name(f".{out.name}.part.mkv")
    try:
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
             "-vf", f"setpts=N/{FPS}/TB", "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-bf", "0",
             "-pix_fmt", "gray", "-color_range", "pc", str(part)],  # полный диапазон: иначе при чтении 16..235 растянут
            check=True, capture_output=True, timeout=600,
        )
        os.replace(part, video)
    finally:
        listing.unlink(missing_ok=True)
        part.unlink(missing_ok=True)
    out.with_suffix(".json").write_text(json.dumps({"plan": [list(unit) for unit in plan]}), encoding="utf-8")


def _frames_in(path: Path) -> int:
    """Сколько кадров в видео (по пакетам: у ffv1 и H.264 без B-кадров — по кадру в пакете)."""
    done = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries",
                           "stream=nb_read_packets", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=False)
    try:
        return int(done.stdout.strip().split(",")[0])
    except ValueError:
        return -1


def restore(cache: Path, wanted: list[tuple[tuple[int, int], Path]]) -> None:
    """Отрезки из маски прошлой сессии (`cache`.json — её отрезки по порядку, `cache`.mkv — их маски подряд; `keep`):
    каждый нужный отрезок, что целиком внутри одного из них, — его кадры в свой файл (ffv1), как от `write_mattes`.
    Кэша нет, он битый или короче описания — ничего не берётся (маску посчитают). Каждый отрезок — переходом к
    ключевому кадру перед ним (раз в 2 с), а не чтением с начала: 36 отрезков минуты — 2 с, а не 20."""
    try:
        plan = [(int(a), int(b)) for a, b in json.loads(cache.with_suffix(".json").read_text(encoding="utf-8"))["plan"]]
    except (OSError, ValueError, KeyError, TypeError):
        return
    video = cache.with_suffix(".mkv")
    if not wanted or not video.is_file() or _frames_in(video) != sum(b - a for a, b in plan):
        return
    starts = [0]
    for a, b in plan:
        starts.append(starts[-1] + b - a)
    found = []
    for (f0, f1), part in wanted:
        hit = next((start + f0 - c0 for (c0, c1), start in zip(plan, starts, strict=False) if c0 <= f0 and f1 <= c1), None)
        if hit is not None:
            found.append((hit, f1 - f0, part))

    def cut(hit: int, count: int, part: Path) -> None:
        tmp = part.with_name(f".{part.stem}.part{part.suffix}")
        done = subprocess.run(
            # время кадра в контейнере — в мс: переход на полкадра раньше нужного берёт ровно его
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", f"{max(0.0, (hit - 0.5) / FPS):.6f}",
             "-i", str(video), "-frames:v", str(count),
             # помечен как посчитанные (диапазон не указан): иначе склейка с ними пометила бы всю маску по первому
             "-vf", f"setpts=N/{FPS}/TB,format=gray,setparams=range=unknown", "-r", str(FPS), "-c:v", "ffv1", str(tmp)],
            capture_output=True, check=False, timeout=600,
        )
        if done.returncode == 0 and _frames_in(tmp) == count:
            os.replace(tmp, part)
        else:
            tmp.unlink(missing_ok=True)

    with ThreadPoolExecutor(WORKERS) as pool:
        list(pool.map(lambda unit: cut(*unit), found))


def frame_matte(source: Path, t: float, out: Path, predict: Predict | None = None) -> Path:
    """Маска кадра в момент `t` → `out` (серая PNG вдвое меньше кадра): того же кадра, что берёт `media.extract_frame`
    (`-ss` с точностью до мс — первый кадр не раньше этого времени). Модель разгоняется на `WARMUP` кадрах перед ним."""
    predict = predict or _rvm()
    info = probe(source)
    size = matte_size(info.width, info.height)
    n = math.ceil(float(f"{t:.3f}") * FPS - 1e-6)
    start, state, mask = max(0, n - WARMUP), None, None
    for rgb in _frames(source, start, n - start + 1, size):
        mask, state = predict(rgb, state)
    if mask is None:
        raise RuntimeError(f"нет кадра {t:g} с в {source}")
    # Pillow — только для картинки маски: остальным командам vm он не нужен
    from PIL import Image

    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(mask).save(out)
    return out
