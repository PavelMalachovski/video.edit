"""Перебивки (B-roll) — свои клипы Павла поверх говорящей головы (дизайн: docs/superpowers/specs/2026-10-25-broll-design.md).

Перебивка — вставка `fullscreen` с полями `from` (с какой секунды клипа), `layout` (`full` — клип на весь кадр; `pip` —
клип на весь кадр, а лицо говорящего окошком в правом верхнем углу) и `audio` (звук клипа тихим фоном). Здесь —
окошко `pip`: где оно на кадре (`PIP`, кадр 1080×1920) и какой кусок кадра с лицом в нём (`face_box`, по точке лица
`edit.face`), маска скруглённых углов (`pip_mask`). Те же числа — у редактора (web/lib/broll.ts), раздел `broll`
общей фикстуры engine/tests/fixtures/overlay-events.json.

Прокси клипа для плеера редактора — `out/broll-<b>.mp4` (`proxy`, его пишет `vm broll`): Action переносит его в черновик
релиза, как прокси исходника, и страница отдаёт его плееру ссылкой на ассет (сам клип лежит там кусками).
"""
import tempfile
from pathlib import Path

from .audio import BROLL_NORM
from .job import Job
from .media import (
    HDR_TO_SDR,
    MediaError,
    _atomic,
    _ffmpeg,
    contact_sheet,
    extract_wav,
    probe,
)

# окошко: правый верхний угол, ниже шапки Reels и выше середины кадра (внизу — субтитры и шкала), 3:4
PIP = {"x": 672, "y": 300, "w": 360, "h": 480, "r": 36}
# клип в окошке (`layout: window`, формат разбора: «разбирали…» — свой прошлый ролик поверх говорящего): слева сверху,
# 3:4, как окошко лица, но меньше — лицо говорящего остаётся открытым
WINDOW = {"x": 60, "y": 300, "w": 300, "h": 400, "r": 28}
# кусок кадра с лицом: тоже 3:4, половина ширины кадра — лицо крупно, но не в упор
FACE = {"w": 540, "h": 720}
FACE_AT = 0.4  # точка лица — на этой доле высоты окошка (глаза выше середины, как в портрете)


def face_box(face: dict, width: int = 1080, height: int = 1920) -> tuple[int, int, int, int]:
    """Кусок кадра `width`×`height` для окошка: (x, y, ширина, высота) — по точке лица (доли кадра), внутри кадра."""
    fx = min(1.0, max(0.0, float(face.get("x", 0.5))))
    fy = min(1.0, max(0.0, float(face.get("y", 0.5))))
    w, h = FACE["w"], FACE["h"]
    x = min(max(0, round(fx * width - w / 2)), width - w)
    y = min(max(0, round(fy * height - h * FACE_AT)), height - h)
    return x, y, w, h


def pip_mask(path: Path, box: dict = PIP) -> Path:
    """Маска окошка `box` (PIP или WINDOW; серая PNG размером окошка): 255 — видно, 0 — скруглённые углы."""
    from PIL import (  # здесь, а не при импорте: render без Pillow нужен e2e страницы
        Image,
        ImageDraw,
    )

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    mask = Image.new("L", (box["w"], box["h"]), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, box["w"] - 1, box["h"] - 1), radius=box["r"], fill=255)
    mask.save(path)
    return path


# ---------- прокси клипа для редактора ----------

PROXY_NAME = "broll-{key}.mp4"  # в out/ задачи; ключ — b<n> из upload-b<n>.<ext>
PROXY = {"width": 540, "height": 960, "key": 0.5, "seconds": 900}  # как прокси исходника; длиннее 15 мин — только начало
PROXY_RATE = 800_000  # бит/с картинки: клип на кадре недолго, 15 мин — до 90 МБ (в git до 95 МБ)


def proxy(path: Path, out: Path, sound: bool) -> Path:
    """Прокси клипа `path`: в кадр PROXY без искажения (чётные стороны), 30 к/с, ключевой кадр каждые PROXY.key с (плеер
    перематывает на `from`), звук — на громкости фона перебивки (BROLL_NORM), как его сведёт рендер."""
    gop = round(PROXY["key"] * 30)
    fit = f"scale={PROXY['width']}:{PROXY['height']}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bicubic"
    with _atomic(Path(out)) as tmp:
        _ffmpeg(
            "-i", path, "-t", PROXY["seconds"], "-map", "0:v:0", *(["-map", "0:a:0"] if sound else []),
            "-vf", f"{fit},fps=30,{_colour(path)}", "-c:v", "libx264", "-preset", "veryfast", "-crf", 30,
            "-maxrate", PROXY_RATE, "-bufsize", 2 * PROXY_RATE, "-g", gop, "-keyint_min", gop, "-sc_threshold", 0,
            *(["-af", f"{BROLL_NORM},aresample=48000", "-c:a", "aac", "-b:a", 64_000, "-ac", 2] if sound else []),
            "-movflags", "+faststart", *(["-shortest"] if sound else []), tmp,
        )
    return Path(out)


def _colour(path: Path) -> str:
    """Цвета прокси — как у клипа в ролике (render._picture): HDR с iPhone — в SDR тем же переводом, остальное — как есть."""
    try:
        hdr = probe(path).hdr
    except MediaError:
        hdr = False
    return HDR_TO_SDR if hdr else "format=yuv420p"


# ---------- vm broll: что за клипы — для Claude (шаг analyze) ----------

SHEET_THUMBS = 12  # кадров на лист клипа: короткий — 2 в секунду, длинный — реже
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def _speech(wav: Path) -> list[tuple[float, float]] | None:
    """Где в звуке клипа речь (Silero VAD); модели VAD нет — None: речь не проверена."""
    from . import asr  # модели и sherpa-onnx — только когда звук есть

    if not asr._model("VAD_MODEL", asr.SILERO).is_file():
        return None
    return asr.speech_spans(wav)


def describe(job: Job) -> list[dict]:
    """Перебивки задачи (`job.json.uploads`, `kind: broll`) по порядку: `{src, name, kind: video|image, seconds,
    width, height, sound, speech, sheet, proxy}`. `sheet` — лист кадров клипа с временем (look/broll-<b>.png, у картинки —
    None, её смотрят саму), `proxy` — прокси видео для редактора (out/broll-<b>.mp4), `speech` — секунд речи в звуке клипа (чужая речь — фон перебивки без звука; звука нет или
    речь не проверить — None)."""
    meta = job.read("job.json") if job.path("job.json").is_file() else {}
    clips = []
    for up in meta.get("uploads") or []:
        if not isinstance(up, dict) or up.get("kind") != "broll":
            continue
        src = str(up.get("file") or "")
        path = job.path(src)
        stem = Path(src).stem.removeprefix("upload-")
        item = {"src": src, "name": str(up.get("name") or path.name), "kind": "image" if path.suffix.lower() in IMAGE_EXT else "video",
                "seconds": None, "width": None, "height": None, "sound": False, "speech": None, "sheet": None, "proxy": None}
        try:
            info = probe(path)
        except (MediaError, OSError):
            item["kind"] = "unreadable"
            clips.append(item)
            continue
        item.update(width=info.width, height=info.height)
        if item["kind"] == "video":
            item.update(seconds=round(info.duration, 2), sound=info.has_audio)
            sheet = job.path(f"look/broll-{stem}.png")
            sheet.parent.mkdir(parents=True, exist_ok=True)
            contact_sheet(path, sheet, fps=min(2.0, SHEET_THUMBS / max(info.duration, 0.1)), cols=4)
            item["sheet"] = f"look/broll-{stem}.png"
            item["proxy"] = f"out/{PROXY_NAME.format(key=stem)}"
            proxy(path, job.path(item["proxy"]), info.has_audio)
            if info.has_audio:
                with tempfile.TemporaryDirectory() as tmp:
                    spans = _speech(extract_wav(path, Path(tmp) / "clip.wav"))
                item["speech"] = None if spans is None else round(sum(b - a for a, b in spans), 1)
        clips.append(item)
    return clips


def summary(clips: list[dict]) -> str:
    """Сводка `vm broll` для Claude: по строке на клип."""
    if not clips:
        return "Перебивок нет (в job.json нет uploads с kind broll)"
    lines = [f"Перебивок: {len(clips)} — лист кадров каждого клипа (время — секунды клипа, для from) в look/:"]
    for c in clips:
        head = f"- {c['src']} («{c['name']}»)"
        if c["kind"] == "unreadable":
            lines.append(f"{head}: не читается — не ставь её")
        elif c["kind"] == "image":
            lines.append(f"{head}: картинка {c['width']}×{c['height']} — открой её саму")
        else:
            sound = ("без звука" if not c["sound"] else "речь не проверена" if c["speech"] is None
                     else f"речь {c['speech']:.1f} с — фон без звука (audio: false)" if c["speech"] >= 0.5 else "звук без речи")
            lines.append(f"{head}: видео {c['seconds']:.1f} с, {c['width']}×{c['height']}, {sound}; {c['sheet']}")
    return "\n".join(lines)
