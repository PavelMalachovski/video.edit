"""Проверка качества перед тем, как отдать ролик.

`check_layout` — геометрия слоя по boxes.json (рамки элементов по промежуткам, их пишет render-frames.mjs):
всё внутри безопасной зоны X 60–890 / Y 120–1530 (шкала и полноэкранные перебивки в boxes не попадают), вставки
и титры не ближе 40 px к лицу, вставки не ближе 20 px к субтитрам, тексты не пересекаются. Субтитры с лицом не
сверяются: их высоту задаёт выбранный стиль. `check_render` — «не отдавать»: формат, длительность, хук и титр из
edit.json есть в ролике, музыка (если выбрана) звучит с первого кадра. `control_frames` — контрольные кадры и лист 2×2.
"""
import re
import subprocess
from pathlib import Path

from .media import extract_frame, probe
from .render import timeline

SAFE = {"x0": 60, "x1": 890, "y0": 120, "y1": 1530}
FACE_GAP = 40
SUB_GAP = 20
FACE_W, FACE_H = 0.30, 0.22  # рамка лица по умолчанию, доли кадра: Claude надёжно даёт только точку
W, H = 1080, 1920
SLOTS = ("hook", "subs", "insert", "cta")  # порядок клеток листа: слева направо, сверху вниз
NAMES = {"sub": "субтитры", "hook": "хук", "cta": "титр"}


def face_box(face: dict | None) -> dict | None:
    """Рамка лица в px кадра по `edit.face` (доли): центр x, y; без w/h — 0,30 × 0,22 кадра."""
    if not face:
        return None
    w = round(W * face.get("w", FACE_W))
    h = round(H * face.get("h", FACE_H))
    return {"x": round(W * face["x"] - w / 2), "y": round(H * face["y"] - h / 2), "w": w, "h": h}


def _gap(a: dict, b: dict) -> float:
    """Расстояние между рамками (0 — касаются или пересекаются)."""
    dx = max(b["x"] - (a["x"] + a["w"]), a["x"] - (b["x"] + b["w"]), 0)
    dy = max(b["y"] - (a["y"] + a["h"]), a["y"] - (b["y"] + b["h"]), 0)
    return (dx * dx + dy * dy) ** 0.5


def _overlap(a: dict, b: dict) -> bool:
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


def _outside(b: dict) -> bool:
    return b["x"] < SAFE["x0"] or b["x"] + b["w"] > SAFE["x1"] or b["y"] < SAFE["y0"] or b["y"] + b["h"] > SAFE["y1"]


def _sec(t: float) -> str:
    return f"{t:.1f}".replace(".", ",")


def check_layout(boxes_by_event: list[dict], face: dict | None) -> list[str]:
    """Проблемы геометрии: каждая — одной строкой с первым промежутком, где она есть, и числом промежутков."""
    found: dict[str, list[tuple[float, float]]] = {}

    def problem(text: str, e: dict) -> None:
        found.setdefault(text, []).append((e["t0"], e["t1"]))

    for e in boxes_by_event:
        boxes = e.get("boxes") or {}
        texts = [(key, boxes[key]) for key in ("sub", "hook", "cta") if boxes.get(key)]
        inserts = [(f"вставка {i + 1}", b) for i, b in enumerate(boxes.get("inserts") or [])]
        for key, b in texts:
            if _outside(b):
                problem(f"{NAMES[key]} вне безопасной зоны", e)
            if face and key != "sub" and _gap(b, face) < FACE_GAP:
                problem(f"{NAMES[key]} на лице или ближе {FACE_GAP} px к нему", e)
        for (ka, a), (kb, b) in ((x, y) for i, x in enumerate(texts) for y in texts[i + 1 :]):
            if _overlap(a, b):
                problem(f"{NAMES[ka]} и {NAMES[kb]} пересекаются", e)
        sub = boxes.get("sub")
        for name, b in inserts:
            if _outside(b):
                problem(f"{name} вне безопасной зоны", e)
            if face and _gap(b, face) < FACE_GAP:
                problem(f"{name} на лице или ближе {FACE_GAP} px к нему", e)
            if sub and _gap(b, sub) < SUB_GAP:
                problem(f"{name} на субтитрах или ближе {SUB_GAP} px к ним", e)

    out = []
    for text, spans in found.items():
        t0, t1 = spans[0]
        more = f", всего в {len(spans)} промежутках" if len(spans) > 1 else ""
        out.append(f"{text} ({_sec(t0)}–{_sec(t1)} с{more})")
    return out


def _head_volume(final: Path, seconds: float = 0.5) -> float:
    """Пиковая громкость первых `seconds` ролика, дБ (−inf — тишина)."""
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-t", str(seconds), "-i", str(final), "-vn", "-af", "volumedetect",
         "-f", "null", "-"],
        capture_output=True, text=True, check=False, timeout=120,
    ).stderr
    m = re.search(r"max_volume: (-?[\d.]+|-inf) dB", err)
    return float(m.group(1)) if m else float("-inf")


def check_render(final: Path, edit: dict, boxes_by_event: list[dict]) -> list[str]:
    """Что не даёт отдать ролик: формат, длительность, пропавшие хук и титр, музыка не с первого кадра."""
    info = probe(final)
    problems = []
    if (info.width, info.height) != (W, H) or round(info.fps) != 30:
        problems.append(f"формат {info.width}×{info.height}, {info.fps:g} к/с вместо 1080×1920, 30 к/с")
    if not info.has_audio:
        problems.append("в ролике нет звука")
    expected = timeline(edit).duration + float(edit.get("hold") or 0.0)
    if abs(info.duration - expected) > 0.1:
        problems.append(f"длительность {_sec(info.duration)} с вместо {_sec(expected)} с")
    shown = {key for e in boxes_by_event for key in ("hook", "cta") if (e.get("boxes") or {}).get(key)}
    if edit.get("hook") and "hook" not in shown:
        problems.append("хук есть в edit.json, но в ролике его нет")
    if edit.get("cta") and "cta" not in shown:
        problems.append("титр с кодовым словом есть в edit.json, но в ролике его нет")
    if edit.get("music") and info.has_audio and _head_volume(final) < -50:
        problems.append("музыка выбрана, но в начале ролика тишина — она не с первого кадра")
    return problems


def control_frames(final: Path, times: dict[str, float], out_dir: Path) -> dict[str, Path]:
    """Контрольные кадры `qa-<что>.png` в моменты `times` (hook, subs, insert, cta — что есть) и лист 2×2 `qa.png`
    в порядке хук, субтитры / вставка, титр (пустая клетка — чёрная)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    frames = {name: extract_frame(final, times[name], out_dir / f"qa-{name}.png") for name in SLOTS if name in times}
    args, chains = [], []
    for i, name in enumerate(SLOTS):
        if name in frames:
            args += ["-i", str(frames[name])]
        else:
            args += ["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:d=1"]
        chains.append(f"[{i}:v]scale={W // 2}:{H // 2}[c{i}]")
    chains.append("[c0][c1][c2][c3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0[out]")
    sheet = out_dir / "qa.png"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args, "-filter_complex", ";".join(chains),
         "-map", "[out]", "-frames:v", "1", str(sheet)],
        check=True, timeout=120,
    )
    return {**frames, "sheet": sheet}
