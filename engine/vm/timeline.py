"""Шкала времени: как время исходника становится временем финала.

Финал — оставленные отрезки исходника (`keep`), склеенные встык и ускоренные в `speed` раз. Все времена в
`words.json` и `edit.json` — по исходнику; в время финала их переводит только `Timeline`. Отрезки идут в порядке
финала: сессия пишет их по возрастанию, Павел в редакторе может переставить (timeline.json, `move`). Отрезки, что в
финале стоят подряд и в исходнике идут друг за другом, — серия: события (вставки, акценты, ч/б) тянутся только по
своей серии. По порядку исходника серия одна — всё как всегда.

Тизер (`teaser`) — фраза из середины ролика, которая звучит в самом начале, а потом ещё раз на своём месте: финал —
тизер, затем отрезки `keep`. `to_final` ставит время на его место в ролике (после тизера); время внутри тизера —
`teaser_final`.
"""
import math
from bisect import bisect_right
from collections.abc import Iterable, Sequence
from itertools import pairwise

TO_CUT = 0.25  # с исходника: момент так близко к краю отрезка keep встаёт ровно на край (склейку, начало или конец)


class Timeline:
    """`Timeline(keep, speed, teaser=None)`: `keep` — отрезки исходника `[(начало, конец), ...]` в порядке финала, без
    пересечений (по возрастанию — как отдаёт `cuts.plan_keep` и пишет сессия, или переставленные руками); `speed` — во
    сколько раз финал быстрее исходника; `teaser` — `(начало, конец)` фразы исходника, которая идёт первой."""

    def __init__(self, keep: Iterable[Sequence[float]], speed: float, teaser: Sequence[float] | None = None):
        if not (isinstance(speed, int | float) and math.isfinite(speed) and speed > 0):
            raise ValueError(f"speed must be a positive number, got {speed!r}")
        self._speed = float(speed)
        self._teaser: tuple[float, float] | None = None
        if teaser is not None:
            try:
                a, b = (float(t) for t in teaser)
            except (TypeError, ValueError):
                raise ValueError(f"teaser: expected [start, end], got {teaser!r}") from None
            if not (math.isfinite(a) and math.isfinite(b) and b > a):
                raise ValueError(f"teaser: {teaser!r} must be two finite times with the end after the start")
            self._teaser = (a, b)
        self._lead = self._teaser[1] - self._teaser[0] if self._teaser else 0.0  # секунд исходника в тизере
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
            self._starts.append(start)
            self._ends.append(end)
            self._played.append(total)
            total += end - start
        self._duration = (self._lead + total) / self._speed
        # порядок исходника: отрезки по началу — для поиска момента; пересечений нет ни у каких двух
        self._order = sorted(range(len(self._starts)), key=lambda k: self._starts[k])
        self._sorted_starts = [self._starts[k] for k in self._order]
        for a, b in pairwise(self._order):
            if self._starts[b] < self._ends[a]:
                i, j = max(a, b), min(a, b)
                raise ValueError(f"keep[{i}]: {[self._starts[i], self._ends[i]]!r} overlaps keep[{j}] "
                                 f"{[self._starts[j], self._ends[j]]!r}; segments must not overlap")
        # серии: соседний в финале отрезок — следующий и в исходнике; последний отрезок серии каждого отрезка
        rank = {k: r for r, k in enumerate(self._order)}
        self._run = [0] * len(self._starts)
        for k in range(1, len(self._starts)):
            self._run[k] = self._run[k - 1] + (rank[k] != rank[k - 1] + 1)
        self._run_end = {run: k for k, run in enumerate(self._run)}  # серия → её последний отрезок (по финалу)

    @property
    def duration(self) -> float:
        """Длина финала, с."""
        return self._duration

    @property
    def teaser(self) -> tuple[float, float] | None:
        """Тизер: `(начало, конец)` в исходнике; его нет — None."""
        return self._teaser

    @property
    def teaser_duration(self) -> float:
        """Длина тизера в финале, с (нет тизера — 0)."""
        return self._lead / self._speed

    @property
    def segments(self) -> list[tuple[float, float, float]]:
        """Отрезки финала по порядку: `(начало в исходнике, конец в исходнике, начало в финале)`; тизер — первый."""
        spans = zip(self._starts, self._ends, self._played, strict=True)
        lead = [(*self._teaser, 0.0)] if self._teaser else []
        return lead + [(start, end, (self._lead + played) / self._speed) for start, end, played in spans]

    def _at(self, t: float) -> int | None:
        """Отрезок (номер по финалу), где лежит момент исходника `t`; края — отрезку (на стыке — следующему)."""
        r = bisect_right(self._sorted_starts, t) - 1  # последний по исходнику отрезок, который начался не позже t
        if r < 0:
            return None
        k = self._order[r]
        return k if t <= self._ends[k] else None

    def _next(self, t: float) -> int | None:
        """Первый по исходнику отрезок, который начнётся позже `t` (номер по финалу); нет — None."""
        r = bisect_right(self._sorted_starts, t)
        return self._order[r] if r < len(self._order) else None

    def _final(self, k: int, t: float) -> float:
        return (self._lead + self._played[k] + (t - self._starts[k])) / self._speed

    def to_final(self, t: float) -> float | None:
        """Время финала для времени исходника `t` на его месте в ролике (после тизера); `None` — это время вырезано.
        Края отрезков принадлежат отрезку."""
        k = self._at(t)
        return None if k is None else self._final(k, t)

    def teaser_final(self, t: float) -> float | None:
        """Время финала для времени исходника `t` внутри тизера; вне тизера (или его нет) — None."""
        if self._teaser is None or not self._teaser[0] <= t <= self._teaser[1]:
            return None
        return (t - self._teaser[0]) / self._speed

    def to_final_snap(self, t: float) -> float:
        """Как `to_final`, но вырезанное время переходит в начало отрезка, что идёт за ним в исходнике (после
        последнего — в конец финала): так ставят то, что привязано к моменту, а момент могли вырезать."""
        final = self.to_final(t)
        if final is not None:
            return final
        k = self._next(t)
        return self._final(k, self._starts[k]) if k is not None else self._duration

    def to_cut(self, t: float, within: float = TO_CUT) -> float:
        """Как `to_final_snap`, но момент не дальше `within` с исходника от края отрезка — ровно на этом краю: начало
        (стык с прошлым отрезком или тизером, у первого без тизера — начало ролика) или конец (стык со следующим, у
        последнего — конец ролика); оба близко — ближний. Смена плана или цвета на фразе у склейки совпадает со
        склейкой, а не идёт на пару кадров раньше или позже (кадр «прыгал» бы дважды)."""
        k = self._at(t)
        if k is not None:
            head, tail = t - self._starts[k], self._ends[k] - t
            if min(head, tail) <= within:  # край своего отрезка — там, где он стоит в финале (не начало соседа по исходнику)
                return self._final(k, self._starts[k] if head <= tail else self._ends[k])
        return self.to_final_snap(t)

    def in_source_order(self) -> "Timeline":
        """Те же отрезки (и тизер, и скорость), но по порядку исходника — каким ролик был до перестановок руками: так
        длится хук и так зум считает крупность переставленного куска."""
        return Timeline(sorted(zip(self._starts, self._ends, strict=True)), self._speed, teaser=self._teaser)

    def run_of(self, t: float) -> int | None:
        """Серия отрезка, где момент исходника `t` (вырезанный — отрезка, что идёт за ним в исходнике); после всего
        исходника — None."""
        k = self._at(t)
        k = self._next(t) if k is None else k
        return None if k is None else self._run[k]

    @property
    def speed(self) -> float:
        """Во сколько раз финал быстрее исходника."""
        return self._speed

    def span(self, t0: float, t1: float, cut: bool = False) -> tuple[float, float]:
        """Промежуток финала для промежутка исходника `[t0, t1]` (вставка, акцент, титр, ч/б): с места `t0`
        (`to_final_snap`, с `cut` — `to_cut`) и не дальше конца его серии — кусок, переставленный в другое место,
        событие за собой не тянет. По порядку исходника — `(to_final_snap(t0), to_final_snap(t1))`, как всегда."""
        place = self.to_cut if cut else self.to_final_snap
        a = place(t0)
        k = self._at(t0)
        k = self._next(t0) if k is None else k
        if k is None:  # после всего исходника
            return a, a
        last = self._run_end[self._run[k]]
        if t1 >= self._ends[last]:  # до конца серии — конец её последнего отрезка там, где он стоит
            return a, max(a, self._final(last, self._ends[last]))
        return a, max(a, place(t1))

    def to_source(self, t: float) -> float:
        """Время исходника для времени финала `t` (обратное `to_final`, внутри тизера — `teaser_final`; стык
        отрезков — начало следующего). После конца финала (стоп-кадр) — конец последнего отрезка."""
        played = max(0.0, t) * self._speed
        if self._teaser and played < self._lead:
            return self._teaser[0] + played
        played -= self._lead
        i = max(0, bisect_right(self._played, played) - 1)
        return min(self._starts[i] + (played - self._played[i]), self._ends[i])
