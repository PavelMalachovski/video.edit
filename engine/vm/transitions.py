"""Переходы на смене сцены (гайд Meta «Всё о Reels»; решение Павла — только там, где сцена меняется).

`edit.transitions` — `[{t, kind, sfx}]`: `t` — время исходника, где начинается новая сцена (резкая смена кадра из
`cuts.json.joins` или вырезка, за которой другое место или план); в финале — `Timeline.to_final_snap(t)`: вырезанный
момент встаёт на начало следующего отрезка, с тизером — на своё место после него. Переход длится 0,24 с — по 0,12 с до
стыка и после:
- `flash` — белая вспышка: кадр выбеливается к стыку и проявляется после — поверх белый кадр, прозрачность которого
  меняется по времени (`fade` его альфы); `fade` с цветом white не годится: он работает только в RGB, и ffmpeg перегнал
  бы через RGB весь ролик;
- `zoom` — толчок зума: картинка резко приближается к стыку (×1,25) и отъезжает после; это множитель к зуму по смыслу
  (`zoom_filter`, якорь тот же — лицо);
- `blur` — смаз: горизонтальное размытие (`gblur` только по x), сильнее всего на стыке; `dblur` на пике давал полосы и
  бурую кашу из цветов.
- `tear` — рваная бумага (формат «Разбор персонажа»): только на входе в перебивку на весь кадр, `TEAR` кадров до её
  первого кадра — кадр рвётся сверху донизу, щель расходится, в ней — перебивка в ч/б с растром (картинки — vm/tear.py,
  накладывает их `render._tears`); стык — первый кадр перебивки (`tears`: она ближе TEAR кадров к `t`);
- `glitch` — глитч: кадр до стыка, сам стык и кадр после горизонтальные полосы кадра сдвинуты вбок (`GLITCH`).
Вспышка и смаз включены только в своём окне (`enable`): остальные кадры они не трогают и не считают, формат кадра
(yuv420p) не меняется. Что они делают с кадром n финала, по кадрам (замерено на ffmpeg), — `flash_alpha` и
`blur_sigma`: их повторяет превью редактора (web/lib/zoom.ts, общая фикстура overlay-events.json).
Субтитры, хук, вставки и шкала — поверх перехода: слой накладывается после. Звук `sfx` (свуш) начинается вместе с
переходом. У самого начала и конца ролика перехода нет (сцены до или после нет); чаще раза в 3 с — предупреждение.
"""
import math
from dataclasses import dataclass
from itertools import pairwise

from .overlay import insert_spans
from .timeline import Timeline

HALF = 0.12  # с — половина перехода: до стыка и после
MIN_GAP = 3.0  # с — правило: переходы не чаще раза в 3 с
PUNCH = 0.25  # толчок зума: на стыке картинка крупнее в 1,25 раза
BLUR = ((8, 1.0), (14, 2 / 3), (24, 1 / 3))  # смаз ступенями: sigma gblur по x, px, и доля полуокна — у стыка сильнее
FPS = 30
TEAR = 9  # кадров рваной бумаги до стыка (0,3 с); картинки этих кадров — vm/tear.py
# глитч: полосы (y0, y1, сдвиг по x), px кадра 1080×1920 — на кадре до стыка, на стыке и после; всё кратно 10: overlay в
# yuv420p ставит только на чётные пиксели, а кадр в 5 раз меньше (тесты) — тоже чётные
GLITCH = (
    ((620, 700, 50), (1180, 1230, -40)),
    ((300, 420, -70), (760, 900, 60), (1400, 1460, 30)),
    ((980, 1060, -40),),
)


@dataclass(frozen=True)
class Mark:
    """Переход в финале: `t` — стык (время финала), `source` — его `t` из edit.json."""

    t: float
    kind: str
    sfx: str | None
    source: float


def _sec(t: float) -> str:
    return f"{t:.1f}".replace(".", ",")


def _placed(edit: dict, tl: Timeline) -> list[Mark]:
    items = [Mark(tl.to_final_snap(float(x["t"])), x["kind"], x.get("sfx") or None, float(x["t"]))
             for x in edit.get("transitions") or [] if not x.get("off")]  # убранный Павлом в редакторе — не в ролике
    return sorted(items, key=lambda m: (m.t, m.source))


def lead(kind: str) -> float:
    """Сколько секунд переход идёт до стыка: с этого места — и его звук."""
    return TEAR / FPS if kind == "tear" else 1 / FPS if kind == "glitch" else HALF


def _tail(kind: str) -> float:
    return 0.0 if kind == "tear" else (len(GLITCH) - 1) / FPS if kind == "glitch" else HALF


def _fits(m: Mark, tl: Timeline) -> bool:
    return lead(m.kind) <= m.t <= tl.duration - _tail(m.kind)


def marks(edit: dict, tl: Timeline) -> list[Mark]:
    """Переходы edit.json во времени финала, по порядку; у самого начала и конца ролика — без них."""
    return [m for m in _placed(edit, tl) if _fits(m, tl)]


def warnings(edit: dict, tl: Timeline) -> list[str]:
    """Что сказать Claude: переход у начала или конца ролика пропал, переходы чаще раза в 3 с."""
    lines = [f"переход на {_sec(m.t)} с — в самом начале или конце ролика, сцены до или после нет: его не будет"
             for m in _placed(edit, tl) if not _fits(m, tl)]
    kept = marks(edit, tl)
    bound = {t.mark for t in tears(edit, tl)}
    lines += [f"рваная бумага на {_sec(m.t)} с — не на входе в перебивку: её не будет (ставь её на начало перебивки)"
              for m in kept if m.kind == "tear" and m not in bound]
    for a, b in pairwise(kept):
        if b.t - a.t < MIN_GAP - 1e-6:
            lines.append(f"переходы на {_sec(a.t)} с и {_sec(b.t)} с — ближе {MIN_GAP:g} с друг к другу: оставь один "
                         f"(правило — не чаще раза в {MIN_GAP:g} с)")
    return lines


@dataclass(frozen=True)
class Tear:
    """Рваная бумага: переход, перебивка (номер в edit.inserts), в которую он открывается, и её первый кадр — стык."""

    mark: Mark
    insert: int
    join: int


def tears(edit: dict, tl: Timeline) -> list[Tear]:
    """Рваная бумага, у которой есть перебивка на весь кадр, начинающаяся ближе TEAR кадров к стыку (доли музыки могли
    сдвинуть перебивку): стык — её первый кадр; ближайшая, при равенстве — раньше по номеру."""
    inserts = edit.get("inserts") or []
    starts = [(start, i) for i, start, _ in insert_spans(edit, tl)  # в клип в окошке разрыв не ведёт: кадр остаётся
              if inserts[i]["kind"] == "fullscreen" and inserts[i].get("layout") != "window"]
    found = []
    for m in marks(edit, tl):
        if m.kind != "tear":
            continue
        frame = round(m.t * FPS)
        near = [(abs(start - frame), i, start) for start, i in starts if abs(start - frame) < TEAR and start >= TEAR]
        if near:
            _, i, start = min(near)
            found.append(Tear(m, i, start))
    return found


def sound_starts(edit: dict, tl: Timeline) -> list[tuple[Mark, float]]:
    """Переходы ролика и когда начинается каждый (с этого места — его звук): разрыв — за TEAR кадров до своей перебивки,
    без перебивки его нет; остальные — за `lead` до стыка."""
    torn = {x.mark: (x.join - TEAR) / FPS for x in tears(edit, tl)}
    return [(m, torn[m]) if m.kind == "tear" else (m, max(0.0, m.t - lead(m.kind)))
            for m in marks(edit, tl) if m.kind != "tear" or m in torn]


def tear_frame(join: int, n: int) -> int | None:
    """Какой кадр рваной бумаги (0..TEAR−1) на кадре n финала со стыком `join`; не в её окне — None."""
    k = n - (join - TEAR)
    return k if 0 <= k < TEAR else None


def glitch_bands(join: int, n: int) -> list[tuple[int, int, int]]:
    """Полосы глитча со стыком на кадре `join` на кадре n финала; не в его окне — пусто."""
    k = n - join + 1
    return list(GLITCH[k]) if 0 <= k < len(GLITCH) else []


def _window(a: float, b: float) -> str:
    return f"enable='between(t,{a:.6f},{b:.6f})'"


def picture_chains(items: list[Mark], src: str, out: str, size: tuple[int, int], fps: int) -> list[str]:
    """Цепочки filter_complex от `src` к `out` со вспышками, смазами и глитчами (время финала — `t` кадра), каждый — только
    в своём окне; толчок зума рисует `zoom_filter`, рваную бумагу — `render._tears`. Таких переходов нет — пусто: `out`
    не нужен."""
    effects = [m for m in items if m.kind in ("flash", "blur", "glitch")]
    chains, current = [], src
    for i, m in enumerate(effects):
        label = out if i == len(effects) - 1 else f"[tr{i}]"
        a, b = m.t - HALF, m.t + HALF
        if m.kind == "glitch":  # полосы кадра — копией со сдвигом, каждая на своём кадре (края — посередине между кадрами)
            join = round(m.t * fps)
            w, h = size
            bands = [(join - 1 + k, band) for k, frame_bands in enumerate(GLITCH) for band in frame_bands]
            for j, (n, (y0, y1, dx)) in enumerate(bands):
                y, height, shift = round(y0 * h / 1920), round((y1 - y0) * h / 1920), round(dx * w / 1080)
                step = label if j == len(bands) - 1 else f"[gl{i}_{j}]"
                chains.append(f"{current}split=2[ga{i}_{j}][gb{i}_{j}]")
                chains.append(f"[gb{i}_{j}]crop={w}:{height}:0:{y}[gc{i}_{j}]")
                chains.append(f"[ga{i}_{j}][gc{i}_{j}]overlay=x={shift}:y={y}:"
                              f"enable='between(t,{(n - 0.5) / fps:.6f},{(n + 0.5) / fps:.6f})'{step}")
                current = step
            continue
        if m.kind == "flash":  # белый кадр: альфа 0 → 255 к стыку → 0; метки времени — финала, с начала окна
            chains.append(
                f"color=c=white:s={size[0]}x{size[1]}:r={fps}:d={2 * HALF + 1 / fps:.6f},format=yuva420p,"
                f"fade=t=in:st=0:d={HALF:.6f}:alpha=1,fade=t=out:st={HALF:.6f}:d={HALF:.6f}:alpha=1,"
                f"setpts=PTS-STARTPTS+{a:.6f}/TB[fl{i}]"
            )
            chains.append(f"{current}[fl{i}]overlay=0:0:{_window(a, b)}{label}")
        else:
            steps = (f"gblur=sigma={sigma}:sigmaV=0:{_window(m.t - HALF * share, m.t + HALF * share)}" for sigma, share in BLUR)
            chains.append(f"{current}{','.join(steps)}{label}")
        current = label
    return chains


def _read(x: float) -> float:
    """Число, которое ffmpeg прочтёт там, где picture_chains пишет `x` шестью знаками (края окон, сдвиг белого кадра)."""
    return float(f"{x:.6f}")


def _white(k: int, fps: int) -> int:
    """Альфа (0–255) кадра k белого кадра вспышки после fade in и fade out: ffmpeg переводит их начало и длину (0,12 с) в
    целые кадры (3,6 → 4) и считает целыми числами — 0, 64, 127, 191, 255, 191, 128, 64, 0."""
    frames = round(HALF * fps)
    alpha = 255
    for start, rising in ((0, True), (frames, False)):
        factor = 0 if k < start else 65535 if k >= start + frames else (k - start) * 65535 // frames
        if not rising:
            factor = 65535 - factor
        if factor < 65535:
            alpha = (alpha * factor + 32768) >> 16
    return alpha


def flash_alpha(join: float, n: int, fps: int = 30) -> float:
    """Белизна вспышки со стыком `join` (время финала) на кадре n финала, 0..1 — что делает с ним picture_chains.
    overlay включён, пока время кадра n · (1/fps) в окне стык ± HALF (оба края включительно), и кладёт последний кадр
    белого с меткой не позже n: метка кадра k белого — int(k + a / TB) (setpts отбрасывает дробь; a — начало окна)."""
    a, b = _read(join - HALF), _read(join + HALF)
    if not a <= n * (1 / fps) <= b:
        return 0.0
    shift = a / (1 / fps)
    k = -1
    while math.trunc(k + 1 + shift) <= n:
        k += 1
    return _white(k, fps) / 255 if k >= 0 else 0.0


def blur_sigma(join: float, n: int, fps: int = 30) -> float:
    """Сила смаза со стыком `join` на кадре n финала — sigma по x, px кадра шириной 1080: ступени gblur, чьё окно
    захватывает время кадра n · (1/fps) (оба края включительно); размытия подряд складываются — корень из суммы квадратов."""
    t = n * (1 / fps)
    return math.sqrt(sum(sigma * sigma for sigma, share in BLUR if _read(join - HALF * share) <= t <= _read(join + HALF * share)))
