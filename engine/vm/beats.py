"""Доли трека для монтажа в такт: смены зума и появления вставок встают на долю выбранной музыки.

Огибающая всплесков (рост лог-спектра по кадрам 11,6 мс) → темп по автокорреляции с предпочтением темпов около 120 уд/мин
→ сетка долей динамикой (D. Ellis, «Beat Tracking by Dynamic Programming», 2007): доля — на всплеске, соседние доли —
примерно через период. Только numpy; трек читает ffmpeg (`load`).

`track(y, sr)` → `Grid(bpm, times)`; `track_file(path)` — доли всего трека (с длиной, один раз на файл: их же
`vm render` пишет в beats.json — редактор ставит вставки на те же доли); `beat_times` — доли во времени ролика (где и с
какого места звучит трек, повтор по кругу); `snap(t, times)` — ближайшая доля не дальше 0,25 с, иначе `t` как было;
`snap_edit(edit, tl, times)` — смены зума и появления вставок на долях (в шкале ролика), время речи и резка те же.
Доли во времени ролика и `snap_edit` повторяет страница (web/lib/beats.ts, общая фикстура overlay-events.json).
"""
import functools
import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .timeline import Timeline

SR = 22050
NFFT = 1024
HOP = 256  # кадр огибающей — 11,6 мс
# Рост энергии под окном Ханна быстрее всего, когда звук прошёл три четверти окна: всплеск огибающей кадра k — это звук
# в (k·HOP + 0,75·NFFT) / SR, на 35 мс позже начала окна.
LAG = 0.75 * NFFT
BPM_MIN, BPM_MAX = 60.0, 200.0
PRIOR_BPM = 120.0  # темпы около него вероятнее (половинный и двойной темп — реже)
PRIOR_OCTAVES = 1.0  # ширина предпочтения, октав
TIGHTNESS = 100.0  # как строго соседние доли держат период
SNAP = 0.25  # с — дальше этого событие к доле не двигается
MIN_SHOWN = 0.3  # с — вставка, сдвинутая позже, остаётся на экране не меньше этого
CHUNK = 2048  # кадров спектра за раз — чтобы длинный трек не занял сотни мегабайт
MAX_TRACK = 600.0  # с — дальше трек на доли не разбираем: ролик столько не длится


@dataclass(frozen=True)
class Grid:
    """Темп (уд/мин; нет долей — 0) и доли, с от начала трека."""

    bpm: float
    times: list[float]


def load(path: Path, seconds: float | None = None, sr: int = SR) -> np.ndarray:
    """Звук файла: моно, `sr` Гц, float32; `seconds` — не дольше этого."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", str(path)]
    if seconds is not None:
        cmd += ["-t", f"{seconds:.3f}"]
    raw = subprocess.run([*cmd, "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], check=True, capture_output=True, timeout=300).stdout
    return np.frombuffer(raw, np.float32)


def _envelope(y: np.ndarray) -> np.ndarray:
    """Огибающая всплесков по кадрам HOP: сумма роста лог-спектра, без медленного тренда, в единицах её разброса."""
    frames = 1 + (len(y) - NFFT) // HOP if len(y) >= NFFT else 0
    if frames < 3:
        return np.zeros(0)
    window = np.hanning(NFFT).astype(np.float32)
    logspec = np.empty((frames, NFFT // 2 + 1), np.float32)
    for start in range(0, frames, CHUNK):
        idx = np.arange(NFFT)[None, :] + HOP * np.arange(start, min(frames, start + CHUNK))[:, None]
        logspec[start:start + len(idx)] = np.log1p(100 * np.abs(np.fft.rfft(y[idx] * window, axis=1)))
    flux = np.concatenate([[0.0], np.maximum(0.0, np.diff(logspec, axis=0)).sum(axis=1)])
    trend = np.convolve(flux, np.ones(32) / 32, mode="same")  # ~0,37 с
    env = np.maximum(0.0, flux - trend)
    spread = env.std()
    return env / spread if spread > 1e-9 else np.zeros_like(env)


def _period(env: np.ndarray, fps: float) -> float | None:
    """Период долей в кадрах огибающей: пик автокорреляции с предпочтением темпов около 120; нет ритма — None."""
    lo, hi = int(np.floor(60 * fps / BPM_MAX)), int(np.ceil(60 * fps / BPM_MIN))
    if len(env) <= hi + 2:
        return None
    centered = env - env.mean()
    ac = np.correlate(centered, centered, mode="full")[len(env) - 1:]
    if ac[0] <= 0:
        return None
    lags = np.arange(lo, hi + 1)
    bpm = 60 * fps / lags
    weight = np.exp(-0.5 * (np.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES) ** 2)
    scored = ac[lags] / ac[0] * weight
    k = int(np.argmax(scored))
    if scored[k] <= 0.05:
        return None
    lag = float(lags[k])
    if 0 < k < len(lags) - 1:  # уточнение по параболе между соседними лагами
        a, b, c = ac[lags[k] - 1], ac[lags[k]], ac[lags[k] + 1]
        if a - 2 * b + c < 0:
            lag += 0.5 * (a - c) / (a - 2 * b + c)
    return lag


def _grid(env: np.ndarray, period: float) -> list[int]:
    """Кадры долей: динамика по огибающей (доля — на всплеске, соседние — через ~period)."""
    near, far = max(1, round(period / 2)), round(2 * period)
    offsets = np.arange(near, far + 1)
    cost = -TIGHTNESS * np.log(offsets / period) ** 2
    score = env.astype(np.float64).copy()
    back = np.full(len(env), -1)
    for t in range(near, len(env)):
        cands = t - offsets
        ok = cands >= 0
        if not ok.any():
            continue
        values = np.where(ok, score[np.maximum(cands, 0)] + cost, -np.inf)
        best = int(np.argmax(values))
        if values[best] > 0:
            score[t] = env[t] + values[best]
            back[t] = cands[best]
    tail = max(0, len(env) - round(period))  # последняя доля — лучшая в последнем периоде
    beat = tail + int(np.argmax(score[tail:]))
    beats = []
    while beat >= 0:
        beats.append(beat)
        beat = back[beat]
    beats.reverse()
    strong = env > 0.5 * np.median(env[beats]) if beats else env > 0  # до первого и после последнего всплеска долей нет
    while beats and not strong[beats[0]]:
        beats.pop(0)
    while beats and not strong[beats[-1]]:
        beats.pop()
    return beats


def track(y: np.ndarray, sr: int = SR) -> Grid:
    """Темп и доли звука `y` (моно, `sr` Гц)."""
    if sr != SR:
        raise ValueError(f"beats work at {SR} Hz, got {sr}")
    env = _envelope(np.asarray(y, np.float32))
    fps = SR / HOP
    period = _period(env, fps) if env.size and env.any() else None
    if period is None:
        return Grid(0.0, [])
    frames = _grid(env, period)
    return Grid(round(60 * fps / period, 1), [round((f * HOP + LAG) / SR, 4) for f in frames])


@functools.lru_cache(maxsize=8)
def _tracked(path: str, stamp: tuple[int, int]) -> tuple[Grid, float]:
    y = load(Path(path), seconds=MAX_TRACK)
    return track(y), round(len(y) / SR, 4)


def track_file(path: Path) -> tuple[Grid, float]:
    """Доли всего трека (до MAX_TRACK) и его длина, с; файл тот же (время и размер) — посчитанное раньше. Доли не
    зависят от длины ролика и правок — их берёт и редактор."""
    st = path.stat()
    return _tracked(str(path), (st.st_mtime_ns, st.st_size))


def played(length: float, at: float, skip: float, duration: float) -> float:
    """Сколько трека нужно ролику (не больше самого трека): с места `skip`, звучит с `at` до конца ролика и ещё 2 с —
    чтобы последняя доля нашлась."""
    return min(length, skip + max(0.0, duration - at) + 2.0)


def beat_times(times: list[float], length: float, at: float, skip: float, duration: float) -> list[float]:
    """Доли во времени ролика: трек звучит с `at` ролика, с места `skip`; короче ролика — дальше по кругу целиком (с
    начала), и доли повторяются с ним."""
    want = skip + max(0.0, duration - at) + 2.0
    period = played(length, at, skip, duration)
    out = [at + t - skip for t in times if t >= skip]
    start = at + period - skip
    while period < want - 0.05 and start < duration + 2.0:
        out += [start + t for t in times]
        start += period
    return out


def snap(t: float, times: list[float], limit: float = SNAP) -> float:
    """Ближайшая к `t` доля, если она не дальше `limit`; иначе `t` как было."""
    if not times:
        return t
    arr = np.asarray(times)
    k = int(np.argmin(np.abs(arr - t)))
    return float(arr[k]) if abs(arr[k] - t) <= limit + 1e-9 else t


def snap_edit(edit: dict, tl: Timeline, times: list[float], limit: float = SNAP) -> tuple[dict, int]:
    """Копия edit.json, где смены зума (`zooms[].t`, кроме резких — `over: 0`) и появления вставок (`inserts[].t0`) стоят на долях `times`
    (секунды ролика), если доля не дальше `limit`; → (копия, сколько событий подвинуто). Время — по исходнику, как в
    edit.json: момент ролика переводится обратно через `tl`. Событие остаётся на месте, если доля — в тизере или в
    вырезке (обратный перевод не вернёт её же), а вставка — и если позже ей осталось бы меньше MIN_SHOWN."""
    moved = 0

    def place(t: float, until: float | None = None) -> float:
        nonlocal moved
        at = tl.to_final_snap(t)
        beat = snap(at, times, limit)
        if beat == at:
            return t
        back = tl.to_source(beat)
        if beat < tl.teaser_duration or abs(tl.to_final_snap(back) - beat) > 1e-6:
            return t
        if tl.run_of(back) != tl.run_of(t):  # доля — за стыком с куском из другого места записи (переставлен руками)
            return t
        if until is not None and back > t and until - back < MIN_SHOWN:
            return t
        moved += 1
        return round(back, 4)

    out = {**edit}
    # резкая смена крупности стоит на стыке отрезков (vm.zoom) — к долям её не двигаем
    out["zooms"] = [z if float(z.get("over", 1)) == 0 else {**z, "t": place(float(z["t"]))} for z in edit.get("zooms") or []]
    out["inserts"] = [{**i, "t0": place(float(i["t0"]), float(i["t1"]))} for i in edit.get("inserts") or []]
    return out, moved

