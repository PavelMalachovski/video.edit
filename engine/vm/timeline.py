"""Шкала времени: как время исходника становится временем финала.

Финал — оставленные отрезки исходника (`keep`), склеенные встык и ускоренные в `speed` раз. Все времена в
`words.json` и `edit.json` — по исходнику; в время финала их переводит только `Timeline`.
"""
import math
from bisect import bisect_right
from collections.abc import Iterable, Sequence


class Timeline:
    """`Timeline(keep, speed)`: `keep` — отрезки исходника `[(начало, конец), ...]` по возрастанию, без пересечений
    (как отдаёт `cuts.plan_keep` и как лежит в edit.json); `speed` — во сколько раз финал быстрее исходника."""

    def __init__(self, keep: Iterable[Sequence[float]], speed: float):
        if not (isinstance(speed, int | float) and math.isfinite(speed) and speed > 0):
            raise ValueError(f"speed must be a positive number, got {speed!r}")
        self._speed = float(speed)
        self._starts: list[float] = []
        self._ends: list[float] = []
        self._played: list[float] = []  # сколько секунд исходника лежит в финале до отрезка
        total = 0.0
        for i, segment in enumerate(keep):
            try:
                start, end = (float(t) for t in segment)
            except (TypeError, ValueError):
                raise ValueError(f"keep[{i}]: expected [start, end], got {segment!r}") from None
            if not (math.isfinite(start) and math.isfinite(end) and end > start):
                raise ValueError(f"keep[{i}]: {segment!r} must be two finite times with the end after the start")
            if self._ends and start < self._ends[-1]:
                raise ValueError(
                    f"keep[{i}]: {segment!r} starts before the previous segment ends ({self._ends[-1]} s); "
                    "segments must be in order and must not overlap"
                )
            self._starts.append(start)
            self._ends.append(end)
            self._played.append(total)
            total += end - start
        self._duration = total / self._speed

    @property
    def duration(self) -> float:
        """Длина финала, с."""
        return self._duration

    @property
    def segments(self) -> list[tuple[float, float, float]]:
        """Оставленные отрезки: `(начало в исходнике, конец в исходнике, начало в финале)`."""
        spans = zip(self._starts, self._ends, self._played, strict=True)
        return [(start, end, played / self._speed) for start, end, played in spans]

    def to_final(self, t: float) -> float | None:
        """Время финала для времени исходника `t`; `None` — это время вырезано. Края отрезков принадлежат отрезку."""
        i = bisect_right(self._starts, t) - 1  # последний отрезок, который начался не позже t
        if i < 0 or t > self._ends[i]:
            return None
        return (self._played[i] + (t - self._starts[i])) / self._speed

    def to_final_snap(self, t: float) -> float:
        """Как `to_final`, но вырезанное время переходит в начало следующего отрезка (после последнего — в конец
        финала): так ставят то, что привязано к моменту, а момент могли вырезать."""
        final = self.to_final(t)
        if final is not None:
            return final
        i = bisect_right(self._starts, t)  # первый отрезок, который начнётся позже t
        return self._played[i] / self._speed if i < len(self._starts) else self._duration

    def to_source(self, t: float) -> float:
        """Время исходника для времени финала `t` (обратное `to_final`; стык отрезков — начало следующего).
        После конца финала (стоп-кадр) — конец последнего отрезка."""
        played = max(0.0, t) * self._speed
        i = max(0, bisect_right(self._played, played) - 1)
        return min(self._starts[i] + (played - self._played[i]), self._ends[i])
