"""Слова с временем: GigaAM даёт слова и их время, Whisper — текст с пунктуацией для правки, Silero VAD — паузы.

`transcribe` — GigaAM v2 (transducer, sherpa-onnx): буквы с временем → слова. По ним строятся субтитры
по словам и резка пауз. `reference_text` — Whisper turbo: времени у него нет, зато есть пунктуация и регистр;
по этому тексту Claude правит слова. Silero VAD нужен, чтобы резать длинную запись в паузах, а не посреди слова.
Выбор моделей и замеры точности: docs/spikes/2026-10-results.md.

Модели лежат там, куда их кладёт setup/cloud-setup.sh (~/.cache/vm, или $VM_CACHE); свои пути — переменные
окружения ASR_MODEL и ASR_REF_MODEL (папки) и VAD_MODEL (файл). Каждая модель грузится один раз за процесс
(загрузка — секунды). Вход — WAV 16 кГц моно, как отдаёт `media.extract_wav`; время — секунды от начала записи.
"""
import json
import math
import os
from dataclasses import dataclass
from functools import cache
from itertools import pairwise
from pathlib import Path

import numpy as np
import soundfile

from .job import _atomic_write
from .media import PathLike

RATE = 16000  # Гц: на этом звуке обе модели и VAD обучены
GIGAAM = "sherpa-onnx-nemo-transducer-giga-am-v2-russian-2025-04-19"
GIGAAM_FILES = ("encoder.int8.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt")
WHISPER = "sherpa-onnx-whisper-turbo"
WHISPER_FILES = ("turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt")
SILERO = "silero_vad.onnx"

WORD_TAIL = 0.12  # конец слова не дальше времени его последней буквы + столько, с
# Куски записи, с. GigaAM: до ASR_MAX целиком, длиннее — куски ASR_MIN–ASR_MAX (мельче в Плане 1 вышло хуже и по
# тексту, и по времени). Whisper в sherpa-onnx видит только первые ~29,5 с и молча отбрасывает остальное —
# его окна REF_MIN–REF_MAX. Всюду max ≥ 2·min: тогда при любой длине выходит разбиение без короткого хвоста.
ASR_MIN, ASR_MAX = 30.0, 60.0
REF_MIN, REF_MAX = 10.0, 28.0
SILENCE_PEAK = 1e-3  # громкость пика, ниже которой записи нечего слушать (−60 дБ); у шума комнаты пик выше
MIN_AUDIO = 0.1  # звук короче, с, слова не вместит; модели на таком входе ещё и падают (Whisper — segfault)
MIN_PAUSE = 0.3  # пауза для VAD, с
QUIET_FRAME = RATE // 20  # 50 мс: шаг поиска самого тихого места
THREADS = min(4, os.cpu_count() or 1)


@dataclass
class Word:
    t0: float  # начало слова, с от начала исходника
    t1: float  # конец слова, с
    text: str


# ---------- слова из букв с временем ----------


def words_from_tokens(tokens, timestamps) -> list[Word]:
    """Буквы GigaAM с временем → слова. Граница слова — пробельный токен, `t0` — время первой буквы, `t1` —
    меньшее из: `t0` следующего слова и время последней буквы + 0,12 с."""
    if len(tokens) != len(timestamps):
        raise ValueError(f"{len(tokens)} tokens but {len(timestamps)} timestamps")
    spans: list[tuple[str, float, float]] = []  # слово, время первой и последней буквы
    text, first, last = "", 0.0, 0.0
    for token, at in zip(tokens, timestamps):
        if not token.strip():
            if text:
                spans.append((text, first, last))
                text = ""
            continue
        if not text:
            first = at
        text, last = text + token, at
    if text:
        spans.append((text, first, last))
    ends = [min(following[1], last + WORD_TAIL) for (_, _, last), following in pairwise(spans)]
    if spans:
        ends.append(spans[-1][2] + WORD_TAIL)  # у последнего слова следующего нет
    return [Word(first, end, text) for (text, first, _), end in zip(spans, ends)]


def distribute_words(text: str, t0: float, t1: float) -> list[Word]:
    """Запасной вариант без времени слов: фраза `text` на отрезке t0–t1, время делится по числу букв.

    Слова встык; знаки препинания не считаются (слово остаётся как написано), кусок без букв и цифр —
    не слово. Время с точностью до миллисекунды."""
    if t1 < t0:
        raise ValueError(f"distribute_words: t1 ({t1}) is before t0 ({t0})")
    pieces = [(piece, sum(c.isalnum() for c in piece)) for piece in text.split()]
    pieces = [(piece, size) for piece, size in pieces if size]
    total = sum(size for _, size in pieces)
    edges, done = [round(t0, 3)], 0
    for _, size in pieces:
        done += size
        edges.append(round(t0 + (t1 - t0) * done / total, 3))
    return [Word(a, b, piece) for (piece, _), a, b in zip(pieces, edges, edges[1:])]


# ---------- words.json ----------


def save_words(words: list[Word], path: PathLike) -> None:
    """words.json: `[{"t0", "t1", "text"}]`, по слову в строке; пишется целиком или не пишется вовсе."""
    lines = [json.dumps({"t0": w.t0, "t1": w.t1, "text": w.text}, ensure_ascii=False, allow_nan=False) for w in words]
    body = "[\n" + ",\n".join(f"  {line}" for line in lines) + "\n]\n" if lines else "[]\n"
    _atomic_write(Path(path), body)


def load_words(path: PathLike) -> list[Word]:
    """Читает words.json. Файл правит Claude, поэтому ошибка называет слово: ValueError вместо KeyError."""
    path = Path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ValueError(f"{path}: not valid JSON ({err})") from None
    if isinstance(data, list):
        words: list[Word] = []
        for i, item in enumerate(data):
            if problem := _problem(item, words[-1] if words else None):
                raise ValueError(f"{path}: word {i}: {problem}")
            words.append(Word(float(item["t0"]), float(item["t1"]), item["text"]))
        return words
    raise ValueError(f"{path}: expected a list of words, got {type(data).__name__}")


def _problem(item, previous: Word | None) -> str | None:
    """Что не так со словом из words.json; None — всё так."""
    if not isinstance(item, dict):
        return f'expected an object like {{"t0": 1.2, "t1": 1.5, "text": "слово"}}, got {item!r:.40}'
    for key in ("t0", "t1"):
        value = item.get(key)
        if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
            return f"{key} must be a number of seconds, got {value!r}"
    if not isinstance(item.get("text"), str):
        return f"text must be a string, got {item.get('text')!r}"
    t0, t1 = item["t0"], item["t1"]
    if t0 < 0:
        return f"t0 is negative ({t0})"
    if t1 < t0:
        return f"t1 ({t1}) is before t0 ({t0})"
    if previous is not None and t0 < previous.t0:
        return f"out of order, starts at {t0} s but the previous word starts at {previous.t0} s"
    return None


# ---------- модели ----------


def _model(env: str, default: str) -> Path:
    """Путь к модели: переменная окружения, иначе её место в кэше setup/cloud-setup.sh."""
    cache = Path(os.environ.get("VM_CACHE") or "~/.cache/vm")
    return Path(os.environ.get(env) or cache / default).expanduser()


def _missing(directory: Path, names: tuple[str, ...]) -> list[str]:
    return [name for name in names if not (directory / name).is_file()]


@cache
def _gigaam(model: str):
    import sherpa_onnx  # тяжёлый импорт — только когда он нужен

    directory = Path(model)
    if missing := _missing(directory, GIGAAM_FILES):
        what = f"is missing {', '.join(missing)}" if directory.is_dir() else "does not exist"
        raise FileNotFoundError(f"ASR model {directory} {what} (set ASR_MODEL or run setup/cloud-setup.sh)")
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(directory / "encoder.int8.onnx"),
        decoder=str(directory / "decoder.onnx"),
        joiner=str(directory / "joiner.onnx"),
        tokens=str(directory / "tokens.txt"),
        model_type="nemo_transducer",
        num_threads=THREADS,
    )


@cache
def _whisper(model: str):
    """Whisper turbo или None: модель может отсутствовать (VM_WHISPER_REF=0 в setup/cloud-setup.sh)."""
    import sherpa_onnx

    directory = Path(model)
    if _missing(directory, WHISPER_FILES):
        return None
    return sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=str(directory / "turbo-encoder.int8.onnx"),
        decoder=str(directory / "turbo-decoder.int8.onnx"),
        tokens=str(directory / "turbo-tokens.txt"),
        language="ru",
        task="transcribe",
        num_threads=THREADS,
        tail_paddings=1000,
    )


def _decode(recognizer, samples: np.ndarray):
    stream = recognizer.create_stream()
    stream.accept_waveform(RATE, samples)
    recognizer.decode_stream(stream)
    return stream.result


# ---------- звук ----------


def _read(wav: PathLike) -> np.ndarray:
    audio, rate = soundfile.read(wav, dtype="float32", always_2d=True)
    if rate != RATE or audio.shape[1] != 1:
        raise ValueError(
            f"{wav}: expected mono {RATE} Hz audio, got {audio.shape[1]} channel(s) at {rate} Hz "
            "(make it with media.extract_wav)"
        )
    return audio[:, 0]


def _blank(samples: np.ndarray) -> bool:
    """Нечего распознавать: тишина или обрывок короче слова. Модель такому не отдаём: Whisper на тишине выдумывает
    текст, на пустом входе падает (segfault), GigaAM бросает исключение."""
    return len(samples) < MIN_AUDIO * RATE or float(np.abs(samples).max()) < SILENCE_PEAK


# ---------- паузы и куски ----------


def _speech(audio: np.ndarray) -> list[tuple[int, int]] | None:
    """Где в записи речь по Silero VAD, в отсчётах; None — модели VAD нет (режем по тишине без неё)."""
    model = _model("VAD_MODEL", SILERO)
    if not model.is_file():
        return None
    import sherpa_onnx

    seconds = len(audio) / RATE
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = str(model)
    config.silero_vad.min_silence_duration = MIN_PAUSE
    config.silero_vad.max_speech_duration = seconds + 1  # сам VAD речь не режет: каждые 20 с он вставил бы ложную «паузу»
    config.sample_rate = RATE
    # буфер на всю запись: меньший sherpa растит сам, но на каждом росте пишет «Overflow!» в stderr
    vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=seconds + 5)
    spans: list[tuple[int, int]] = []

    def collect() -> None:
        while not vad.empty():
            segment = vad.front
            spans.append((segment.start, segment.start + len(segment.samples)))
            vad.pop()

    window = config.silero_vad.window_size
    for start in range(0, len(audio), window):  # кусками больше окна VAD считает неверно
        vad.accept_waveform(audio[start : start + window])
        collect()
    vad.flush()
    collect()
    return spans


def _pauses(spans: list[tuple[int, int]] | None, size: int) -> list[tuple[int, int]]:
    """Промежутки между речью (и до неё, и после) в записи из `size` отсчётов; нет VAD (None) — паузы неизвестны."""
    if spans is None:
        return []
    pauses, at = [], 0
    for start, stop in [*spans, (size, size)]:
        if start > at:
            pauses.append((at, start))
        at = max(at, stop)
    return pauses


def _quietest(audio: np.ndarray, start: int, stop: int) -> int:
    """Самое тихое место на [start, stop): кадры по 50 мс, берём середину самого тихого. Если таких несколько
    (цифровая тишина) — среднего из них: подальше от краёв паузы."""
    count = (stop - start) // QUIET_FRAME
    if count < 1:
        return (start + stop) // 2
    frames = audio[start : start + count * QUIET_FRAME].astype(np.float64).reshape(count, QUIET_FRAME)
    energy = np.square(frames).mean(axis=1)
    quiet = np.flatnonzero(energy <= energy.min() + 1e-10)
    return start + int(quiet[len(quiet) // 2]) * QUIET_FRAME + QUIET_FRAME // 2


def _chunks(audio: np.ndarray, pauses: list[tuple[int, int]], low: float, high: float) -> list[tuple[int, int]]:
    """Куски записи (отсчёты от–до) для распознавателя: до `high` секунд — один, длиннее — все по `low`–`high` с.

    Режем в самой длинной паузе окна, куда может попасть разрез, чтобы и этот кусок, и остаток вышли в пределах;
    где именно в паузе — выбирает тишина (VAD мог принять за паузу слово, которого не услышал). Нет паузы в окне —
    режем в самом тихом месте окна."""
    size, low_n, high_n = len(audio), round(low * RATE), round(high * RATE)
    bounds, start = [0], 0
    while size - start > high_n:
        window = (start + low_n, min(start + high_n, size - low_n))
        best = None  # (длина паузы, часть паузы в окне); при равенстве — более поздняя
        for a, b in pauses:
            inside = (max(a, window[0]), min(b, window[1]))
            if inside[0] < inside[1] and (best is None or b - a >= best[0]):
                best = (b - a, inside)
        start = _quietest(audio, *(best[1] if best else window))
        bounds.append(start)
    bounds.append(size)
    return list(pairwise(bounds))


# ---------- распознавание ----------


def _words(recognizer, chunk: np.ndarray, offset: float, end: float) -> list[Word]:
    """Слова куска; время сдвинуто на начало куска (`offset`) и не выходит за его конец (`end`)."""
    result = _decode(recognizer, chunk)
    words = []
    for word in words_from_tokens(list(result.tokens), list(result.timestamps)):
        t0 = min(offset + word.t0, end)
        t1 = max(t0, min(offset + word.t1, end))
        words.append(Word(round(t0, 3), round(t1, 3), word.text))
    return words


def transcribe(wav: PathLike) -> list[Word]:
    """Слова записи со временем: GigaAM v2 transducer. Запись до минуты распознаётся целиком, длиннее — кусками
    по 30–60 с, разрезанными в паузах (мельче не режем: Plan 1). Тишина — пустой список."""
    audio = _read(wav)
    if _blank(audio):
        return []
    recognizer = _gigaam(str(_model("ASR_MODEL", GIGAAM)))
    if len(audio) > ASR_MAX * RATE:
        chunks = _chunks(audio, _pauses(_speech(audio), len(audio)), ASR_MIN, ASR_MAX)
    else:
        chunks = [(0, len(audio))]
    words: list[Word] = []
    for start, stop in chunks:
        if not _blank(audio[start:stop]):
            words += _words(recognizer, audio[start:stop], start / RATE, stop / RATE)
    return words


def _overlaps(spans: list[tuple[int, int]], start: int, stop: int) -> bool:
    return any(a < stop and b > start for a, b in spans)


def reference_text(wav: PathLike) -> str:
    """Сплошной текст записи с пунктуацией и регистром: Whisper turbo. По нему Claude правит слова из `transcribe`.

    Whisper видит не больше ~30 с, поэтому запись идёт окнами, разрезанными в паузах; окна без речи пропускаются
    (на шуме он выдумывает текст). Нет модели Whisper — пустая строка."""
    audio = _read(wav)
    if _blank(audio):
        return ""
    recognizer = _whisper(str(_model("ASR_REF_MODEL", WHISPER)))
    if recognizer is None:
        return ""
    spans = _speech(audio)
    parts = []
    for start, stop in _chunks(audio, _pauses(spans, len(audio)), REF_MIN, REF_MAX):
        if _blank(audio[start:stop]) or (spans is not None and not _overlaps(spans, start, stop)):
            continue
        if text := _decode(recognizer, audio[start:stop]).text.strip():
            parts.append(text)
    return " ".join(parts)
