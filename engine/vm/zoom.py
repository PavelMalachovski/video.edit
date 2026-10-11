"""Зумы по смыслу: ступени приближения исходника во времени финала.

`edit.zooms` — `[{t, level, over?}]`: с момента `t` (время исходника) приближение переходит к `level` за `over`
секунд финала (smoothstep `3x² − 2x³`; нет `over` — 0,45 с). `over: 0` — резкая смена крупности (стиль эталона: общий
план ↔ крупный на стыке фраз): уровень меняется в кадре `t`, а если `t` не дальше 0,25 с исходника после начала
отрезка `keep` — ровно на стыке отрезков, чтобы кадр не прыгал дважды. `over` в несколько секунд — медленный наезд
внутри плана. До первой ступени — 1.0; уровни обрезаются до `[1.0, 1.3]`. Новая ступень посреди перехода начинается
с того уровня, который уже был, — без скачка. Зумятся только кадры исходника: субтитры, хук и шкала накладываются
после. Исходник — 1080×1920, так что ×1,3 — это увеличение кадра (чуть мягче).

`zoom_filter` даёт фильтр ffmpeg с тем же уровнем: `fps=30`, затем `zoompan` с выходом исходного размера, один кадр
на кадр, окно приближения стоит так, что точка лица остаётся на месте. Фильтр работает во времени финала (`it` —
время входного кадра), поэтому его ставят после склейки и ускорения. zoompan нумерует выходные кадры сам, по
своей частоте, — поэтому вход сначала приводится к 30 к/с: иначе 25 к/с растянулись бы, а ускорение отменилось.
zoompan не переносит метки цвета — их ставит кодирование финала (BT.709). (`scale` с размером на каждом кадре +
`crop` с `x=fx*(iw-1080)` не работает: `iw`/`ih` в выражениях crop фиксируются при настройке фильтра, и окно
стоит в углу.)
"""
from collections.abc import Iterable

from .timeline import Timeline

TRANS = 0.45  # с — длина перехода по умолчанию
MIN_LEVEL = 1.0
MAX_LEVEL = 1.3
MAX_STEPS = 90  # вложенных if в выражении ffmpeg больше ~95 не разбирает
TO_CUT = 0.25  # с исходника — резкая смена так близко после начала отрезка встаёт на стык


def _smooth(x: float) -> float:
    return 3 * x * x - 2 * x * x * x


def _start(z: dict, tl: Timeline) -> float:
    """Момент финала, с которого действует ступень: резкая смена рядом после стыка — на стыке."""
    t = float(z["t"])
    if float(z.get("over", TRANS)) == 0:
        for source, _, final in tl.segments:
            if source <= t <= source + TO_CUT and tl.to_final(t) is not None:
                return final
    return tl.to_final_snap(t)


def _steps(zooms: Iterable[dict], tl: Timeline, trans: float) -> list[tuple[float, float, float, float]]:
    """Ступени `(начало в финале, уровень на старте, целевой уровень, длина перехода)` по времени."""
    if not trans > 0:
        raise ValueError(f"trans must be positive, got {trans!r}")
    # в один момент финала могут попасть несколько ступеней (момент в вырезке встаёт на начало отрезка): тогда
    # действует та, что позже в исходнике
    marks = sorted(
        (
            (_start(z, tl), float(z["t"]), min(MAX_LEVEL, max(MIN_LEVEL, float(z["level"]))), max(0.0, float(z.get("over", trans))))
            for z in zooms
        ),
        key=lambda m: (m[0], m[1]),
    )
    steps: list[tuple[float, float, float, float]] = []
    for start, _, target, over in marks:
        steps.append((start, _level(steps, start), target, over))
    return steps


def _level(steps: list[tuple[float, float, float, float]], t: float) -> float:
    level = 1.0
    for start, source, target, over in steps:
        if t < start:
            break
        x = (t - start) / over if over > 0 else 1.0
        level = target if x >= 1 else source + (target - source) * _smooth(x)
    return level


def zoom_at(zooms: list[dict], tl: Timeline, t_final: float, trans: float = TRANS) -> float:
    """Приближение в момент `t_final` финала; `trans` — переход ступеней без своего `over`."""
    return _level(_steps(zooms, tl, trans), t_final)


def _num(v: float) -> str:
    return f"{v:.6f}".rstrip("0").rstrip(".") or "0"


def _expression(steps: list[tuple[float, float, float, float]], t: str = "it") -> str:
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


def zoom_filter(zooms: list[dict], tl: Timeline, face: dict, W: int = 1080, H: int = 1920, fps: int = 30) -> str:
    """Фильтр ffmpeg: приближение по `zooms` с якорем в точке лица `face` (доли кадра); без зумов — `null`."""
    steps = [s for s in _steps(zooms, tl, TRANS) if s[0] < tl.duration]
    if not steps or all(source == target == MIN_LEVEL for _, source, target, _ in steps):
        return "null"
    if len(steps) > MAX_STEPS:
        raise ValueError(f"слишком много зумов: {len(steps)} (не больше {MAX_STEPS})")
    z = _expression(steps)
    fx = min(1.0, max(0.0, float(face.get("x", 0.5))))
    fy = min(1.0, max(0.0, float(face.get("y", 0.5))))
    # окно iw/zoom × ih/zoom; его левый верхний угол сдвинут так, чтобы точка лица осталась на месте
    x = f"{_num(fx)}*(iw-iw/zoom)"
    y = f"{_num(fy)}*(ih-ih/zoom)"
    return f"fps={fps},zoompan=z='{z}':x='{x}':y='{y}':d=1:s={W}x{H}:fps={fps}"
