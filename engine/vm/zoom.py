"""Зумы по смыслу: ступени приближения исходника во времени финала.

`edit.zooms` — `[{t, level, over?}]`: с момента `t` (время исходника) приближение переходит к `level` за `over`
секунд финала (smoothstep `3x² − 2x³`; нет `over` — 0,45 с). Уровни зума по смыслу обрезаются до `[1.0, 1.16]`
(Павел попросил вдвое ближе, чем было: 1.08). Смены крупности стиля эталона — ступени со своим `over` — до `1.3`:
`over: 0` — резкая смена плана (общий ↔ крупный на стыке фраз): уровень меняется в кадре `t`, а если `t` не дальше
0,25 с исходника после начала отрезка `keep` — ровно на стыке отрезков, чтобы кадр не прыгал дважды; `over` в несколько
секунд — медленный наезд внутри плана. До первой ступени — 1.0. Новая ступень посреди перехода начинается с того
уровня, который уже был, — без скачка. Зумятся только кадры исходника: субтитры, хук и шкала накладываются после.
Исходник — 1080×1920, так что ×1,3 — это увеличение кадра (чуть мягче).

`zoom_filter` даёт фильтр ffmpeg с тем же уровнем: `fps=30`, затем `zoompan` с выходом исходного размера, один кадр
на кадр, окно приближения стоит так, что точка лица остаётся на месте. Фильтр работает во времени финала (`it` —
время входного кадра), поэтому его ставят после склейки и ускорения. zoompan нумерует выходные кадры сам, по
своей частоте, — поэтому вход сначала приводится к 30 к/с: иначе 25 к/с растянулись бы, а ускорение отменилось.
zoompan не переносит метки цвета — их ставит кодирование финала (BT.709). (`scale` с размером на каждом кадре +
`crop` с `x=fx*(iw-1080)` не работает: `iw`/`ih` в выражениях crop фиксируются при настройке фильтра, и окно
стоит в углу.)

Толчок зума перехода на смене сцены (`punches` — стыки, время финала) — множитель поверх ступеней:
`1 + PUNCH·(1 − |t − стык|/HALF)²` в окне ±HALF вокруг стыка (`transitions`), вне окна — 1.
"""
from collections.abc import Iterable, Sequence

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
    """Момент финала, с которого действует ступень: резкая смена рядом после стыка — на стыке (`Timeline.to_cut`)."""
    t = float(z["t"])
    return tl.to_cut(t) if "over" in z and float(z["over"]) == 0 else tl.to_final_snap(t)


def _target(z: dict) -> float:
    top = MAX_SHOT if "over" in z else MAX_LEVEL
    return min(top, max(MIN_LEVEL, float(z["level"])))


def _steps(zooms: Iterable[dict], tl: Timeline, trans: float) -> list[Step]:
    """Ступени по времени; `trans` — переход ступеней без своего `over`."""
    if not trans > 0:
        raise ValueError(f"trans must be positive, got {trans!r}")
    # в один момент финала могут попасть несколько ступеней (момент в вырезке встаёт на начало отрезка): тогда
    # действует та, что позже в исходнике
    marks = sorted(
        ((_start(z, tl), float(z["t"]), _target(z), max(0.0, float(z.get("over", trans)))) for z in zooms),
        key=lambda m: (m[0], m[1]),
    )
    steps: list[Step] = []
    for start, _, target, over in marks:
        steps.append((start, _level(steps, start), target, over))
    return steps


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
                punches: Sequence[float] = ()) -> str:
    """Фильтр ffmpeg: приближение по `zooms` с якорем в точке лица `face` (доли кадра) и толчки переходов на стыках
    `punches` (время финала); без зумов и толчков — `null`."""
    steps = [s for s in _steps(zooms, tl, TRANS) if s[0] < tl.duration]
    flat = not steps or all(source == target == MIN_LEVEL for _, source, target, _ in steps)
    if flat and not punches:
        return "null"
    if len(steps) > MAX_STEPS:
        raise ValueError(f"слишком много зумов: {len(steps)} (не больше {MAX_STEPS})")
    z = "1" if flat else _expression(steps)
    if punches:
        z = f"({z})*{_punches(punches)}"
    fx = min(1.0, max(0.0, float(face.get("x", 0.5))))
    fy = min(1.0, max(0.0, float(face.get("y", 0.5))))
    # окно iw/zoom × ih/zoom; его левый верхний угол сдвинут так, чтобы точка лица осталась на месте
    x = f"{_num(fx)}*(iw-iw/zoom)"
    y = f"{_num(fy)}*(ih-ih/zoom)"
    return f"fps={fps},zoompan=z='{z}':x='{x}':y='{y}':d=1:s={W}x{H}:fps={fps}"
