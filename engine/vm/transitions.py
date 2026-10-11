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
Вспышка и смаз включены только в своём окне (`enable`): остальные кадры они не трогают и не считают, формат кадра
(yuv420p) не меняется.
Субтитры, хук, вставки и шкала — поверх перехода: слой накладывается после. Звук `sfx` (свуш) начинается вместе с
переходом. У самого начала и конца ролика перехода нет (сцены до или после нет); чаще раза в 3 с — предупреждение.
"""
from dataclasses import dataclass
from itertools import pairwise

from .timeline import Timeline

HALF = 0.12  # с — половина перехода: до стыка и после
MIN_GAP = 3.0  # с — правило: переходы не чаще раза в 3 с
PUNCH = 0.25  # толчок зума: на стыке картинка крупнее в 1,25 раза
BLUR = ((8, 1.0), (14, 2 / 3), (24, 1 / 3))  # смаз ступенями: sigma gblur по x, px, и доля полуокна — у стыка сильнее


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
    items = [Mark(tl.to_final_snap(float(x["t"])), x["kind"], x.get("sfx") or None, float(x["t"])) for x in edit.get("transitions") or []]
    return sorted(items, key=lambda m: (m.t, m.source))


def _fits(m: Mark, tl: Timeline) -> bool:
    return HALF <= m.t <= tl.duration - HALF


def marks(edit: dict, tl: Timeline) -> list[Mark]:
    """Переходы edit.json во времени финала, по порядку; у самого начала и конца ролика — без них."""
    return [m for m in _placed(edit, tl) if _fits(m, tl)]


def warnings(edit: dict, tl: Timeline) -> list[str]:
    """Что сказать Claude: переход у начала или конца ролика пропал, переходы чаще раза в 3 с."""
    lines = [f"переход на {_sec(m.t)} с — в самом начале или конце ролика, сцены до или после нет: его не будет"
             for m in _placed(edit, tl) if not _fits(m, tl)]
    kept = marks(edit, tl)
    for a, b in pairwise(kept):
        if b.t - a.t < MIN_GAP - 1e-6:
            lines.append(f"переходы на {_sec(a.t)} с и {_sec(b.t)} с — ближе {MIN_GAP:g} с друг к другу: оставь один "
                         f"(правило — не чаще раза в {MIN_GAP:g} с)")
    return lines


def _window(a: float, b: float) -> str:
    return f"enable='between(t,{a:.6f},{b:.6f})'"


def picture_chains(items: list[Mark], src: str, out: str, size: tuple[int, int], fps: int) -> list[str]:
    """Цепочки filter_complex от `src` к `out` со вспышками и смазами (время финала — `t` кадра), каждый — только в своём
    окне; толчок зума рисует `zoom_filter`. Таких переходов нет — пусто: `out` не нужен."""
    effects = [m for m in items if m.kind in ("flash", "blur")]
    chains, current = [], src
    for i, m in enumerate(effects):
        label = out if i == len(effects) - 1 else f"[tr{i}]"
        a, b = m.t - HALF, m.t + HALF
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
