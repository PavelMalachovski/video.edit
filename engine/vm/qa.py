"""Проверка качества перед тем, как отдать ролик.

`check_layout` — геометрия слоя по boxes.json (рамки элементов по промежуткам, их пишет render-frames.mjs):
всё внутри безопасной зоны X 60–890 / Y 120–1530 (шкала и полноэкранные перебивки в boxes не попадают), вставки,
титры и акценты не ближе 40 px к лицу, вставки не ближе 20 px к субтитрам и не на хуке, титре или акценте, тексты не
пересекаются, акцент не во время хука. Лицо растёт с зумом (`zoom` — уровень в момент финала): зум держит точку лица
на месте, рамка лица увеличивается вокруг неё; на промежутке берётся самый крупный план. Субтитры с лицом не
сверяются: их высоту задаёт выбранный стиль. Вставку называют её номером в edit.inserts (с 1)
и подписью. `check_render` — «не отдавать»: формат, длительность, хук и титр из edit.json есть в ролике, выбранная
музыка попала в микс и не начинается с тишины. `checklist` — чек-лист по гайду Meta для экрана «Готово» (формат,
звук, хук, безопасные зоны, субтитры, финальная карточка, длина). `control_frames` — контрольные кадры готового ролика
и лист 2×2; `compose_frames` — такие же кадры до рендера: кадр исходника и слой этого момента (`vm check`).
"""
import json
import re
import subprocess
from collections.abc import Callable
from pathlib import Path

from .media import MediaError, extract_frame, mp4_boxes, probe
from .timeline import Timeline

SAFE = {"x0": 60, "x1": 890, "y0": 120, "y1": 1530}
FACE_GAP = 40
SUB_GAP = 20
FACE_W, FACE_H = 0.30, 0.22  # рамка лица по умолчанию, доли кадра: Claude надёжно даёт только точку
W, H = 1080, 1920
SLOTS = ("hook", "subs", "accent", "insert", "cta")  # порядок клеток листа 3×2: слева направо, сверху вниз
HEAD = 0.5  # с — начало музыки, которое должно звучать
SILENT_DB = -50.0  # пик тише этого — тишина
NAMES = {"sub": "субтитры", "hook": "хук", "cta": "титр", "accent": "акцент", "end": "финальная карточка"}
TEXTS = ("sub", "hook", "cta", "accent")  # тексты слоя: друг на друге не стоят
HOOK_BY = 1.0  # с — хук на экране не позже: мысль ролика — в первые 2 с (гайд «Всё о Reels»)
MAX_LENGTH = 90.0  # с — длина, которую советует гайд
CHECKS = {  # строки чек-листа на экране «Готово»; подпись к посту Claude пишет после рендера — её строку ставит страница
    "format": "9:16, 1080×1920, 30 к/с",
    "container": "H.264 в MP4 без edit lists",
    "audio": "звук стерео AAC",
    "hook": "хук с первой секунды",
    "safe": "текст в безопасных зонах",
    "subtitles": "субтитры",
    "end": "финальная карточка с призывом",
    "length": "длина до 90 с",
}


def face_box(face: dict | None) -> dict | None:
    """Рамка лица в px кадра по `edit.face` (доли): центр x, y; без w/h — 0,30 × 0,22 кадра."""
    if not face:
        return None
    w = round(W * face.get("w", FACE_W))
    h = round(H * face.get("h", FACE_H))
    return {"x": round(W * face["x"] - w / 2), "y": round(H * face["y"] - h / 2), "w": w, "h": h}


def _zoomed(face: dict, level: float) -> dict:
    """Рамка лица при зуме `level`: зум держит центр лица на месте, рамка растёт вокруг него."""
    if level <= 1.0:
        return face
    cx, cy = face["x"] + face["w"] / 2, face["y"] + face["h"] / 2
    w, h = face["w"] * level, face["h"] * level
    return {"x": round(cx - w / 2), "y": round(cy - h / 2), "w": round(w), "h": round(h)}


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


def _insert_name(box: dict, inserts: list[dict] | None) -> str:
    """«вставка 3 «Лайфхак»» — по номеру `n` из рамки (место в edit.inserts) и подписи, тексту или имени файла."""
    n = box.get("n")
    if not isinstance(n, int):
        return "вставка"
    ins = inserts[n] if inserts and 0 <= n < len(inserts) else {}
    label = ins.get("title") or ins.get("text") or (Path(ins["src"]).name if ins.get("src") else "")
    return f"вставка {n + 1}" + (f" «{label}»" if label else "")


def _runs(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Промежутки подряд (слой режется на каждом слове субтитров) — одно место в ролике."""
    runs: list[tuple[float, float]] = []
    for t0, t1 in spans:
        if runs and abs(t0 - runs[-1][1]) < 1e-6:
            runs[-1] = (runs[-1][0], t1)
        else:
            runs.append((t0, t1))
    return runs


def check_layout(boxes_by_event: list[dict], face_at_rest: dict | None, inserts: list[dict] | None = None,
                 zoom: Callable[[float], float] | None = None) -> list[str]:
    """Проблемы геометрии: каждая — одной строкой с первым местом в ролике, где она есть (время финала), и числом
    таких мест. `face_at_rest` — рамка лица в px без зума (`face_box`); `inserts` — edit.inserts, для подписей вставок;
    `zoom` — уровень зума в момент финала (нет — 1)."""
    found: dict[str, list[tuple[float, float]]] = {}

    def problem(text: str, e: dict) -> None:
        found.setdefault(text, []).append((e["t0"], e["t1"]))

    for e in boxes_by_event:
        boxes = e.get("boxes") or {}
        face = face_at_rest
        if face and zoom:  # наезд внутри промежутка — самый крупный план из начала, середины и конца
            face = _zoomed(face, max(zoom(t) for t in (e["t0"], (e["t0"] + e["t1"]) / 2, max(e["t0"], e["t1"] - 1e-6))))
        texts = [(key, boxes[key]) for key in TEXTS if boxes.get(key)]
        shown = [(_insert_name(b, inserts), b) for b in boxes.get("inserts") or []]
        if boxes.get("hook") and boxes.get("accent"):
            problem("акцент во время хука", e)
        if boxes.get("end") and _outside(boxes["end"]):  # карточка — на затемнённом кадре: лицо закрывать можно
            problem(f"{NAMES['end']} вне безопасной зоны", e)
        for key, b in texts:
            if _outside(b):
                problem(f"{NAMES[key]} вне безопасной зоны", e)
            if face and key != "sub" and _gap(b, face) < FACE_GAP:
                problem(f"{NAMES[key]} на лице или ближе {FACE_GAP} px к нему", e)
        for (ka, a), (kb, b) in ((x, y) for i, x in enumerate(texts) for y in texts[i + 1 :]):
            if _overlap(a, b):
                problem(f"{NAMES[ka]} и {NAMES[kb]} пересекаются", e)
        sub = boxes.get("sub")
        for name, b in shown:
            if _outside(b):
                problem(f"{name} вне безопасной зоны", e)
            if face and _gap(b, face) < FACE_GAP:
                problem(f"{name} на лице или ближе {FACE_GAP} px к нему", e)
            if sub and _gap(b, sub) < SUB_GAP:
                problem(f"{name} на субтитрах или ближе {SUB_GAP} px к ним", e)
            for key, t in texts:
                if key != "sub" and _overlap(b, t):
                    problem(f"{name} закрывает {NAMES[key]}", e)

    out = []
    for text, spans in found.items():
        runs = _runs(spans)
        t0, t1 = runs[0]
        more = f"; таких мест: {len(runs)}" if len(runs) > 1 else ""
        out.append(f"{text} ({_sec(t0)}–{_sec(t1)} с ролика{more})")
    return out


def _head_volume(path: Path, seconds: float = HEAD) -> float:
    """Пиковая громкость первых `seconds` файла, дБ (цифровая тишина — около −91)."""
    done = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-t", str(seconds), "-i", str(path), "-vn",
         "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=False, timeout=120,
    )
    m = re.search(r"max_volume: (-?[\d.]+|-inf) dB", done.stderr)
    if done.returncode != 0 or not m:
        raise MediaError(f"{path}: не удалось измерить громкость начала (ffmpeg, код {done.returncode})")
    return float(m.group(1))


def check_render(final: Path, edit: dict, boxes_by_event: list[dict], report: dict) -> list[str]:
    """Что не даёт отдать ролик: формат, длительность, пропавшие хук и титр, музыка не в миксе или с тишиной
    в начале. `report` — что вернул `render`: длительность, которую он собрал (keep за концом исходника он
    обрезает), заметки о ненайденном (`missing`) и файл музыки, ушедший в микс (`music`)."""
    info = probe(final)
    problems = []
    if (info.width, info.height) != (W, H) or round(info.fps) != 30:
        problems.append(f"формат {info.width}×{info.height}, {info.fps:g} к/с вместо 1080×1920, 30 к/с")
    if not info.has_audio:
        problems.append("в ролике нет звука")
    expected = report["durations"]["final"]
    if abs(info.duration - expected) > 0.1:
        problems.append(f"длительность {_sec(info.duration)} с вместо {_sec(expected)} с")
    shown = {key for e in boxes_by_event for key in ("hook", "cta", "end") if (e.get("boxes") or {}).get(key)}
    if edit.get("hook") and "hook" not in shown:
        problems.append("хук есть в edit.json, но в ролике его нет")
    if edit.get("cta") and "cta" not in shown:
        problems.append("титр с кодовым словом есть в edit.json, но в ролике его нет")
    if edit.get("end") and "end" not in shown:
        problems.append("финальная карточка есть в edit.json, но в ролике её нет")
    music = edit.get("music")
    if music:  # по миксу не проверить: голос с первого кадра заглушает отсутствие музыки
        lost = [m for m in report.get("missing", []) if Path(music["file"]).name in m]
        if lost or not report.get("music"):
            problems.append("музыка выбрана, но в ролик не попала" + (f": {lost[0]}" if lost else ""))
        elif _head_volume(Path(report["music"])) < SILENT_DB:
            problems.append(f"музыка выбрана, но начинается с тишины — первые {_sec(HEAD)} с её не слышно")
    return problems


def _codecs(path: Path) -> dict:
    """Кодек первой видеодорожки, кодек и каналы первой звуковой (ffprobe)."""
    done = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,channels", "-of", "json",
                           str(path)], capture_output=True, text=True, check=False, timeout=60)
    if done.returncode != 0:
        raise MediaError(f"{path}: ffprobe не прочитал дорожки (код {done.returncode})")
    streams = json.loads(done.stdout or "{}").get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    return {"video": video.get("codec_name"), "audio": audio.get("codec_name"), "channels": audio.get("channels")}


def checklist(final: Path, boxes_by_event: list[dict], report: dict) -> list[dict]:
    """Чек-лист по гайду для экрана «Готово»: что видно по готовому ролику и его слою → `[{id, title, ok}]` в порядке
    CHECKS. `report` — что вернул `render` (длительность)."""
    info = probe(final)
    codecs = _codecs(final)

    def shown(key: str) -> list[dict]:
        return [e for e in boxes_by_event if (e.get("boxes") or {}).get(key)]

    every = [b for e in boxes_by_event for b in [*((e.get("boxes") or {}).get(k) for k in NAMES), *((e.get("boxes") or {}).get("inserts") or [])] if b]
    hook = shown("hook")
    ok = {
        "format": (info.width, info.height) == (W, H) and round(info.fps) == 30,
        "container": codecs["video"] == "h264" and not any(box.endswith("/elst") for box in mp4_boxes(final)),
        "audio": codecs["audio"] == "aac" and codecs["channels"] == 2,
        "hook": bool(hook) and min(e["t0"] for e in hook) <= HOOK_BY,
        "safe": not any(_outside(b) for b in every),
        "subtitles": bool(shown("sub")),
        "end": bool(shown("end")),
        "length": report["durations"]["final"] <= MAX_LENGTH,
    }
    return [{"id": key, "title": title, "ok": ok[key]} for key, title in CHECKS.items()]


def slot_times(boxes_by_event: list[dict]) -> dict[str, float]:
    """Моменты контрольных кадров (время финала): середина первого промежутка не короче 0,1 с, где виден хук,
    субтитры, акцент, вставка (уже появившаяся) и титр; короче — кадр появления или последний кадр прошлого субтитра."""
    times: dict[str, float] = {}
    for e in boxes_by_event:
        if e["t1"] - e["t0"] < 0.1:
            continue
        b = e.get("boxes") or {}
        middle = (e["t0"] + e["t1"]) / 2
        for key, name in (("hook", "hook"), ("sub", "subs"), ("accent", "accent"), ("inserts", "insert"), ("cta", "cta")):
            if b.get(key) and name not in times:
                times[name] = middle
    return times


def control_frames(final: Path, times: dict[str, float], out_dir: Path) -> dict[str, Path]:
    """Контрольные кадры `qa-<что>.png` в моменты `times` (hook, subs, accent, insert, cta — что есть) и лист 3×2
    `qa.png` в порядке хук, субтитры, акцент / вставка, титр (пустая клетка — чёрная)."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("qa-*.png"):  # кадры прошлой проверки — не от этого ролика
        old.unlink()
    frames = {name: extract_frame(final, times[name], out_dir / f"qa-{name}.png") for name in SLOTS if name in times}
    return {**frames, "sheet": _sheet(frames, out_dir / "qa.png")}


def compose_frames(source: Path, boxes_by_event: list[dict], layer_dir: Path, tl: Timeline, times: dict[str, float],
                   out_dir: Path) -> dict[str, Path]:
    """Контрольные кадры до рендера: кадр исходника в момент `times[что]` (время финала → время исходника) и PNG
    слоя этого промежутка поверх; зум, цвет, фон и перебивки здесь не видны — только место текста и вставок.
    → `check-<что>.png` и лист 3×2 `check.png` в `out_dir`."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("check-*.png"):
        old.unlink()
    frames = {}
    for name in SLOTS:
        if name not in times:
            continue
        t = times[name]
        entry = next((e for e in boxes_by_event if e["t0"] <= t < e["t1"]), boxes_by_event[-1])
        out = out_dir / f"check-{name}.png"
        chain = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1[bg];"
                 "[bg][1:v]overlay=0:0")
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", f"{tl.to_source(t):.3f}",
             "-i", str(source), "-i", str(Path(layer_dir) / entry["frame"]), "-filter_complex", chain,
             "-frames:v", "1", str(out)],
            check=True, capture_output=True, timeout=120,
        )
        frames[name] = out
    return {**frames, "sheet": _sheet(frames, out_dir / "check.png")}


def _sheet(frames: dict[str, Path], sheet: Path) -> Path:
    """Лист 3×2 из кадров в половину размера: хук, субтитры, акцент / вставка, титр, пусто; клетки без кадра —
    чёрные."""
    args, chains = [], []
    cells = [*SLOTS, None][:6]
    for i, name in enumerate(cells):
        if name in frames:
            args += ["-i", str(frames[name])]
        else:
            args += ["-f", "lavfi", "-i", f"color=c=black:s={W}x{H}:d=1"]
        chains.append(f"[{i}:v]scale={W // 2}:{H // 2}[c{i}]")
    chains.append("[c0][c1][c2][c3][c4][c5]xstack=inputs=6:layout=0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0[out]")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args, "-filter_complex", ";".join(chains),
         "-map", "[out]", "-frames:v", "1", str(sheet)],
        check=True, timeout=120,
    )
    return sheet
