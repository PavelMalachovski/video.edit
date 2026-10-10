"""Сборка финала по edit.json одной командой ffmpeg.

Кадр: вырезка отрезков `keep` (по целым кадрам исходника; звук — с микро-фейдами 10 мс на стыках) → ускорение →
лёгкий цветокор → зум (якорь — лицо) → у невертикального исходника фон из размытой копии кадра → полноэкранные
перебивки (масштаб с обрезкой по центру, без своего звука) → стоп-кадр в конце (`hold`) → слой PNG (субтитры, хук,
титр, вставки; кадры рисует template/render-frames.mjs тем же шаблоном, что и превью) → шкала времени → H.264/AAC
с метками BT.709. Звук — граф `audio_graph`: голос, музыка, звуки вставок.

Цвет считается по BT.709 явно: цветокор — прямо в YUV (`eq`, `lutyuv`), слой и шкала переводятся из RGB по BT.709
(по умолчанию ffmpeg взял бы BT.601, и жёлтый субтитров на ролике отличался бы от превью). Шкала — полоса, которая
выезжает слева (`overlay` пересчитывает место каждый кадр; у `drawbox` ширина считается один раз).

Рабочие файлы — в `work/render/` задачи (в git не попадают); в `out_dir` — только ролик и субтитры.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

from .asr import Word
from .audio import audio_graph
from .job import Job
from .media import probe
from .overlay import FPS, build_overlay_events, insert_spans
from .subs import to_srt
from .timeline import Timeline
from .zoom import zoom_filter

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / "template"
FONTS = REPO / "assets" / "fonts"
W, H = 1080, 1920
RATE = 48000
FADE = 0.01  # с — микро-фейд звука на стыке отрезков
# чуть темнее и контрастнее, тёплый сдвиг ~1,5 % цветности (U ниже — меньше синего, V выше — больше красного)
COLOR = "eq=brightness=-0.02:contrast=1.03,lutyuv=u='clip(val-3,16,240)':v='clip(val+3,16,240)'"
BLUR = "boxblur=luma_radius=40:luma_power=2:chroma_radius=20:chroma_power=2,eq=brightness=-0.06"
TO_709 = "scale=out_color_matrix=bt709:out_range=tv"
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


class RenderError(RuntimeError):
    """Слой или ffmpeg не справились: в сообщении — что именно и последние строки вывода."""


def timeline(edit: dict) -> Timeline:
    """Шкала финала по edit.json: границы отрезков `keep` — на целых кадрах исходника (30 к/с), иначе субтитры
    и звук разошлись бы с картинкой на долю кадра на каждом стыке."""
    keep = []
    for a, b in edit["keep"]:
        fa, fb = round(a * FPS), round(b * FPS)
        if fb > fa:
            keep.append((fa / FPS, fb / FPS))
    return Timeline(keep, edit["speed"])


def render(job: Job, out_dir: Path, name: str = "final", preset: str = "medium") -> dict:
    """Пишет `out_dir/<name>.mp4` и `out_dir/<name>.srt`. → `{durations, missing, warnings}`."""
    edit = job.read("edit.json")
    source = job.path("source.mp4")
    info = probe(source)
    tl = timeline(edit)
    if tl.duration <= 0:
        raise RenderError("edit.json: отрезки keep не оставляют ни одного кадра")
    hold = float(edit.get("hold") or 0.0)
    total = tl.duration + hold
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    work = job.path("work/render")
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)

    missing: list[str] = []
    warnings: list[str] = []
    if not edit.get("music"):
        missing.append("music: none chosen")
    words = [Word(w["t0"], w["t1"], w["text"]) for w in edit.get("words") or []]
    srt = to_srt(words, tl)
    if not srt:
        missing.append("speech: нет речи — ролик без субтитров")

    layer = _layer(job, edit, tl, work)
    inputs = ["-i", str(source), "-f", "concat", "-safe", "0", "-i", str(layer)]
    chains = _cut(tl, info.has_audio)
    picture, more = _picture(job, edit, tl, info, _count(inputs), hold, missing, warnings)
    inputs += more
    chains += picture
    chains += _layers(edit["style"], tl)
    sfx, music = _sounds(job, edit, tl)
    extra, sound, notes = audio_graph("[ac]", edit["speed"], total, music, sfx, inputs_offset=_count(inputs))
    inputs += extra
    chains.append(sound)
    missing += notes

    part = out_dir / f".{name}.part.mp4"
    _ffmpeg([*inputs, "-filter_complex", ";".join(chains), "-map", "[vout]", "-map", "[aout]", *_encode(preset),
             "-t", f"{total:.6f}", str(part)], timeout=max(900, 30 * total))
    os.replace(part, out_dir / f"{name}.mp4")
    (out_dir / f"{name}.srt").write_text(srt, encoding="utf-8")
    return {"durations": {"source": round(info.duration, 3), "final": round(total, 3)}, "missing": missing, "warnings": warnings}


def _count(inputs: list[str]) -> int:
    return inputs.count("-i")


def _layer(job: Job, edit: dict, tl: Timeline, work: Path) -> Path:
    """Кадры слоя PNG и frames.ffconcat (render-frames.mjs)."""
    (work / "events.json").write_text(json.dumps(build_overlay_events(edit, tl), ensure_ascii=False), encoding="utf-8")
    (work / "spec.json").write_text(json.dumps(edit["style"], ensure_ascii=False), encoding="utf-8")
    frames = work / "frames"
    cmd = ["node", str(TEMPLATE / "render-frames.mjs"), str(work / "events.json"), str(work / "spec.json"), str(frames),
           "--root", str(job.root), "--root", str(REPO)]
    if FONTS.is_dir():
        cmd += ["--fonts", str(FONTS)]
    events = len(json.loads((work / "events.json").read_text(encoding="utf-8")))
    try:  # ~0,15 с на состояние; потолок — чтобы зависший браузер не держал рутину вечно
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=max(600, 2 * events))
    except subprocess.TimeoutExpired as err:
        raise RenderError(f"слой не уложился в {err.timeout:.0f} с — браузер завис?") from None
    if proc.returncode != 0:
        raise RenderError(f"слой не нарисован: {proc.stderr.strip()[-2000:]}")
    return frames / "frames.ffconcat"


def _cut(tl: Timeline, has_audio: bool) -> list[str]:
    """Отрезки keep встык: картинка — по целым кадрам, звук — те же границы в отсчётах, с фейдами 10 мс."""
    chains = []
    pads = []
    for i, (start, end, _) in enumerate(tl.segments):
        f0, f1 = round(start * FPS), round(end * FPS)
        length = (f1 - f0) / FPS
        chains.append(f"[0:v]trim=start_frame={f0}:end_frame={f1},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            a0, a1 = f0 * RATE // FPS, f1 * RATE // FPS
            chains.append(
                f"[0:a]atrim=start_sample={a0}:end_sample={a1},asetpts=PTS-STARTPTS,"
                f"afade=t=in:d={FADE}:curve=tri,afade=t=out:st={max(0.0, length - FADE):.6f}:d={FADE}:curve=tri[a{i}]"
            )
        else:
            chains.append(f"aevalsrc=0|0:s={RATE}:d={length:.6f}[a{i}]")
        pads.append(f"[v{i}][a{i}]")
    chains.append(f"{''.join(pads)}concat=n={len(pads)}:v=1:a=1[vc][ac]")
    return chains


def _picture(job, edit, tl, info, index, hold, missing, warnings) -> tuple[list[str], list[str]]:
    """Ускорение, цвет, зум, фон, перебивки, стоп-кадр → `[vh]`; плюс входы для перебивок."""
    chains = []
    inputs: list[str] = []
    chain = f"[vc]setpts=PTS/{edit['speed']:g},fps={FPS},{COLOR}"
    zoom = zoom_filter(edit.get("zooms") or [], tl, edit["face"], W=info.width, H=info.height, fps=FPS)
    if zoom != "null":
        chain += f",{zoom}"
    chains.append(f"{chain}[vz]")
    current = "[vz]"
    if (info.width, info.height) != (W, H):
        warnings.append(f"исходник не вертикальный ({info.width}×{info.height}): по краям — размытая копия кадра")
        chains.append(
            f"{current}split=2[bgs][fgs];[bgs]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},{BLUR}[bg];"
            f"[bg][fgs]overlay=(W-w)/2:(H-h)/2[vbg]"
        )
        current = "[vbg]"

    inserts = edit.get("inserts") or []
    for i, first, after in insert_spans(edit, tl):
        ins = inserts[i]
        if ins["kind"] != "fullscreen":
            continue
        path = _resolve(job, ins.get("src"))
        if path is None:
            missing.append(f"fullscreen: {ins.get('src')} not found — перебивки нет")
            continue
        a, b = first / FPS, min(after / FPS, tl.duration)
        if b <= a:
            continue
        if path.suffix.lower() in IMAGES:
            inputs += ["-loop", "1", "-framerate", str(FPS), "-t", f"{b - a:.6f}", "-i", str(path)]
        else:
            inputs += ["-t", f"{b - a:.6f}", "-i", str(path)]
        chains.append(
            f"[{index}:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},"
            f"{TO_709},format=yuv420p,setpts=PTS-STARTPTS+{a:.6f}/TB[fs{i}]"
        )
        chains.append(f"{current}[fs{i}]overlay=0:0:enable='gte(t,{a:.6f})*lt(t,{b:.6f})'[vf{i}]")
        current = f"[vf{i}]"
        index += 1

    if hold > 0:
        chains.append(f"{current}tpad=stop_mode=clone:stop_duration={hold:.6f}[vh]")
    else:
        chains.append(f"{current}null[vh]")
    return chains, inputs


def _layers(style: dict, tl: Timeline) -> list[str]:
    """Слой PNG поверх кадра, затем шкала времени: ширина 1080·t/D, на стоп-кадре — полная."""
    bar = style["bar"]
    height = max(1, round(bar["height"]))
    y = 0 if bar["pos"] == "top" else H - height
    color = style["colors"]["bar"].lstrip("#")
    return [
        f"[1:v]fps={FPS},format=rgba,{TO_709},format=yuva420p[ov]",
        "[vh][ov]overlay=0:0:eof_action=pass[vo]",
        f"color=c=0x{color}:s={W}x{height}:r={FPS},format=rgb24,{TO_709},format=yuv420p[barsrc]",
        f"[vo][barsrc]overlay=x='-w+w*min(1,t/{tl.duration:.6f})':y={y}:shortest=1,format=yuv420p[vout]",
    ]


def _sounds(job: Job, edit: dict, tl: Timeline) -> tuple[list, dict | None]:
    """Звуки появления вставок (время финала, файл) и музыка с путём от задачи или репозитория."""
    inserts = edit.get("inserts") or []
    sfx = []
    for i, first, _ in insert_spans(edit, tl):
        name = inserts[i].get("sfx")
        if name:
            sfx.append((first / FPS, _resolve(job, name) or Path(name)))
    music = edit.get("music")
    if music:
        music = {"file": str(_resolve(job, music["file"]) or music["file"]), "gainDb": music["gainDb"]}
    return sfx, music


def _resolve(job: Job, rel: str | None) -> Path | None:
    """Файл по пути от папки задачи или от корня репозитория (assets/…); нет — None."""
    if not rel:
        return None
    for base in (job.root.resolve(), REPO):
        path = (base / rel).resolve()
        if path.is_relative_to(base) and path.is_file():
            return path
    return None


def _encode(preset: str) -> list[str]:
    return [
        "-c:v", "libx264", "-crf", "18", "-preset", preset, "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-movflags", "+faststart",
    ]


def _ffmpeg(args: list[str], timeout: float) -> None:
    """ffmpeg с потолком времени: зависший (например, на битом файле) не держит рутину вечно."""
    try:
        proc = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args],
                              capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RenderError(f"ffmpeg не уложился в {timeout:.0f} с — остановлен") from None
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise RenderError(f"ffmpeg не собрал ролик:\n{tail}")
