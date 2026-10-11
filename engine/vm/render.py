"""Сборка финала по edit.json одной командой ffmpeg.

Кадр: вырезка отрезков `keep` (по целым кадрам исходника; звук — с микро-фейдами 10 мс на стыках) → ускорение →
лёгкий цветокор → ч/б-куски (`edit.looks`: на своих кадрах — без цвета, контрастнее, темнее, с виньеткой) → зум
(якорь — лицо) → у невертикального исходника фон из размытой копии кадра → полноэкранные
перебивки (масштаб с обрезкой по центру, без своего звука) → стоп-кадр в конце (`hold` и финальная карточка
`end.seconds`: её затемнение, призыв, ник и логотип рисует слой) → слой PNG (субтитры, хук,
титр, вставки; кадры рисует template/render-frames.mjs тем же шаблоном, что и превью) → шкала времени → H.264/AAC
с метками BT.709, без B-кадров и edit lists (их не принимает Meta). Звук — граф `audio_graph`: голос, музыка, звуки
вставок.

Цвет считается по BT.709 явно: цветокор — прямо в YUV (`eq`, `lutyuv`), слой и шкала переводятся из RGB по BT.709
(по умолчанию ffmpeg взял бы BT.601, и жёлтый субтитров на ролике отличался бы от превью). Шкала — полоса, которая
выезжает слева (`overlay` пересчитывает место каждый кадр; у `drawbox` ширина считается один раз).

Перебивка: картинка держится всё окно, GIF крутится по кругу, видео короче окна стоит на последнем кадре; HDR
переводится в SDR так же, как исходник. Файл перебивки, музыки или звука, которого нет (или он не читается), —
строка в `missing`, а не ошибка: ролик собирается без него. Отрезки `keep` за концом исходника обрезаются
с предупреждением.

Слой рисует `draw_layer` — он же нужен проверке до рендера (`vm check`); если ни события слоя, ни стиль, ни файлы
картинок не поменялись, уже нарисованные кадры берутся как есть. С музыкой смены зума и появления вставок сначала
встают на доли трека (`on_beats`, монтаж в такт): и слой, и зум, и звуки вставок берут один и тот же сдвинутый edit.

Рабочие файлы — в `work/render/` задачи (в git не попадают); в `out_dir` — только ролик и субтитры, и появляются
они там только целиком.
"""
import json
import math
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import beats
from .asr import Word
from .audio import MIN_MUSIC, QUIET_LUFS, audio_graph
from .job import Job, validate
from .media import HDR_TO_SDR, MediaError, Probe, loudness, probe
from .overlay import FPS, build_overlay_events, insert_spans
from .subs import to_srt
from .timeline import Timeline
from .zoom import zoom_filter

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / "template"
FONTS = REPO / "assets" / "fonts"
SFX = REPO / "assets" / "sfx"
SOUNDS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}
W, H = 1080, 1920
RATE = 48000
FADE = 0.01  # с — микро-фейд звука на стыке отрезков
# чуть темнее и контрастнее, тёплый сдвиг ~1,5 % цветности (U ниже — меньше синего, V выше — больше красного)
COLOR = "eq=brightness=-0.02:contrast=1.03,lutyuv=u='clip(val-3,16,240)':v='clip(val+3,16,240)'"
BLUR = "boxblur=luma_radius=40:luma_power=2:chroma_radius=20:chroma_power=2,eq=brightness=-0.06"
TO_709 = "scale=out_color_matrix=bt709:out_range=tv"
# ч/б-кусок стиля эталона: без цвета, контрастнее, чуть темнее, виньетка по краям
BW = ("hue=s=0", "eq=contrast=1.18:brightness=-0.04", "vignette=angle=0.6")
# Meta не принимает edit lists в контейнере (гайд «Всё о Reels», стр. 63). Без них плеер играет приминг кодера AAC
# ffmpeg — 1024 отсчёта в начале, поэтому на вход кодера звук идёт с 1024-го отсчёта: приминг занимает его место, и
# отсчёт n звучит ровно в n. B-кадров нет (`-bf 0`): с ними картинка начиналась бы на 2 кадра позже звука.
AAC_PRIMING = 1024
IMAGES = {".png", ".jpg", ".jpeg", ".webp"}  # картинка держится всё окно перебивки; GIF крутится по кругу
TEXTUAL = ("sticker", "text")  # вставки из одного текста: картинка им не нужна
AB = ("teaser", "music")  # чем вторая версия A/B-теста отличается от первой: без тизера или без музыки
LOOPED = {".gif"}


class RenderError(RuntimeError):
    """Слой или ffmpeg не справились: в сообщении — что именно и последние строки вывода."""


def timeline(edit: dict, limit: float | None = None) -> Timeline:
    """Шкала финала по edit.json: границы отрезков `keep` и тизера — на целых кадрах исходника (30 к/с), иначе субтитры
    и звук разошлись бы с картинкой на долю кадра на каждом стыке. `limit` — длина исходника, с: кадров после его
    последнего целого кадра в отрезках нет (длина файла бывает чуть больше видео — из-за кадра AAC)."""
    last = math.floor(limit * FPS + 0.01) if limit is not None else None

    def frames(a: float, b: float) -> tuple[float, float] | None:
        fa, fb = round(a * FPS), round(b * FPS)
        if last is not None:
            fb = min(fb, last)
        return (fa / FPS, fb / FPS) if fb > fa else None

    keep = [span for a, b in edit["keep"] if (span := frames(a, b))]
    teaser = edit.get("teaser") or None
    return Timeline(keep, edit["speed"], teaser=frames(teaser["t0"], teaser["t1"]) if teaser else None)


@dataclass
class Layer:
    """Нарисованный слой для edit.json: по нему проверка до рендера и сам рендер."""

    edit: dict
    info: Probe  # исходник
    tl: Timeline  # шкала с keep, обрезанным по исходнику
    frames: Path  # frames.ffconcat
    boxes: list[dict]  # boxes.json: [{t0, t1, frame, boxes}]
    warnings: list[str]
    beats: dict | None = None  # монтаж в такт: {bpm, moved}; без музыки — None


def variant_b(edit: dict) -> dict:
    """Вторая версия A/B-теста (`edit.ab`): та же, но без тизера или без музыки."""
    kind = edit.get("ab")
    if kind not in AB:
        raise RenderError(f"edit.json: ab — {' или '.join(AB)}, а не {kind!r}")
    if not edit.get(kind):
        what = "тизера" if kind == "teaser" else "музыки"
        raise RenderError(f"edit.json: ab = {kind}, а {what} нет — версия B вышла бы такой же: убери ab")
    return {**edit, kind: None, "ab": None}


def on_beats(job: Job, edit: dict, tl: Timeline) -> tuple[dict, dict | None]:
    """Монтаж в такт: с музыкой (и без `music.beats: false`) смены зума и появления вставок встают на её доли
    (`beats.snap_edit`, не дальше 0,25 с). Трек звучит с начала ролика и по кругу — доли повторяются с ним.
    → (edit со сдвигами, {bpm, moved}); без музыки, файла или ритма в нём — (edit как был, None)."""
    music = edit.get("music")
    path = _resolve(job, music["file"]) if music and music.get("beats", True) else None
    if path is None:
        return edit, None
    want = tl.duration + 2.0  # доли дальше ролика не нужны; запас — чтобы последняя доля нашлась
    try:
        y = beats.load(path, seconds=want)
    except (subprocess.SubprocessError, OSError):
        return edit, None  # не читается — микс скажет об этом в missing
    length = len(y) / beats.SR
    if length < MIN_MUSIC:
        return edit, None
    grid = beats.track(y)
    loops = 1 if length >= want - 0.05 else math.ceil(tl.duration / length)  # короче — весь трек, и он по кругу
    snapped, moved = beats.snap_edit(edit, tl, [t + k * length for k in range(loops) for t in grid.times])
    return snapped, {"bpm": grid.bpm, "moved": moved}


def draw_layer(job: Job, edit: dict | None = None, work: str = "work/render") -> Layer:
    """edit.json (по схеме; `edit` — вместо него, например версия B) → шкала по исходнику → события на доли музыки
    (`on_beats`) → кадры слоя в `<work>/frames`."""
    edit = job.read("edit.json") if edit is None else edit
    validate("edit.json", edit)  # файл пишет Claude: ошибка называет поле, а не падает KeyError где-то в графе
    waiting = [ins["question"] for ins in edit["inserts"] if ins.get("question") and not ins.get("src") and ins["kind"] not in TEXTUAL]
    if waiting:
        raise RenderError(
            "edit.json: вставки ждут ответа на вопросы " + ", ".join(f"«{q}»" for q in waiting)
            + ": по answers.json поставь src (или kind sticker и text), «не надо» — убери вставку; место и время не меняй"
        )
    info = probe(job.path("source.mp4"))
    tl = timeline(edit, info.duration)
    if tl.duration <= 0:
        raise RenderError("edit.json: отрезки keep не оставляют ни одного кадра исходника")
    warnings = []
    beyond = (timeline(edit).duration - tl.duration) * edit["speed"]
    if beyond > 0.1:
        warnings.append(f"keep заходит за конец исходника ({info.duration:.1f} с): {beyond:.1f} с отрезков отброшено")
    edit, beat = on_beats(job, edit, tl)
    frames = _layer(job, edit, tl, job.path(work))
    boxes = json.loads((frames.parent / "boxes.json").read_text(encoding="utf-8"))
    return Layer(edit, info, tl, frames, boxes, warnings, beat)


def render(job: Job, out_dir: Path, name: str = "final", preset: str = "medium", edit: dict | None = None,
           work: str = "work/render") -> dict:
    """Пишет `out_dir/<name>.mp4` и `out_dir/<name>.srt` (без речи `.srt` нет: пустой ассет GitHub не примет и не
    отдаст ролик). → `{durations, missing, warnings, music, voice}`; `missing` Павел читает на странице — по-русски;
    `voice` — громкость исходника и было ли шумоподавление (тихая запись); `beats` — монтаж в такт: темп и сколько
    событий встало на доли (без музыки — None). `edit` — вместо edit.json (версия B A/B-теста), `work` — папка её
    слоя."""
    drawn = draw_layer(job, edit, work)
    edit, info, tl, layer = drawn.edit, drawn.info, drawn.tl, drawn.frames
    source = job.path("source.mp4")
    missing: list[str] = []
    warnings = list(drawn.warnings)
    hold = float(edit.get("hold") or 0.0) + _card_seconds(edit)  # карточка стоит на том же стоп-кадре
    total = tl.duration + hold
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob(f".{name}.part.*"):  # от прерванной сборки
        stale.unlink()

    words = [Word(w["t0"], w["t1"], w["text"]) for w in edit.get("words") or []]
    srt = to_srt(words, tl)
    if not srt:
        missing.append("нет речи — ролик без субтитров")

    inputs = ["-i", str(source), "-f", "concat", "-safe", "0", "-i", str(layer)]
    chains = _cut(tl, info.has_audio)
    picture, more, skipped = _picture(job, edit, tl, info, _count(inputs), hold, missing, warnings)
    inputs += more
    chains += picture
    chains += _layers(edit["style"], tl)
    sfx, music, notes = _sounds(job, edit, tl, skip=skipped)
    missing += notes
    lufs = loudness(source) if info.has_audio else None
    quiet = lufs is not None and lufs < QUIET_LUFS
    extra, sound, notes = audio_graph("[ac]", edit["speed"], total, music, sfx, inputs_offset=_count(inputs), denoise=quiet)
    inputs += extra
    chains.append(sound)
    chains.append(f"[aout]atrim=start_sample={AAC_PRIMING}[aenc]")
    missing += notes

    video, subs = out_dir / f".{name}.part.mp4", out_dir / f".{name}.part.srt"
    try:  # ролик и субтитры появляются в out/ только целиком; от упавшей сборки не остаётся ничего
        if srt:
            subs.write_text(srt, encoding="utf-8")
        _ffmpeg([*inputs, "-filter_complex", ";".join(chains), "-map", "[vout]", "-map", "[aenc]", *_encode(preset),
                 "-t", f"{total:.6f}", str(video)], timeout=max(900, 30 * total))
        os.replace(video, out_dir / f"{name}.mp4")
        if srt:
            os.replace(subs, out_dir / f"{name}.srt")
        else:  # субтитры прошлого рендера этой версии — от другого текста
            (out_dir / f"{name}.srt").unlink(missing_ok=True)
    finally:
        video.unlink(missing_ok=True)
        subs.unlink(missing_ok=True)
    return {
        "durations": {"source": round(info.duration, 3), "final": round(total, 3)},
        "missing": missing,
        "warnings": warnings,
        "music": music["file"] if music else None,  # файл, отданный в микс (для проверки качества)
        "voice": {"lufs": None if lufs is None or math.isinf(lufs) else round(lufs, 1), "denoise": quiet},
        "beats": drawn.beats,
    }


def _count(inputs: list[str]) -> int:
    return inputs.count("-i")


def _layer(job: Job, edit: dict, tl: Timeline, work: Path) -> Path:
    """Кадры слоя PNG, frames.ffconcat и boxes.json (render-frames.mjs). Ключ — события, стиль и размер/время
    файлов картинок вставок: совпал с прошлым рисованием — кадры уже есть."""
    events = build_overlay_events(edit, tl)
    pictures = sorted({i["src"] for e in events for i in e["state"].get("inserts", []) if i.get("src")})
    stamps = {}
    for src in pictures:
        path = _resolve(job, src)
        stamps[src] = [path.stat().st_size, path.stat().st_mtime_ns] if path else None
    key = json.dumps({"events": events, "style": edit["style"], "files": stamps}, ensure_ascii=False, sort_keys=True)
    frames = work / "frames"
    done = work / "layer.key"
    if done.is_file() and done.read_text(encoding="utf-8") == key and (frames / "boxes.json").is_file():
        return frames / "frames.ffconcat"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    (work / "events.json").write_text(json.dumps(events, ensure_ascii=False), encoding="utf-8")
    (work / "spec.json").write_text(json.dumps(edit["style"], ensure_ascii=False), encoding="utf-8")
    cmd = ["node", str(TEMPLATE / "render-frames.mjs"), str(work / "events.json"), str(work / "spec.json"), str(frames),
           "--root", str(job.root), "--root", str(REPO)]
    if FONTS.is_dir():
        cmd += ["--fonts", str(FONTS)]
    try:  # ~0,15 с на состояние; потолок — чтобы зависший браузер не держал рутину вечно
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=max(600, 2 * len(events)))
    except subprocess.TimeoutExpired as err:
        raise RenderError(f"слой не уложился в {err.timeout:.0f} с — браузер завис?") from None
    except FileNotFoundError:
        raise RenderError("нет node: слой рисует Chromium через Node 22 — запустите setup/cloud-setup.sh") from None
    if proc.returncode != 0:
        raise RenderError(f"слой не нарисован (код {proc.returncode}): {proc.stderr.strip()[-2000:]}")
    done.write_text(key, encoding="utf-8")
    return frames / "frames.ffconcat"


def _cut(tl: Timeline, has_audio: bool) -> list[str]:
    """Отрезки keep встык: картинка — по целым кадрам, звук — те же границы в отсчётах, с фейдами 10 мс.

    Исходник читается один раз и раздаётся отрезкам через split/asplit: каждый trim отбрасывает чужие кадры сразу.
    Если бы каждый trim брал `[0:v]` сам, ffmpeg держал бы в памяти кадры для отрезков, до которых concat ещё
    не дошёл (≈3 МБ на кадр 1080×1920 — гигабайты на минутном ролике)."""
    segments = tl.segments
    chains = [f"[0:v]split={len(segments)}" + "".join(f"[sv{i}]" for i in range(len(segments)))]
    if has_audio:
        chains.append(f"[0:a]asplit={len(segments)}" + "".join(f"[sa{i}]" for i in range(len(segments))))
    pads = []
    for i, (start, end, _) in enumerate(segments):
        f0, f1 = round(start * FPS), round(end * FPS)
        length = (f1 - f0) / FPS
        chains.append(f"[sv{i}]trim=start_frame={f0}:end_frame={f1},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            a0, a1 = f0 * RATE // FPS, f1 * RATE // FPS
            chains.append(
                f"[sa{i}]atrim=start_sample={a0}:end_sample={a1},asetpts=PTS-STARTPTS,"
                f"afade=t=in:d={FADE}:curve=tri,afade=t=out:st={max(0.0, length - FADE):.6f}:d={FADE}:curve=tri[a{i}]"
            )
        else:
            chains.append(f"aevalsrc=0|0:s={RATE}:d={length:.6f}[a{i}]")
        pads.append(f"[v{i}][a{i}]")
    chains.append(f"{''.join(pads)}concat=n={len(pads)}:v=1:a=1[vc][ac]")
    return chains


def look_windows(edit: dict, tl: Timeline) -> list[tuple[int, int]]:
    """Ч/б-куски (`edit.looks`) — кадры финала `(первый, после последнего)`: фраза на своём месте и её копия в тизере,
    если она туда попала. Кусок без кадров (весь в вырезке, нулевой) не нужен."""
    windows = []
    for look in edit.get("looks") or []:
        t0, t1 = float(look["t0"]), float(look["t1"])
        spans = [(tl.to_final_snap(t0), tl.to_final_snap(t1))]
        if tl.teaser and max(t0, tl.teaser[0]) < min(t1, tl.teaser[1]):
            spans.append((tl.teaser_final(max(t0, tl.teaser[0])), tl.teaser_final(min(t1, tl.teaser[1]))))
        for a, b in spans:
            first, after = round(a * FPS), round(b * FPS)
            if after > first:
                windows.append((first, after))
    return windows


def looks_filter(edit: dict, tl: Timeline) -> str:
    """Фильтр ч/б-кусков во времени финала (ставится после ускорения и fps=30): включён на своих кадрах — границы
    посередине между кадрами, как у перебивок; кусков нет — пустая строка."""
    windows = look_windows(edit, tl)
    if not windows:
        return ""
    enable = "+".join(f"gte(t,{(a - 0.5) / FPS:.6f})*lt(t,{(b - 0.5) / FPS:.6f})" for a, b in windows)
    return ",".join(f"{f}:enable='{enable}'" for f in BW)


def _picture(job, edit, tl, info, index, hold, missing, warnings) -> tuple[list[str], list[str], set[int]]:
    """Ускорение, цвет, ч/б-куски, зум, фон, перебивки, стоп-кадр → `[vh]`; плюс входы для перебивок и номера перебивок,
    которых в ролике не будет (файла нет, не читается, начало после конца) — их звук не нужен."""
    chains = []
    inputs: list[str] = []
    chain = f"[vc]setpts=PTS/{edit['speed']:g},fps={FPS},{COLOR}"
    looks = looks_filter(edit, tl)
    if looks:
        chain += f",{looks}"
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
    skipped: set[int] = set()
    for i, first, after in insert_spans(edit, tl):
        ins = inserts[i]
        if ins["kind"] != "fullscreen":
            continue
        seconds = min(after / FPS, tl.duration) - first / FPS
        if seconds <= 0:  # начинается после конца ролика
            skipped.add(i)
            continue
        path = _resolve(job, ins.get("src"))
        if path is None:
            missing.append(f"нет файла перебивки {ins.get('src')} — ролик без неё")
            skipped.add(i)
            continue
        try:
            hdr = probe(path).hdr
        except MediaError:
            hdr = None
        if hdr is None or not _decodes(path):
            missing.append(f"файл перебивки {ins.get('src')} не читается — ролик без неё")
            skipped.add(i)
            continue
        suffix = path.suffix.lower()
        if suffix in IMAGES:
            inputs += ["-loop", "1", "-framerate", str(FPS)]
        elif suffix in LOOPED:
            inputs += ["-stream_loop", "-1"]
        inputs += ["-t", f"{seconds:.6f}", "-i", str(path)]
        # HDR (HLG/PQ с телефона) — в SDR так же, как исходник в normalize; остальное — из своей матрицы в BT.709
        color = HDR_TO_SDR if hdr else f"{TO_709},format=yuv420p"
        # после fps=30 шаг времени — 1/30 с: +first ставит первый кадр перебивки ровно на кадр first финала
        chains.append(
            f"[{index}:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},"
            f"{color},setpts=PTS-STARTPTS+{first}[fs{i}]"
        )
        # границы окна — посередине между кадрами: кадр first виден, кадр after — уже нет, без ошибок округления
        a, b = (first - 0.5) / FPS, (after - 0.5) / FPS
        chains.append(f"{current}[fs{i}]overlay=0:0:enable='gte(t,{a:.6f})*lt(t,{b:.6f})'[vf{i}]")
        current = f"[vf{i}]"
        index += 1

    if hold > 0:
        chains.append(f"{current}tpad=stop_mode=clone:stop_duration={hold:.6f}[vh]")
    else:
        chains.append(f"{current}null[vh]")
    return chains, inputs, skipped


def _card_seconds(edit: dict) -> float:
    """Секунды финальной карточки (`edit.end`); её нет — 0."""
    card = edit.get("end") or None
    return float(card["seconds"]) if card else 0.0


def _decodes(path: Path) -> bool:
    """Из файла декодируется хотя бы один кадр. Битая картинка с `-loop 1` или GIF без кадров по кругу иначе
    вешают ffmpeg до таймаута (ffprobe такой GIF пропускает)."""
    try:
        done = subprocess.run(
            ["ffmpeg", "-hide_banner", "-v", "error", "-nostdin", "-i", str(path), "-frames:v", "1", "-vf", "scale=2:2",
             "-f", "rawvideo", "-pix_fmt", "gray", "-"],
            capture_output=True, check=False, timeout=120,
        )
    except subprocess.TimeoutExpired:
        return False
    return done.returncode == 0 and len(done.stdout) > 0


def _layers(style: dict, tl: Timeline) -> list[str]:
    """Слой PNG поверх кадра, затем шкала времени: ширина 1080·t/D, на стоп-кадре — полная."""
    bar = style["bar"]
    height = max(1, round(bar["height"]))
    height += height % 2  # в yuv420p overlay ставит картинку с чётной строки: нечётная полоса не дошла бы до края
    y = 0 if bar["pos"] == "top" else H - height
    color = style["colors"]["bar"].lstrip("#")
    return [
        f"[1:v]fps={FPS},format=rgba,{TO_709},format=yuva420p[ov]",
        "[vh][ov]overlay=0:0:eof_action=pass[vo]",
        f"color=c=0x{color}:s={W}x{height}:r={FPS},format=rgb24,{TO_709},format=yuv420p[barsrc]",
        f"[vo][barsrc]overlay=x='-w+w*min(1,t/{tl.duration:.6f})':y={y}:shortest=1,format=yuv420p[vout]",
    ]


def _sounds(job: Job, edit: dict, tl: Timeline, skip: set[int]) -> tuple[list, dict | None, list[str]]:
    """Звуки появления вставок (время финала, файл) — кроме вставок `skip`, которых в ролике нет, — и музыка.
    Файлы — только из папки задачи или репозитория; ненайденные — в заметках (третий элемент)."""
    inserts = edit.get("inserts") or []
    sfx, notes = [], []
    silent = False  # есть вставка без своего звука
    for i, first, _ in insert_spans(edit, tl):
        name = inserts[i].get("sfx")
        if i in skip:
            continue
        if not name:
            silent = True
            continue
        path = _resolve(job, name)
        if path is None:
            notes.append(f"нет звука {name} — вставка {i + 1} без звука появления")
        else:
            sfx.append((first / FPS, path))
    if silent and not (SFX.is_dir() and any(p.suffix.lower() in SOUNDS for p in SFX.iterdir())):
        notes.append("в assets/sfx нет звуков — вставки без звука появления")
    teaser = edit.get("teaser") or None
    if teaser and teaser.get("sfx") and tl.teaser:  # звук на стыке тизера с началом ролика
        path = _resolve(job, teaser["sfx"])
        if path is None:
            notes.append(f"нет звука {teaser['sfx']} — тизер без звука на стыке")
        else:
            sfx.append((tl.teaser_duration, path))
    card = edit.get("end") or None
    if card and card.get("sfx"):  # звук появления карточки — сразу после стоп-кадра
        path = _resolve(job, card["sfx"])
        if path is None:
            notes.append(f"нет звука {card['sfx']} — финальная карточка без звука появления")
        else:
            sfx.append((tl.duration + float(edit.get("hold") or 0.0), path))
    music = edit.get("music")
    if music:
        path = _resolve(job, music["file"])
        if path is None:
            notes.append(f"нет музыки {music['file']} — ролик без неё")
            music = None
        else:
            music = {"file": str(path), "gainDb": music["gainDb"]}
    return sfx, music, notes


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
        "-c:v", "libx264", "-crf", "18", "-preset", preset, "-bf", "0", "-pix_fmt", "yuv420p", "-r", str(FPS),
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
        "-c:a", "aac", "-b:a", "192k", "-ar", str(RATE), "-movflags", "+faststart", "-use_editlist", "0",
    ]


def _ffmpeg(args: list[str], timeout: float) -> None:
    """ffmpeg с потолком времени: зависший (например, на битом файле) не держит рутину вечно."""
    try:
        proc = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *args],
                              capture_output=True, text=True, check=False, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RenderError(f"ffmpeg не уложился в {timeout:.0f} с — остановлен") from None
    except FileNotFoundError:
        raise RenderError("нет ffmpeg — запустите setup/cloud-setup.sh") from None
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-15:])
        raise RenderError(f"ffmpeg не собрал ролик (код {proc.returncode}):\n{tail}")
