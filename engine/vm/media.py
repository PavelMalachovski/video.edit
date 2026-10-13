"""Медиа: ffprobe, нормализация исходника (поворот, HDR → SDR, склейка частей), смены сцены, звук и кадры.

Всё делает ffmpeg; здесь — команды, разбор ответа ffprobe и понятные ошибки. Результаты пишутся через
временный файл рядом: готовый файл появляется целиком или не появляется вовсе. Подписи на кадрах (время)
рисует drawtext — шрифт берёт системный, через fontconfig.
"""
import json
import math
import os
import re
import struct
import subprocess
import tempfile
from collections.abc import Iterable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

PathLike = str | os.PathLike  # пути принимаем и строкой, и Path
WIDTH, HEIGHT = 1080, 1920  # вертикальный кадр
FPS = 30
AUDIO_RATE = 48000
HDR_TRANSFERS = {"arib-std-b67", "smpte2084"}  # HLG, PQ
# HDR → SDR — решение Плана 1 (docs/spikes/2026-10-results.md): прямой перевод цветов без tone mapping
HDR_TO_SDR = "zscale=t=bt709:m=bt709:p=bt709:r=tv:npl=100,format=yuv420p"
BT709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"]
GRID_CELL = (108, 192)  # 10×10 клеток на кадре 1080×1920: по клетке можно назвать, куда указывает палец
THUMB_WIDTH = 180  # колонка контактного листа: 6 колонок — ровно 1080 px
STDERR_LINES = 8  # столько последних строк ffmpeg/ffprobe попадает в сообщение об ошибке
FFMPEG_TIMEOUT = 1800  # с — потолок одного ffmpeg/ffprobe: зависший (битый файл) не держит сессию монтажа вечно
LAST_FRAME_SLACK = 0.001  # на столько t может выйти за конец клипа из-за округления, оставаясь последним кадром
# кадр не 9:16 — по центру на своей размытой копии во весь кадр 1080×1920: так его кладёт финал (render), так же его
# показывают кадры превью и обложка (`vm preview`, `render_cover`)
BLUR = "boxblur=luma_radius=40:luma_power=2:chroma_radius=20:chroma_power=2,eq=brightness=-0.06"
FILL = (f"split=2[fillbg][fillfg];[fillbg]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,crop={WIDTH}:{HEIGHT},"
        f"{BLUR}[fillblur];[fillblur][fillfg]overlay=(W-w)/2:(H-h)/2")
# смена сцены — оценка `scene` ffmpeg (0–1) выше этой: стык разных планов даёт 0,5–1, движение в одном плане — до 0,2
SCENE = 0.35
SCENE_GAP = 0.5  # с — смена ближе к прошлой — та же (вспышка: кадр белого и обратно — одна смена, а не две)
SCENE_WIDTH = 180  # px — оценка по уменьшенному кадру: быстро, а резкий стык виден и так


def cut_frame(t: float) -> int:
    """Кадр финала, с которого видно то, что начинается в момент `t` финала, — так склейку ставят ускорение и `fps=30`
    рендера: по округлению, а ровно посередине кадра — на раньший (замер: ×1,2, стык на 27,5 кадра — кадр 27). На этот
    кадр встают ч/б-куски и резкие смены крупности, чтобы меняться вместе со склейкой."""
    return math.ceil(t * FPS - 0.5 - 1e-6)


class MediaError(RuntimeError):
    """ffmpeg/ffprobe не справился: в сообщении — что это был за вызов и последние строки его вывода."""


class _NoOutput(MediaError):
    """ffmpeg отработал без ошибки, но ничего не записал (так бывает, если t за последним кадром)."""


@dataclass(frozen=True)
class Probe:
    width: int  # уже с учётом поворота: вертикальное видео с iPhone — 1080×1920, а не 1920×1080
    height: int
    rotation: int  # поворот показа из метаданных, градусы против часовой, как отдаёт ffprobe (-180 < r <= 180); 0 — нет
    fps: float  # средняя частота кадров; 0, если неизвестна (картинка)
    duration: float  # длина файла, с; 0 у картинки
    hdr: bool  # HLG/PQ или Dolby Vision
    has_audio: bool
    color_transfer: str | None  # arib-std-b67 (HLG), smpte2084 (PQ), bt709 …; None — не указана


@dataclass(frozen=True)
class _Streams:
    """То, что нужно нормализации сверх Probe."""

    video: int  # номер видеодорожки в файле (обложки-картинки не считаются)
    audio: int | None
    seconds: float  # длина видеодорожки


# ---------- запуск ffmpeg / ffprobe ----------


def _run(cmd: list[str], timeout: float = FFMPEG_TIMEOUT) -> subprocess.CompletedProcess:
    try:
        done = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError:
        raise MediaError(f"{cmd[0]} not found (is ffmpeg installed?)") from None
    except subprocess.TimeoutExpired:  # subprocess.run уже остановил процесс
        raise MediaError(f"{cmd[0]} не уложился в {timeout:.0f} с — остановлен") from None
    if done.returncode != 0:
        tail = "\n".join(done.stderr.strip().splitlines()[-STDERR_LINES:])
        raise MediaError(f"{cmd[0]} failed (exit {done.returncode}): {tail}")
    return done


def _ffmpeg(*args, timeout: float = FFMPEG_TIMEOUT) -> None:
    _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *map(str, args)], timeout=timeout)


@contextmanager
def _atomic(out: Path):
    """Временный файл рядом с результатом (то же расширение — по нему ffmpeg выбирает формат)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.stem}.tmp{out.suffix}")
    try:
        yield tmp
        if not tmp.is_file() or tmp.stat().st_size == 0:
            raise _NoOutput(f"ffmpeg wrote nothing to {out}")
        os.replace(tmp, out)
    finally:
        tmp.unlink(missing_ok=True)


# ---------- probe ----------


def _ffprobe(path) -> dict:
    done = _run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)])
    try:
        return json.loads(done.stdout)
    except json.JSONDecodeError:
        raise MediaError(f"ffprobe returned unreadable output for {path}") from None


def _seconds(value) -> float | None:
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if math.isfinite(seconds) and seconds >= 0 else None


def _fps(stream: dict) -> float:
    for key in ("avg_frame_rate", "r_frame_rate"):
        num, _, den = str(stream.get(key, "")).partition("/")
        try:
            fps = float(num) / float(den or 1)
        except (ValueError, ZeroDivisionError):
            continue
        if fps > 0:
            return fps
    return 0.0


def _rotation(stream: dict) -> int:
    for item in stream.get("side_data_list", []):
        if "rotation" in item:
            degrees = round(float(item["rotation"])) % 360
            return degrees - 360 if degrees > 180 else degrees
    return 0


def _is_hdr(stream: dict) -> bool:
    if stream.get("color_transfer") in HDR_TRANSFERS:
        return True
    kinds = (str(item.get("side_data_type", "")) for item in stream.get("side_data_list", []))
    return any("DOVI" in kind or "Dolby Vision" in kind for kind in kinds)


def _parse(data: dict, path) -> tuple[Probe, _Streams]:
    streams = data.get("streams", [])
    video = next(
        (s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")),
        None,
    )
    if video is None:
        raise MediaError(f"{path}: no video stream")
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    container = _seconds(data.get("format", {}).get("duration"))
    video_seconds = _seconds(video.get("duration"))
    width, height, rotation = int(video.get("width") or 0), int(video.get("height") or 0), _rotation(video)
    if width <= 0 or height <= 0:
        raise MediaError(f"{path}: video stream has no frame size")
    if abs(rotation) == 90:  # кадр лежит боком, показывается повёрнутым
        width, height = height, width
    transfer = video.get("color_transfer")
    probe = Probe(
        width=width,
        height=height,
        rotation=rotation,
        fps=_fps(video),
        duration=container if container is not None else (video_seconds or 0.0),
        hdr=_is_hdr(video),
        has_audio=audio is not None,
        color_transfer=None if transfer in (None, "", "unknown", "unspecified") else transfer,
    )
    seconds = video_seconds if video_seconds is not None else (container or 0.0)
    return probe, _Streams(video["index"], audio["index"] if audio else None, seconds)


def _inspect(path) -> tuple[Probe, _Streams]:
    return _parse(_ffprobe(path), path)


def probe(path: PathLike) -> Probe:
    """Что за видео: размер (с учётом поворота), частота кадров, длина, HDR ли, есть ли звук."""
    return _inspect(path)[0]


# ---------- normalize ----------


def _target_size(first: Probe) -> tuple[int, int]:
    """Кадр результата по первой части: 9:16 и выше — 1080×1920; иначе ширина 1080 и те же пропорции."""
    if first.height * 9 >= first.width * 16:
        return WIDTH, HEIGHT
    return WIDTH, max(2, round(WIDTH * first.height / first.width / 2) * 2)  # чётная высота — для yuv420p


def _video_chain(index: int, hdr: bool, streams: _Streams, size: tuple[int, int]) -> str:
    width, height = size
    steps = [
        "setpts=PTS-STARTPTS",
        # частота и размер — до перевода цветов: HDR-кадры 4K при 60 к/с дороги, а считать их надо уже 1080×1920 при 30
        f"fps={FPS}",
        # вписать в кадр целиком, лишнее место — чёрные поля, растягивать нельзя; у части той же формы, что кадр, полей нет
        f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2",
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
        HDR_TO_SDR if hdr else "format=yuv420p",
        "setsar=1",
    ]
    return f"[{index}:{streams.video}]{','.join(steps)}[v{index}]"


def _audio_chain(index: int, streams: _Streams, frames: int) -> str:
    # звук ровно по длине видео части (padding тишиной или обрезка): стык частей не накапливает рассинхрон
    samples = frames * AUDIO_RATE // FPS
    if streams.audio is None:  # части без звука — тишина: дальше всем нужна звуковая дорожка
        source = f"anullsrc=r={AUDIO_RATE}:cl=stereo"
    else:
        source = (
            f"[{index}:{streams.audio}]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"apad=whole_len={samples}"
        )
    return f"{source},atrim=end_sample={samples},asetpts=PTS-STARTPTS[a{index}]"


VOICE_RATE = 8000  # Гц — длина озвучки считается по отсчётам звука такой частоты: точность 1/8000 с, мало памяти


def voice_seconds(path: PathLike) -> float:
    """Длина записи голоса (озвучки), с — по самому звуку: у сырого AAC (ADTS) ffprobe угадывает её по битрейту и
    ошибается на доли секунды, и конец записи обрезался бы. Звука нет или он не читается — MediaError."""
    if not any(s.get("codec_type") == "audio" for s in _ffprobe(path).get("streams", [])):
        raise MediaError(f"{path}: в записи нет звука")
    try:
        done = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path), "-map", "0:a:0",
                               "-ac", "1", "-ar", str(VOICE_RATE), "-f", "s16le", "-"], capture_output=True, check=False)
    except FileNotFoundError:
        raise MediaError("ffmpeg not found (is ffmpeg installed?)") from None
    seconds = len(done.stdout) / 2 / VOICE_RATE
    if done.returncode != 0 or seconds <= 0:
        tail = "\n".join(done.stderr.decode(errors="replace").strip().splitlines()[-STDERR_LINES:])
        raise MediaError(f"{path}: запись не читается ({tail or 'нет звука'})")
    return seconds


VIDEO = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp", ".hevc"}
SOURCE_PART = re.compile(r"^source(?:-(\d{1,2}))?$")


def source_parts(folder: PathLike) -> list[Path]:
    """Видео исходника по порядку: `source.*`, `source-2.*` … `source-10.*` (так их кладёт fetch: несколько видео
    задачи — номерами; расширение — какое было у файла Павла, любое: ffmpeg узнаёт видео по содержимому), а если таких
    нет — все видео папки по имени."""
    folder = Path(folder)
    files = sorted(p for p in folder.iterdir() if p.is_file()) if folder.is_dir() else []
    numbered = sorted((int(m[1] or 1), p.name, p) for p in files if (m := SOURCE_PART.match(p.stem)))
    return [p for *_, p in numbered] or [p for p in files if p.suffix.lower() in VIDEO]


def part_spans(parts: Sequence[PathLike]) -> list[tuple[float, float]]:
    """Где каждая часть в исходнике, который склеивает `normalize`, с: подряд, по длине части в целых кадрах (столько
    звука `normalize` даёт каждой части)."""
    spans, at = [], 0
    for part in parts:
        frames = max(1, round(_inspect(part)[1].seconds * FPS))
        spans.append((at / FPS, (at + frames) / FPS))
        at += frames
    return spans


def normalize(parts: Sequence[PathLike], out: PathLike, voice: PathLike | None = None) -> Probe:
    """Исходник для всего движка: части подряд в один файл 1080×1920 (или шириной 1080) SDR, 30 к/с, звук 48 кГц.

    Поворот из метаданных применён (ffmpeg поворачивает сам), HDR переведён в SDR BT.709 — только в тех
    частях, где он есть; частота кадров постоянная. Размер кадра задаёт первая часть: вертикальная 9:16 (или
    выше) — 1080×1920, остальные — ширина 1080 с теми же пропорциями (фон-размытие делает `render`). Другие
    части вписываются в этот кадр целиком, поля чёрные. Части без звука получают тишину.
    H.264 crf 16 ultrafast — промежуточный файл (в каждой сессии он делается заново: в git его нет; на 4K HEVC
    с iPhone половина времени — декодирование, ultrafast экономит ещё ~30 % против veryfast), финал кодирует `render`. Метаданные файла (место съёмки и т. п.) не
    переносятся. Возвращает probe результата.

    `voice` — озвучка (своя запись голоса Павла): звук — она, а не звук частей; ролик — длиной в неё: видео короче —
    последний кадр держится до конца записи, длиннее — обрезается.
    """
    parts, out = [Path(p) for p in parts], Path(out)
    if not parts:
        raise ValueError("normalize: no parts to join")
    inspected = [_inspect(part) for part in parts]
    for part, (_, streams) in zip(parts, inspected):
        if streams.seconds <= 0:
            raise MediaError(f"{part}: cannot determine the duration of the video")
    size = _target_size(inspected[0][0])
    chains = []
    for index, (info, streams) in enumerate(inspected):
        chains.append(_video_chain(index, info.hdr, streams, size))
        if voice is None:
            chains.append(_audio_chain(index, streams, max(1, round(streams.seconds * FPS))))
    if voice is None:
        joined = "".join(f"[v{i}][a{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=1[v][a]"
    else:
        frames = max(1, round(voice_seconds(voice) * FPS))
        samples = frames * AUDIO_RATE // FPS
        video = sum(streams.seconds for _, streams in inspected)
        joined = (
            "".join(f"[v{i}]" for i in range(len(parts))) + f"concat=n={len(parts)}:v=1:a=0,"
            # запас стоп-кадра с лишней секундой, потом ровно `frames` кадров: видео той же длины, что озвучка
            f"tpad=stop_mode=clone:stop_duration={max(0.0, frames / FPS - video) + 1:.3f},trim=end_frame={frames},setpts=PTS-STARTPTS[v];"
            f"[{len(parts)}:a:0]aresample={AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,"
            f"apad=whole_len={samples},atrim=end_sample={samples},asetpts=PTS-STARTPTS[a]"
        )
    inputs = [*parts, *([Path(voice)] if voice is not None else [])]
    with _atomic(out) as tmp:
        _ffmpeg(
            *[arg for part in inputs for arg in ("-i", part)],
            "-filter_complex", ";".join([*chains, joined]),
            "-map", "[v]", "-map", "[a]",
            "-map_metadata", "-1", "-map_chapters", "-1",
            "-c:v", "libx264", "-crf", 16, "-preset", "ultrafast", "-pix_fmt", "yuv420p", *BT709,
            "-r", FPS, "-fps_mode", "cfr",
            "-c:a", "aac", "-b:a", "192k", "-ar", AUDIO_RATE, "-ac", 2,
            tmp,
            # 4K HEVC с iPhone — ~1 с на секунду видео на 4 ядрах: потолок — вчетверо, не меньше общего
            timeout=max(FFMPEG_TIMEOUT, 4 * sum(streams.seconds for _, streams in inspected)),
        )  # fmt: skip
    return probe(out)


# ---------- смены сцены ----------


def scene_cuts(src: PathLike, threshold: float = SCENE) -> list[float]:
    """Резкие смены кадра в видео — стыки планов или склеенных частей, с по возрастанию: оценка `scene` ffmpeg (разница
    соседних кадров) выше `threshold`; смена в пределах SCENE_GAP от прошлой — та же."""
    done = _run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(src), "-an", "-vf",
                 f"scale={SCENE_WIDTH}:-2,select='gt(scene,{threshold})',metadata=print:file=-", "-f", "null", "-"])
    cuts: list[float] = []
    for t in (float(x) for x in re.findall(r"pts_time:([\d.]+)", done.stdout)):
        if not cuts or t - cuts[-1] >= SCENE_GAP:
            cuts.append(round(t, 3))
    return cuts


# ---------- контейнер ----------

# коробки-контейнеры MP4, в которые заходим (у stsd, avc1 и mp4a перед детьми — свои поля, их пропускаем)
_MP4_CONTAINERS = {"moov": 0, "trak": 0, "mdia": 0, "minf": 0, "stbl": 0, "edts": 0, "dinf": 0, "udta": 0, "mvex": 0,
                   "stsd": 8, "avc1": 78, "mp4a": 28}


def mp4_boxes(path: PathLike) -> list[str]:
    """Коробки MP4 по порядку, путём от корня: `moov/trak/edts/elst`. Файл не MP4 или обрезан — MediaError. Читаются
    только заголовки коробок (mdat в сотни мегабайт пропускается, в память не грузится)."""
    out: list[str] = []
    with Path(path).open("rb") as f:
        total = f.seek(0, 2)

        def read(off: int, n: int) -> bytes:
            f.seek(off)
            return f.read(n)

        def walk(off: int, end: int, parent: str) -> None:
            while off < end:
                if end - off < 8:
                    raise MediaError(f"{path}: не MP4 — обрывок коробки на {off}")
                size, kind = struct.unpack(">I4s", read(off, 8))
                head = 8
                if size == 1:
                    if end - off < 16:
                        raise MediaError(f"{path}: не MP4 — обрывок коробки на {off}")
                    size, head = struct.unpack(">Q", read(off + 8, 8))[0], 16
                elif size == 0:
                    size = end - off
                name = kind.decode("latin-1")
                if size < head or off + size > end:
                    raise MediaError(f"{path}: не MP4 — коробка {name!r} на {off} длиной {size} выходит за границу")
                here = f"{parent}/{name}" if parent else name
                out.append(here)
                if name in _MP4_CONTAINERS:
                    walk(off + head + _MP4_CONTAINERS[name], off + size, here)
                off += size

        walk(0, total, "")
    return out


# ---------- звук и кадры ----------


def loudness(src: PathLike) -> float | None:
    """Интегральная громкость первой звуковой дорожки, LUFS (EBU R128, как у loudnorm); звука нет — None."""
    try:
        err = _run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(src), "-map", "0:a:0",
                    "-af", "ebur128=framelog=quiet", "-f", "null", "-"]).stderr
    except MediaError:
        return None
    found = re.findall(r"I:\s+(-?[\d.]+|-inf) LUFS", err)
    if not found:
        return None
    return float(found[-1]) if found[-1] != "-inf" else -math.inf


def extract_wav(src: PathLike, out: PathLike, rate: int = 16000) -> Path:
    """Звук для распознавания: моно, PCM 16 бит, rate Гц."""
    out = Path(out)
    with _atomic(out) as tmp:
        _ffmpeg("-i", src, "-map", "0:a:0", "-ac", 1, "-ar", rate, "-c:a", "pcm_s16le", tmp)
    return out


def _check_time(t) -> float:
    t = float(t)
    if not math.isfinite(t) or t < 0:
        raise ValueError(f"time must be a finite number >= 0, got {t}")
    return t


def _frame(src, t: float, out: Path, vf: str | None = None) -> Path:
    """Кадр в момент t: первый, что начинается в t или сразу после (расхождение — не больше кадра)."""
    filters = ["-vf", vf] if vf else []
    try:
        with _atomic(out) as tmp:
            _ffmpeg("-ss", f"{t:.3f}", "-i", src, *filters, "-frames:v", 1, tmp)
    except _NoOutput:
        # t попало в последний кадр: он начался раньше t, поэтому -ss его пропустил, а после него кадров нет
        seconds = _inspect(src)[1].seconds
        if t > seconds + LAST_FRAME_SLACK:
            raise MediaError(f"no frame at t={t:g}s: {src} is only {seconds:g}s long") from None
        with _atomic(out) as tmp:
            _ffmpeg("-sseof", -0.5, "-i", src, *filters, "-update", 1, tmp)  # последний кадр затирает предыдущие
    return out


# время кадра — по его номеру, в мкс: так его считают и маска, и склейка перед maskedmerge — пары совпадают до единицы
# (в мс контейнера маски 1/30 с не записать, а после concat время «дрожит» на тысячные кадра)
FRAME_TIME = f"settb=AVTB,setpts=N/{FPS}/TB"


def dim_filter(video: str, mask: str, amount: float, width: int, height: int, out: str) -> str:
    """Граф ffmpeg затемнения фона: где маска 0 (фон) — яркость и цвет × (1 − `amount`), где 255 (человек) — кадр как
    был, между ними — смесь. Всё в YUV 4:2:0 исходника (диапазон tv): без перевода в RGB и обратно цвет человека не
    сдвигается. `video` и `mask` — метки входов (`[0:v]`), `mask` — серая маска любого размера: растягивается до
    `width`×`height`; выход — метка `out`. Внутренние метки начинаются с `dim`."""
    k = f"{1 - amount:.4f}"
    cw, ch = (width + 1) // 2, (height + 1) // 2
    return (
        f"{mask}{FRAME_TIME},format=gray,split=3[dimy0][dimu0][dimv0];[dimy0]scale={width}:{height}:flags=bicubic[dimy];"
        f"[dimu0]scale={cw}:{ch}:flags=bicubic[dimu];[dimv0]scale={cw}:{ch}:flags=bicubic[dimv];"
        f"[dimy][dimu][dimv]mergeplanes=0x001020:yuv420p[dimmask];"
        f"{video}format=yuv420p,split[dima][dimb];"
        f"[dima]lutyuv=y='16+(val-16)*{k}':u='128+(val-128)*{k}':v='128+(val-128)*{k}'[dimd];"
        f"[dimd][dimb][dimmask]maskedmerge{out}"
    )


def extract_frame(src: PathLike, t: float, out: PathLike, mark: tuple[int, int, int, int] | None = None,
                  fill: bool = False, mask: PathLike | None = None, dim: float = 0.0) -> Path:
    """Кадр видео в момент t, секунд (PNG или JPEG — по расширению out). `fill` — кадр как в ролике: не 9:16 — по
    центру на размытой копии (FILL), 1080×1920. `mark` — (x, y, w, h) в px кадра: жёлтая рамка 8 px, например место
    будущей вставки на картинке к вопросу. `mask` и `dim` — фон темнее на долю `dim` по маске человека этого кадра
    (`matte.frame_matte`), как в ролике с `edit.dim`."""
    steps = []
    info = probe(src) if fill or mask else None
    if fill and (info.width, info.height) != (WIDTH, HEIGHT):
        steps.append(FILL)
    if mark:
        x, y, w, h = mark
        steps.append(f"drawbox=x={x}:y={y}:w={w}:h={h}:color=0xFFD23F@1:t=8")
    if not (mask and dim > 0):
        return _frame(src, _check_time(t), Path(out), ",".join(steps) or None)
    graph = dim_filter("[0:v]", "[1:v]", dim, info.width, info.height, "[dimout]")
    graph += ";[dimout]" + (",".join(steps) or "null") + "[frame]"
    with _atomic(Path(out)) as tmp:
        _ffmpeg("-ss", f"{_check_time(t):.3f}", "-i", src, "-i", mask, "-filter_complex", graph, "-map", "[frame]",
                "-frames:v", 1, tmp)
    return Path(out)


def _grid_filter(t: float) -> str:
    cell_w, cell_h = GRID_CELL
    return (
        # тёмная подложка под светлой линией: сетка видна и на светлом кадре, и на тёмном
        f"drawgrid=w={cell_w}:h={cell_h}:t=4:c=black@0.45,drawgrid=w={cell_w}:h={cell_h}:t=2:c=white@0.85,"
        f"drawtext=text='{t:.2f}s':x=14:y=14:fontsize=56:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10"
    )


def grid_frames(src: PathLike, times: Iterable[float], out_dir: PathLike) -> list[Path]:
    """Кадры в моменты times с сеткой 108×192 (10×10 клеток на 1080×1920) и подписью времени — `grid_<t>.png`."""
    times = [_check_time(t) for t in times]
    out_dir = Path(out_dir)
    return [_frame(src, t, out_dir / f"grid_{t:08.3f}.png", _grid_filter(t)) for t in times]


def contact_sheet(src: PathLike, out: PathLike, fps: float = 1, cols: int = 6) -> Path:
    """Контактный лист: кадры раз в 1/fps секунды, по cols в ряд, у каждого в углу — время в секундах."""
    if not fps > 0 or cols < 1:
        raise ValueError(f"contact_sheet needs fps > 0 and cols >= 1, got fps={fps}, cols={cols}")
    out = Path(out)
    # подпись — время кадра, секунды с десятой; целая и дробная часть считаются от одного округления,
    # иначе 12,96 вышло бы «12.10»
    label = r"%{eif\:floor(round(t*10)/10)\:d}.%{eif\:mod(round(t*10)\,10)\:d}"
    # select, а не fps: фильтр fps на коротком клипе при редком шаге не отдаёт ни одного кадра
    thumbs = (
        f"select='gte(t,selected_n/{fps})',scale={THUMB_WIDTH}:-2,"
        f"drawtext=text='{label}':x=6:y=6:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4"
    )
    with tempfile.TemporaryDirectory() as tmp:
        _ffmpeg("-i", src, "-vf", thumbs, "-fps_mode", "vfr", f"{tmp}/%05d.png")
        rows = math.ceil(len(os.listdir(tmp)) / cols)  # число рядов известно точно: сначала кадры, потом лист
        with _atomic(out) as sheet:
            _ffmpeg("-framerate", 1, "-i", f"{tmp}/%05d.png", "-vf", f"tile={cols}x{rows}", "-frames:v", 1, sheet)
    return out
