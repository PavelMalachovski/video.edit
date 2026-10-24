"""Зумы по смыслу: ступени приближения исходника во времени финала.

`edit.zooms` — `[{t, level, over?}]`: с момента `t` (время исходника) приближение переходит к `level` за `over`
секунд финала (smoothstep `3x² − 2x³`; нет `over` — 0,45 с). Уровни зума по смыслу обрезаются до `[1.0, 1.16]`
(Павел попросил вдвое ближе, чем было: 1.08). Смены крупности стиля эталона — ступени со своим `over` — до `1.3`:
`over: 0` — резкая смена плана (общий ↔ крупный на стыке фраз): уровень меняется с кадра, где виден момент `t`
(`media.cut_frame` — так же встают склейка и ч/б), а если `t` не дальше 0,25 с исходника от края отрезка `keep` — ровно
на склейке, чтобы кадр не прыгал дважды; `over` в несколько секунд — медленный наезд внутри плана. До первой ступени — 1.0. Новая ступень посреди перехода начинается с того
уровня, который уже был, — без скачка. Зумятся только кадры исходника: субтитры, хук и шкала накладываются после.
Исходник — 1080×1920, так что ×1,3 — это увеличение кадра (чуть мягче).

`zoom_filter` даёт фильтр ffmpeg с тем же уровнем: `fps=30`, затем `perspective` — окно приближения (iw/z × ih/z, стоит
так, что точка лица остаётся на месте) растягивается на весь кадр с точностью до 1/256 пикселя, бикубически. Фильтр
работает во времени финала: время кадра — (`in` − 1) / 30 (perspective считает кадры с 1) (поток после склейки и ускорения начинается с 0),
поэтому вход сначала приводится к 30 к/с. Где приближения нет (уровень 1), фильтр выключен (`enable`) и не тратит
время. (Прежде был `zoompan`: он ставит окно на целые пиксели, и медленный наезд — меньше пикселя за кадр — шёл
рывками, точка у края кадра прыгала на ±2 px; Павел, 24.10.2026: «обрывчато». `scale` с размером на каждом кадре +
`crop` не работает: `iw`/`ih` в выражениях crop фиксируются при настройке фильтра.)

Толчок зума перехода на смене сцены (`punches` — стыки, время финала) — множитель поверх ступеней:
`1 + PUNCH·(1 − |t − стык|/HALF)²` в окне ±HALF вокруг стыка (`transitions`), вне окна — 1.
"""
from collections.abc import Iterable, Sequence

from .media import FPS, cut_frame
from .timeline import Timeline
from .transitions import HALF, PUNCH

TRANS = 0.45  # с — длина перехода по умолчанию
MIN_LEVEL = 1.0
MAX_LEVEL = 1.16  # зум по смыслу
MAX_SHOT = 1.3  # смена крупности и наезд (ступень со своим `over`)
MAX_STEPS = 90  # вложенных if в выражении ffmpeg больше ~95 не разбирает

Step = tuple[float, float, float, float]  # (начало в финале, уровень на старте, целевой уровень, длина перехода)


def _smooth(x: float) -> float:
    return 3 * x * x - 2 * x * x * x


def _start(z: dict, tl: Timeline) -> float:
    """Момент финала, с которого действует ступень. Резкая смена — на границе перед кадром, где её видно
    (`cut_frame`, как у склейки и ч/б), а рядом со стыком — на стыке (`Timeline.to_cut`)."""
    t = float(z["t"])
    if "over" in z and float(z["over"]) == 0:
        return (cut_frame(tl.to_cut(t)) - 0.5) / FPS
    return tl.to_final_snap(t)


def _target(z: dict) -> float:
    top = MAX_SHOT if "over" in z else MAX_LEVEL
    return min(top, max(MIN_LEVEL, float(z["level"])))


def _steps(zooms: Iterable[dict], tl: Timeline, trans: float) -> list[Step]:
    """Ступени по времени; `trans` — переход ступеней без своего `over`."""
    if not trans > 0:
        raise ValueError(f"trans must be positive, got {trans!r}")
    # в один момент финала могут попасть несколько ступеней (момент в вырезке встаёт на начало отрезка): тогда
    # действует та, что позже в исходнике
    zooms = list(zooms)
    marks = [(_start(z, tl), 1, float(z["t"]), _target(z), max(0.0, float(z.get("over", trans)))) for z in zooms]
    marks += _run_marks(zooms, tl, trans)
    steps: list[Step] = []
    for start, _, _, target, over in sorted(marks, key=lambda m: m[:3]):
        steps.append((start, _level(steps, start), target, over))
    return steps


def _run_marks(zooms: list[dict], tl: Timeline, trans: float) -> list[tuple[float, int, float, float, float]]:
    """Куски переставлены руками: в начале каждой серии кусков — крупность, какая у её первого момента по порядку
    исходника (иначе переставленный кусок взял бы крупность того, что стоит перед ним). По порядку — ничего."""
    starts, last = [], None
    for src0, src1, t0 in tl.segments[1 if tl.teaser else 0:]:
        run = tl.run_of((src0 + src1) / 2)
        if run != last:
            starts.append((t0, src0))
        last = run
    if len(starts) < 2 or not zooms:
        return []
    plain = tl.in_source_order()
    levels = _steps(zooms, plain, trans)
    return [(t0, 0, src0, _level(levels, plain.to_final_snap(src0)), 0.0) for t0, src0 in starts]


def _level(steps: list[Step], t: float) -> float:
    level = 1.0
    for start, source, target, over in steps:
        if t < start:
            break
        x = (t - start) / over if over > 0 else 1.0
        level = target if x >= 1 else source + (target - source) * _smooth(x)
    return level


def _punch(t: float, punches: Sequence[float]) -> float:
    """Множитель толчков зума переходов в момент `t` финала."""
    return 1 + sum(PUNCH * (1 - abs(t - p) / HALF) ** 2 for p in punches if abs(t - p) < HALF)


def zoom_at(zooms: list[dict], tl: Timeline, t_final: float, trans: float = TRANS, punches: Sequence[float] = ()) -> float:
    """Приближение в момент `t_final` финала (с толчками переходов на стыках `punches`)."""
    return _level(_steps(zooms, tl, trans), t_final) * _punch(t_final, punches)


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


def _expression(steps: list[Step], t: str = "it") -> str:
    """Уровень как выражение ffmpeg от времени `t` (секунды финала): до первой ступени 1, на ступени i —
    переход от её стартового уровня к целевому (резкая смена — сразу целевой), затем целевой, пока не начнётся
    ступень i + 1."""

    def piece(start: float, source: float, target: float, over: float) -> str:
        if over <= 0:
            return _num(target)
        x = f"({t}-{_num(start)})/{_num(over)}"
        ramp = f"{_num(source)}+{_num(target - source)}*(3*pow({x},2)-2*pow({x},3))"
        return f"if(lt({t},{_num(start + over)}),{ramp},{_num(target)})"

    expr = piece(*steps[-1])
    for i in range(len(steps) - 2, -1, -1):
        expr = f"if(lt({t},{_num(steps[i + 1][0])}),{piece(*steps[i])},{expr})"
    return f"if(lt({t},{_num(steps[0][0])}),1,{expr})"


def _punches(punches: Sequence[float], t: str = "it") -> str:
    """Множитель толчков как выражение ffmpeg: сумма горбов в окнах стыков."""
    bumps = [f"if(lt(abs({t}-{_num(p)}),{_num(HALF)}),{_num(PUNCH)}*pow(1-abs({t}-{_num(p)})/{_num(HALF)},2),0)" for p in punches]
    return f"(1+{'+'.join(bumps)})"


def zoom_filter(zooms: list[dict], tl: Timeline, face: dict, W: int = 1080, H: int = 1920, fps: int = 30,
                punches: Sequence[float] = ()) -> str:  # W, H — размер кадра; perspective берёт его со входа
    """Фильтр ffmpeg: приближение по `zooms` с якорем в точке лица `face` (доли кадра) и толчки переходов на стыках
    `punches` (время финала); без зумов и толчков — `null`."""
    steps = [s for s in _steps(zooms, tl, TRANS) if s[0] < tl.duration]
    flat = not steps or all(source == target == MIN_LEVEL for _, source, target, _ in steps)
    if flat and not punches:
        return "null"
    if len(steps) > MAX_STEPS:
        raise ValueError(f"слишком много зумов: {len(steps)} (не больше {MAX_STEPS})")
    def level(t: str) -> str:
        z = "1" if flat else _expression(steps, t)
        return f"(({z})*{_punches(punches, t)})" if punches else f"({z})"

    z = level(f"(in-1)/{fps}")  # perspective считает кадры с 1
    fx = min(1.0, max(0.0, float(face.get("x", 0.5))))
    fy = min(1.0, max(0.0, float(face.get("y", 0.5))))
    # окно W/z × H/z; его левый верхний угол сдвинут так, чтобы точка лица осталась на месте; углы окна → углы кадра
    x0, y0 = f"{_num(fx)}*(W-W/{z})", f"{_num(fy)}*(H-H/{z})"
    x1, y2 = f"{x0}+W/{z}", f"{y0}+H/{z}"
    corners = f"x0='{x0}':y0='{y0}':x1='{x1}':y1='{y0}':x2='{x0}':y2='{y2}':x3='{x1}':y3='{y2}'"
    # enable считает по времени кадра `t`: на уровне 1 кадр проходит как есть
    return (f"fps={fps},perspective={corners}:interpolation=cubic:eval=frame"
            f":enable='gt({level('t')},1.000001)'")
