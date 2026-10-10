"""Слова с временем: чистые функции и «до модели» проверки — быстро и без моделей; распознавание речи — @slow.

Ожидаемое берётся из построения фикстуры `speech` (conftest.py): речь espeak-ng собрана по одному слову, поэтому
известно, где на самом деле начинается каждое слово. Время сверяется с этой разметкой, а не с самим кодом.
"""
import difflib
import json
import re
import subprocess
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile

from vm import asr
from vm.asr import (
    Word,
    distribute_words,
    load_words,
    reference_text,
    save_words,
    transcribe,
    words_from_tokens,
)
from vm.media import extract_wav

RATE = 16000
# Whisper необязателен (VM_WHISPER_REF=0 в setup/cloud-setup.sh): без него его slow-тесты пропускаются, а не падают
needs_whisper = pytest.mark.skipif(
    bool(asr._missing(asr._model("ASR_REF_MODEL", asr.WHISPER), asr.WHISPER_FILES)),
    reason="the Whisper model is not installed",
)
LIMIT = 0.080  # предел средней ошибки начала слова, с (из плана; на этой речи в Плане 1 вышло 47 мс)


# ---------- помощники ----------


def norm(text: str) -> str:
    return re.sub(r"[^а-яёa-z0-9]", "", text.lower()).replace("ё", "е")


def start_errors(words: list[Word], truth) -> list[float]:
    """Ошибка начала у слов, распознанных так же, как сказаны (сопоставление, как в docs/spikes/asr_bench.py)."""
    matcher = difflib.SequenceMatcher(a=[norm(w.text) for w in truth], b=[norm(w.text) for w in words], autojunk=False)
    return [
        abs(words[block.b + k].t0 - truth[block.a + k].t0)
        for block in matcher.get_matching_blocks()
        for k in range(block.size)
    ]


def start_errors_per_repeat(words: list[Word], base, repeats: int) -> list[float]:
    """То же для записи из одной речи, повторённой встык: difflib сопоставляет целиком и путает повторы между собой,
    поэтому каждый повтор приводится к началу и сверяется с исходной разметкой отдельно."""
    errors = []
    for k in range(repeats):
        offset = k * base.duration
        inside = [Word(w.t0 - offset, w.t1 - offset, w.text) for w in words if offset <= w.t0 < offset + base.duration]
        errors += start_errors(inside, base.words)
    return errors


def write_wav(path: Path, samples, rate: int = RATE) -> Path:
    soundfile.write(path, np.asarray(samples, dtype="float32"), rate, subtype="PCM_16")
    return path


def tone(seconds: float, amplitude: float = 0.3) -> np.ndarray:
    return amplitude * np.sin(2 * np.pi * 440 * np.arange(round(seconds * RATE)) / RATE)


def silent_wav(path: Path, seconds: float = 3) -> Path:
    """Тишина, как её даёт ffmpeg: цифровой ноль."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
         "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", str(seconds), "-c:a", "pcm_s16le", str(path)],
        check=True, capture_output=True,
    )  # fmt: skip
    return path


def spans(*pairs):
    """Секунды → отсчёты: [(10, 12.5)] → [(160000, 200000)]."""
    return [(round(a * RATE), round(b * RATE)) for a, b in pairs]


def cut_times(chunks) -> list[float]:
    return [stop / RATE for _, stop in chunks[:-1]]


@pytest.fixture
def decoded(monkeypatch) -> list[int]:
    """Сколько отсчётов получил распознаватель за каждый вызов (сами вызовы идут как обычно)."""
    calls, decode = [], asr._decode

    def spy(recognizer, samples):
        calls.append(len(samples))
        return decode(recognizer, samples)

    monkeypatch.setattr(asr, "_decode", spy)
    return calls


# ---------- distribute_words ----------


def test_distribute_words_proportional():
    words = distribute_words("а бб ссс", 0, 6)
    assert [w.text for w in words] == ["а", "бб", "ссс"]
    assert [w.t1 - w.t0 for w in words] == pytest.approx([1, 2, 3])
    assert [w.t0 for w in words] == pytest.approx([0, 1, 3])


def test_distribute_words_starts_where_it_is_told():
    words = distribute_words("а бб ссс", 10, 16)
    assert [w.t0 for w in words] == pytest.approx([10, 11, 13])
    assert words[-1].t1 == 16


def test_distribute_words_are_back_to_back():
    words = distribute_words("раз два три четыре пять", 2.0, 5.5)
    assert words[0].t0 == 2.0 and words[-1].t1 == 5.5
    assert all(a.t1 == b.t0 for a, b in pairwise(words))  # ни щелей, ни наложений


def test_distribute_words_ignores_punctuation():
    # знаки не считаются буквами: в «а,» одна буква, в «бб!» две, в «ссс...» три; слово остаётся как написано
    words = distribute_words("а, бб! ссс...", 0, 6)
    assert [w.text for w in words] == ["а,", "бб!", "ссс..."]
    assert [w.t1 - w.t0 for w in words] == pytest.approx([1, 2, 3])


def test_distribute_words_counts_digits_as_letters():
    words = distribute_words("в 2024 год", 0, 8)  # 1 + 4 + 3 знака
    assert [w.t1 - w.t0 for w in words] == pytest.approx([1, 4, 3])


def test_distribute_words_drops_pieces_without_letters():
    words = distribute_words("раз — два ...", 0, 7)  # тире и многоточие отдельно стоят не словами
    assert [w.text for w in words] == ["раз", "два"]
    assert [w.t1 - w.t0 for w in words] == pytest.approx([3.5, 3.5])


@pytest.mark.parametrize("text", ["", "   ", "— ... !?"])
def test_distribute_words_without_letters_gives_nothing(text):
    assert distribute_words(text, 0, 5) == []


def test_distribute_words_rejects_a_span_that_runs_backwards():
    with pytest.raises(ValueError, match="before"):
        distribute_words("раз", 5, 4)


def test_distribute_words_rounds_to_milliseconds():
    # в words.json читает Claude: 0.3333333333333333 — лишние знаки, которые ничего не значат
    words = distribute_words("раз два три", 0, 1)
    assert [w.t1 for w in words] == [0.333, 0.667, 1.0]
    assert words[0].t1 == words[1].t0 and words[1].t1 == words[2].t0
    (word,) = distribute_words("раз", 10.0004, 11.0006)
    assert (word.t0, word.t1) == (10.0, 11.001)


# ---------- words_from_tokens ----------


def test_words_from_char_tokens():
    words = words_from_tokens(["п", "р", "и", " ", "в"], [0.10, 0.18, 0.26, 0.34, 0.50])
    assert [w.text for w in words] == ["при", "в"]
    assert [w.t0 for w in words] == [0.10, 0.50]  # время первой буквы
    assert words[0].t1 <= words[1].t0
    assert words[0].t1 == pytest.approx(0.26 + 0.12)  # время последней буквы + 0,12 с
    assert words[1].t1 == pytest.approx(0.50 + 0.12)  # у последнего слова следующего нет


def test_word_end_never_passes_the_start_of_the_next_word():
    words = words_from_tokens(["а", " ", "б"], [0.10, 0.12, 0.15])  # 0,10 + 0,12 = 0,22 — уже за началом «б»
    assert words[0].t1 == 0.15


def test_words_from_tokens_skips_empty_words():
    assert [w.text for w in words_from_tokens([" ", "а", " ", " ", "б", " "], [0, 0.1, 0.2, 0.3, 0.4, 0.5])] == ["а", "б"]


@pytest.mark.parametrize("tokens", [[], [" "], [" ", " "]])
def test_words_from_tokens_without_letters_is_empty(tokens):
    # на тишине GigaAM отвечает одним пробелом с временем: слов в нём нет
    assert words_from_tokens(tokens, [0.08] * len(tokens)) == []


def test_words_from_tokens_rejects_tokens_without_matching_times():
    with pytest.raises(ValueError, match="timestamps"):
        words_from_tokens(["а", "б"], [0.1])  # молча потерять слова хуже, чем остановиться


# ---------- save_words / load_words ----------


def test_save_and_load_words_roundtrip(tmp_path):
    words = [Word(0.52, 0.64, "сегодня"), Word(1.2, 1.32, "я")]
    path = tmp_path / "job" / "words.json"  # папки задачи ещё нет
    save_words(words, path)
    assert load_words(path) == words


def test_words_json_is_readable_one_word_per_line(tmp_path):
    path = tmp_path / "words.json"
    save_words([Word(0.5, 1.25, "привет"), Word(1.5, 2.0, "мир")], path)
    text = path.read_text(encoding="utf-8")
    assert json.loads(text) == [{"t0": 0.5, "t1": 1.25, "text": "привет"}, {"t0": 1.5, "t1": 2.0, "text": "мир"}]
    assert "привет" in text  # кириллица как есть, а не числовыми кодами символов
    assert len(text.splitlines()) == 4  # «[», два слова, «]»: Claude правит построчно, git показывает построчный diff


def test_save_empty_words(tmp_path):
    save_words([], tmp_path / "words.json")
    assert load_words(tmp_path / "words.json") == []


def test_save_words_failure_keeps_the_previous_file(tmp_path):
    path = tmp_path / "words.json"
    save_words([Word(0, 1, "было")], path)
    with pytest.raises(ValueError):
        save_words([Word(float("nan"), 1, "стало")], path)  # NaN в JSON не бывает
    assert load_words(path) == [Word(0, 1, "было")]
    assert [p.name for p in tmp_path.iterdir()] == ["words.json"]  # и обломков рядом нет


def test_load_words_accepts_ints_and_ignores_extra_keys(tmp_path):
    path = tmp_path / "words.json"
    path.write_text('[{"t0": 1, "t1": 2, "text": "а", "note": "Claude поправил"}]', encoding="utf-8")
    assert load_words(path) == [Word(1.0, 2.0, "а")]


@pytest.mark.parametrize(
    "content, problem",
    [
        ("not json", "valid JSON"),
        ('{"t0": 1, "t1": 2, "text": "а"}', "list"),
        ("[3]", "word 0.*object"),
        ('[{"t0": 1, "t1": 2}]', "word 0.*text"),
        ('[{"t0": "1", "t1": 2, "text": "а"}]', "word 0.*t0"),
        ('[{"t0": true, "t1": 2, "text": "а"}]', "word 0.*t0"),
        ('[{"t0": NaN, "t1": 2, "text": "а"}]', "word 0.*t0"),
        ('[{"t0": 1, "t1": 2, "text": 7}]', "word 0.*text"),
        ('[{"t0": -1, "t1": 2, "text": "а"}]', "word 0.*negative"),
        ('[{"t0": 2, "t1": 1, "text": "а"}]', "word 0.*before"),
        ('[{"t0": 1, "t1": 2, "text": "а"}, {"t0": 0.5, "t1": 0.8, "text": "б"}]', "word 1.*order"),
    ],
)
def test_load_words_rejects_a_file_edited_into_nonsense(tmp_path, content, problem):
    # words.json правит Claude: ошибка должна называть файл и слово, а не падать KeyError-ом
    path = tmp_path / "words.json"
    path.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError, match=problem) as err:
        load_words(path)
    assert "words.json" in str(err.value)


# ---------- входной файл и модель: то, что решается до распознавания ----------


def test_transcribe_silence_returns_empty(tmp_path):
    assert transcribe(silent_wav(tmp_path / "silence.wav")) == []


def test_silence_does_not_need_the_model(tmp_path, monkeypatch):
    monkeypatch.setenv("ASR_MODEL", str(tmp_path / "no-model"))  # цифровой ноль отсеивается до загрузки модели
    assert transcribe(silent_wav(tmp_path / "silence.wav")) == []


def test_reference_text_of_silence_is_empty_and_does_not_load_whisper(tmp_path, monkeypatch):
    # Whisper на тишине выдумывает текст («Продолжение следует...»): до него тишина не доходит
    def never(model):
        raise AssertionError("Whisper was loaded for silence")

    monkeypatch.setattr(asr, "_whisper", never)
    assert reference_text(silent_wav(tmp_path / "silence.wav")) == ""


@pytest.mark.parametrize("samples", [0, 1, 800], ids=["empty", "one sample", "50 ms"])
def test_audio_too_short_for_a_word_does_not_reach_the_model(tmp_path, monkeypatch, samples):
    # на пустом входе GigaAM бросает исключение, а Whisper падает насмерть (segfault)
    monkeypatch.setenv("ASR_MODEL", str(tmp_path / "no-model"))
    assert transcribe(write_wav(tmp_path / "short.wav", tone(1)[:samples])) == []


def test_transcribe_without_the_model_says_what_to_do(tmp_path, monkeypatch):
    monkeypatch.setenv("ASR_MODEL", str(tmp_path / "no-model"))
    with pytest.raises(FileNotFoundError, match="ASR_MODEL") as err:
        transcribe(write_wav(tmp_path / "tone.wav", tone(1)))
    assert "no-model" in str(err.value)


def test_transcribe_names_the_model_file_that_is_missing(tmp_path, monkeypatch):
    model = tmp_path / "half-model"
    model.mkdir()
    (model / "tokens.txt").write_text("a 1\n")
    monkeypatch.setenv("ASR_MODEL", str(model))
    with pytest.raises(FileNotFoundError, match="joiner.onnx"):
        transcribe(write_wav(tmp_path / "tone.wav", tone(1)))


def test_reference_text_without_the_model_is_empty(speech, tmp_path, monkeypatch):
    monkeypatch.setenv("ASR_REF_MODEL", str(tmp_path / "no-model"))
    assert reference_text(speech.wav) == ""  # на настоящей речи: до Whisper дело дошло бы


@pytest.fixture
def whisper_windows(monkeypatch, tmp_path):
    """reference_text на подставном Whisper: 10 с звука в 4 окнах по 2,5 с.

    Возвращает (wav, replies, decoded): `replies` — что Whisper ответит на очередное окно, `decoded` — окна, до
    которых дело дошло (в отсчётах)."""
    windows = [(0, 40_000), (40_000, 80_000), (80_000, 120_000), (120_000, 160_000)]
    replies, decoded = [], []

    def decode(recognizer, samples):
        decoded.append(len(samples))
        return SimpleNamespace(text=replies.pop(0))

    monkeypatch.setattr(asr, "_whisper", lambda model: object())
    monkeypatch.setattr(asr, "_chunks", lambda audio, pauses, low, high: windows)
    monkeypatch.setattr(asr, "_decode", decode)
    return write_wav(tmp_path / "tone.wav", tone(10)), replies, decoded


def test_reference_text_joins_the_windows_with_one_space(whisper_windows, monkeypatch):
    wav, replies, decoded = whisper_windows
    monkeypatch.setattr(asr, "_speech", lambda audio: [(0, len(audio))])
    replies += ["  Привет. ", "", "Как дела?", " Хорошо."]  # пробелы по краям отрезаются, пустой ответ в текст не идёт
    assert reference_text(wav) == "Привет. Как дела? Хорошо."
    assert len(decoded) == 4


def test_reference_text_skips_windows_without_speech(whisper_windows, monkeypatch):
    wav, replies, decoded = whisper_windows
    monkeypatch.setattr(asr, "_speech", lambda audio: [(5_000, 10_000), (90_000, 100_000)])  # речь в 1-м и 3-м окнах
    replies += ["Привет.", "Как дела?"]
    assert reference_text(wav) == "Привет. Как дела?"
    assert len(decoded) == 2  # 2-е и 4-е окна Whisper не отдавались


def test_reference_text_without_vad_gives_every_window_to_whisper(whisper_windows, monkeypatch):
    wav, replies, decoded = whisper_windows
    monkeypatch.setattr(asr, "_speech", lambda audio: None)  # модели VAD нет: где речь, неизвестно
    replies += ["Раз.", "Два.", "Три.", "Четыре."]
    assert reference_text(wav) == "Раз. Два. Три. Четыре."
    assert len(decoded) == 4


def test_reference_text_with_a_half_downloaded_model_is_empty(speech, tmp_path, monkeypatch):
    model = tmp_path / "half-model"
    model.mkdir()
    (model / "turbo-encoder.int8.onnx").write_bytes(b"not a model")
    (model / "turbo-tokens.txt").write_text("a 1\n")  # нет декодера
    monkeypatch.setenv("ASR_REF_MODEL", str(model))
    assert reference_text(speech.wav) == ""


@pytest.mark.parametrize("rate, channels", [(44100, 1), (8000, 1), (16000, 2)])
def test_audio_that_is_not_16k_mono_is_refused_with_the_way_out(tmp_path, rate, channels):
    samples = np.full((rate, channels), 0.1, "float32")
    path = tmp_path / "wrong.wav"
    soundfile.write(path, samples, rate, subtype="PCM_16")
    for call in (transcribe, reference_text):
        with pytest.raises(ValueError, match=r"16000 Hz.*extract_wav") as err:
            call(path)
        assert f"{rate} Hz" in str(err.value)


def test_model_directories_follow_the_environment(tmp_path, monkeypatch):
    for variable in ("ASR_MODEL", "ASR_REF_MODEL", "VAD_MODEL", "VM_CACHE"):
        monkeypatch.delenv(variable, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    cache = tmp_path / ".cache" / "vm"
    assert asr._model("ASR_MODEL", asr.GIGAAM) == cache / "sherpa-onnx-nemo-transducer-giga-am-v2-russian-2025-04-19"
    assert asr._model("ASR_REF_MODEL", asr.WHISPER) == cache / "sherpa-onnx-whisper-turbo"
    assert asr._model("VAD_MODEL", asr.SILERO) == cache / "silero_vad.onnx"
    monkeypatch.setenv("VM_CACHE", str(tmp_path / "elsewhere"))  # так же, как в setup/cloud-setup.sh
    assert asr._model("ASR_MODEL", asr.GIGAAM) == tmp_path / "elsewhere" / asr.GIGAAM
    monkeypatch.setenv("ASR_MODEL", "~/own-model")
    assert asr._model("ASR_MODEL", asr.GIGAAM) == tmp_path / "own-model"


# ---------- слова куска: сдвиг на начало куска ----------


def fake_result(monkeypatch, tokens, timestamps):
    result = SimpleNamespace(tokens=list(tokens), timestamps=list(timestamps))
    monkeypatch.setattr(asr, "_decode", lambda recognizer, samples: result)


def test_words_of_a_chunk_are_shifted_to_its_start(monkeypatch):
    fake_result(monkeypatch, "да нет", [0.5, 0.58, 0.7, 1.6, 1.68, 1.76])
    words = asr._words(None, np.zeros(1), 10.0, 12.0)  # кусок 10–12 с
    assert words == [Word(10.5, 10.7, "да"), Word(11.6, 11.88, "нет")]


def test_words_of_a_chunk_are_rounded_to_milliseconds(monkeypatch):
    fake_result(monkeypatch, "да", [0.5, 0.58])
    (word,) = asr._words(None, np.zeros(1), 53.0356, 80.0)  # кусок начался не на целой миллисекунде
    assert word == Word(53.536, 53.736, "да")  # а не 53.5356 и 53.7356


def test_words_of_a_chunk_stay_inside_it(monkeypatch):
    # последнее слово у самого края: его конец (последняя буква + 0,12 с) и даже начало не должны зайти в следующий кусок
    fake_result(monkeypatch, "да я", [0.5, 0.58, 0.7, 2.02])
    words = asr._words(None, np.zeros(1), 10.0, 12.0)
    assert words[-1] == Word(12.0, 12.0, "я")
    assert all(a.t1 <= b.t0 for a, b in pairwise(words))


# ---------- куски: где резать длинную запись ----------


def test_pauses_are_the_gaps_between_speech():
    assert asr._pauses([(1_000, 2_000), (5_000, 6_000)], 10_000) == [(0, 1_000), (2_000, 5_000), (6_000, 10_000)]


def test_pauses_of_audio_without_speech_is_all_of_it():
    assert asr._pauses([], 10_000) == [(0, 10_000)]


def test_pauses_have_no_zero_width_gaps():
    assert asr._pauses([(0, 3_000), (3_000, 10_000)], 10_000) == []


def test_without_the_vad_model_no_pauses_are_known(tmp_path, monkeypatch):
    monkeypatch.setenv("VAD_MODEL", str(tmp_path / "no-model.onnx"))
    assert asr._speech(np.zeros(RATE, "float32")) is None
    assert asr._pauses(None, 10_000) == []


def test_audio_up_to_the_limit_is_not_split():
    assert asr._chunks(np.zeros(60 * RATE, "float32"), [], 30, 60) == [(0, 60 * RATE)]
    assert len(asr._chunks(np.zeros(60 * RATE + 1, "float32"), [], 30, 60)) == 2


def test_cut_goes_into_the_longest_pause_of_the_window():
    audio = np.zeros(100 * RATE, "float32")
    pauses = spans((35, 35.5), (45, 46), (58, 58.4), (75, 76))  # в окне 30–60 с самая длинная — вторая
    chunks = asr._chunks(audio, pauses, 30, 60)
    assert len(chunks) == 2
    assert cut_times(chunks) == pytest.approx([45.5], abs=0.05)  # посередине паузы
    assert chunks[0][0] == 0 and chunks[0][1] == chunks[1][0] and chunks[1][1] == 100 * RATE


def test_equal_pauses_cut_in_the_later_one():
    audio = np.zeros(100 * RATE, "float32")
    chunks = asr._chunks(audio, spans((40, 40.5), (50, 50.5)), 30, 60)
    assert cut_times(chunks) == pytest.approx([50.25], abs=0.05)  # кусок длиннее — кусков меньше


def test_last_piece_is_not_shorter_than_the_minimum():
    audio = np.zeros(70 * RATE, "float32")
    # длинная пауза на 55 с оставила бы 15 с хвоста — она не годится; годится только пауза на 38 с
    chunks = asr._chunks(audio, spans((38, 38.5), (55, 56)), 30, 60)
    assert cut_times(chunks) == pytest.approx([38.25], abs=0.05)


def test_a_pause_that_straddles_the_window_edge_is_cut_inside_the_window():
    audio = np.zeros(80 * RATE, "float32")
    (cut,) = cut_times(asr._chunks(audio, spans((25, 33)), 30, 60))  # окно 30–60 с, пауза 25–33 с
    assert 30 <= cut <= 33


def test_without_a_pause_the_cut_goes_to_the_quietest_moment():
    rng = np.random.default_rng(7)
    audio = (0.1 * rng.standard_normal(100 * RATE)).astype("float32")
    audio[round(47 * RATE) : round(47.3 * RATE)] *= 0.01  # единственное тихое место в окне
    (cut,) = cut_times(asr._chunks(audio, [], 30, 60))
    assert 47.0 <= cut <= 47.3


def test_energy_picks_the_exact_spot_inside_the_pause():
    rng = np.random.default_rng(8)
    audio = (0.1 * rng.standard_normal(100 * RATE)).astype("float32")
    audio[round(45 * RATE) : round(45.3 * RATE)] *= 0.01  # VAD назвал паузой 44–48 с, но тихо только 45,0–45,3
    (cut,) = cut_times(asr._chunks(audio, spans((44, 48)), 30, 60))
    assert 45.0 <= cut <= 45.3  # не середина паузы (46 с), где может оказаться слово, пропущенное VAD


def test_cut_goes_to_the_quietest_moment_when_the_window_has_no_pause():
    rng = np.random.default_rng(9)
    audio = (0.1 * rng.standard_normal(100 * RATE)).astype("float32")
    audio[round(52 * RATE) : round(52.2 * RATE)] *= 0.01
    (cut,) = cut_times(asr._chunks(audio, spans((10, 11), (80, 81)), 30, 60))  # пауз в окне 30–60 с нет
    assert 52.0 <= cut <= 52.2


@pytest.mark.parametrize("seed", range(12))
def test_every_piece_stays_within_the_limits_and_every_cut_is_in_a_pause(seed):
    rng = np.random.default_rng(seed)
    total = float(rng.uniform(61, 400))
    pauses, t = [], 0.0
    while t < total:
        t += rng.uniform(0.5, 7)  # речь
        length = rng.uniform(0.3, 1.5)
        pauses.append((t, min(t + length, total)))
        t += length
    chunks = asr._chunks(np.zeros(round(total * RATE), "float32"), spans(*pauses), 30, 60)
    lengths = [(b - a) / RATE for a, b in chunks]
    assert chunks[0][0] == 0 and chunks[-1][1] == round(total * RATE)
    assert all(a[1] == b[0] for a, b in pairwise(chunks))  # без щелей и наложений
    assert all(30 - 0.001 <= n <= 60 + 0.001 for n in lengths), lengths  # все куски, и последний, — 30–60 с
    start = 0.0
    for cut in cut_times(chunks):
        low, high = start + 30, min(start + 60, total - 30)  # куда можно резать, чтобы и этот кусок, и остаток вышли 30–60 с
        if any(a < high and b > low for a, b in pauses):  # в окне есть пауза — режем в паузе
            assert any(a - 0.001 <= cut <= b + 0.001 for a, b in pauses), (start, cut)
        start = cut


def test_whisper_windows_are_shorter_than_the_30_seconds_it_can_see():
    # sherpa-onnx молча отбрасывает у Whisper всё после ~29,5 с
    chunks = asr._chunks(np.zeros(100 * RATE, "float32"), [], asr.REF_MIN, asr.REF_MAX)
    assert all((b - a) / RATE <= 28 for a, b in chunks)


# ---------- распознавание (нужны модели) ----------


@pytest.mark.slow
def test_transcribe_word_timing(speech):
    words = transcribe(speech.wav)
    errors = start_errors(words, speech.words)
    assert len(errors) >= 7, f"matched {len(errors)} of {len(speech.words)}: {[w.text for w in words]}"
    assert np.mean(errors) <= LIMIT, f"mean start error {1000 * np.mean(errors):.0f} ms"
    assert all(w.t0 <= w.t1 for w in words)
    assert all(a.t1 <= b.t0 for a, b in pairwise(words))  # слово кончается не позже начала следующего
    assert words[-1].t1 <= speech.duration  # и не выходит за запись


@pytest.mark.slow
def test_transcribe_through_extract_wav(tmp_path, speech):
    # настоящий путь: ролик со звуком AAC → media.extract_wav → transcribe; сжатие звука время не ломает
    clip = tmp_path / "speech.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
         "-f", "lavfi", "-i", f"color=c=black:s=64x64:r=30:d={speech.duration}", "-i", str(speech.wav),
         "-ar", "48000", "-c:v", "libx264", "-c:a", "aac", "-b:a", "192k", "-shortest", str(clip)],
        check=True, capture_output=True,
    )  # fmt: skip
    words = transcribe(extract_wav(clip, tmp_path / "source.wav"))
    errors = start_errors(words, speech.words)
    assert len(errors) >= 7 and np.mean(errors) <= LIMIT


@pytest.mark.slow
def test_transcribe_long_audio_is_chunked(speech, long_speech, decoded):
    words = transcribe(long_speech.wav)
    pieces = [n / RATE for n in decoded]  # секунд звука на каждый вызов распознавателя

    assert long_speech.duration > 75
    assert len(pieces) >= 2 and all(30 <= n <= 60 for n in pieces), pieces  # куски 30–60 с
    assert sum(pieces) == pytest.approx(long_speech.duration, abs=0.001)  # весь звук, ничего дважды
    starts = [w.t0 for w in words]
    assert starts == sorted(starts)  # времена не убывают — на стыках кусков тоже
    assert all(a.t1 <= b.t0 for a, b in pairwise(words))
    assert words[-1].t0 > 75
    repeats = round(long_speech.duration / speech.duration)
    errors = start_errors_per_repeat(words, speech, repeats)  # время сдвинуто на начало куска: ошибка там же, где у целой
    assert len(errors) >= 7 * repeats, f"matched {len(errors)} of {len(long_speech.words)}"
    assert np.mean(errors) <= LIMIT, f"mean start error {1000 * np.mean(errors):.0f} ms"


@pytest.mark.slow
def test_short_audio_is_recognized_in_one_piece(speech, decoded):
    transcribe(speech.wav)
    assert decoded == [round(speech.duration * RATE)]


@pytest.mark.slow
def test_cuts_of_a_long_recording_fall_between_words(long_speech):
    audio = asr._read(long_speech.wav)
    chunks = asr._chunks(audio, asr._pauses(asr._speech(audio), len(audio)), 30, 60)
    assert len(chunks) >= 2
    for cut in cut_times(chunks):
        assert not any(w.t0 <= cut <= w.t1 for w in long_speech.words), f"cut at {cut:.2f} s is inside a word"


def test_without_the_vad_model_cuts_still_fall_between_words(long_speech, tmp_path, monkeypatch):
    # без Silero режем по тишине: на речи с цифровым нулём между словами это тоже всегда щель, не слово
    monkeypatch.setenv("VAD_MODEL", str(tmp_path / "no-model.onnx"))
    audio = asr._read(long_speech.wav)
    chunks = asr._chunks(audio, asr._pauses(asr._speech(audio), len(audio)), 30, 60)
    assert len(chunks) >= 2 and all(30 <= (b - a) / RATE <= 60 for a, b in chunks)
    for cut in cut_times(chunks):
        assert not any(w.t0 <= cut <= w.t1 for w in long_speech.words), f"cut at {cut:.2f} s is inside a word"


@pytest.mark.slow
def test_speech_detection_finds_the_pause_between_phrases(speech):
    audio = asr._read(speech.wav)
    pauses = asr._pauses(asr._speech(audio), len(audio))
    words = speech.words
    for last, first in [(words[2], words[3]), (words[8], words[9])]:  # паузы 0,8 с между фразами
        middle = (last.t1 + first.t0) / 2 * RATE
        assert any(a <= middle <= b for a, b in pauses), f"no pause around {middle / RATE:.2f} s: {pauses}"


@pytest.mark.slow
def test_speech_detection_reports_speech_that_runs_to_the_end(speech):
    audio = asr._read(speech.wav)[: round(speech.words[-1].t1 * RATE)]  # запись обрезана сразу после последнего слова
    spans = asr._speech(audio)
    assert spans and spans[-1][1] >= len(audio) - 0.3 * RATE  # последний участок речи не потерян


@pytest.mark.slow
def test_speech_detection_invents_no_pauses_in_long_continuous_speech(tmp_path, speech):
    # у Silero по умолчанию речь длиннее 20 с режется сама, с щелью в миг: это были бы ложные паузы
    phrase = soundfile.read(speech.wav, dtype="float32")[0][round(0.5 * RATE) : round(2.19 * RATE)]  # «сегодня я расскажу»
    audio = np.tile(phrase, 30)  # 50 с подряд, паузы между словами только по 0,12 с
    assert len(audio) / RATE > 45
    pauses = asr._pauses(asr._speech(audio), len(audio))
    assert all(b <= RATE or a >= len(audio) - RATE for a, b in pauses), [(a / RATE, b / RATE) for a, b in pauses]


@pytest.mark.slow
def test_transcribe_noise_returns_empty(tmp_path):
    noise = 0.01 * np.random.default_rng(3).standard_normal(3 * RATE)  # −40 дБ: не тишина, но и не речь
    assert transcribe(write_wav(tmp_path / "noise.wav", noise)) == []


@pytest.mark.slow
@needs_whisper
def test_reference_text_has_punctuation(speech):
    text = reference_text(speech.wav)
    assert text, "Whisper returned nothing"
    assert "." in text
    assert text[0].isupper()  # и регистр


@pytest.mark.slow
@needs_whisper
def test_reference_text_reaches_the_end_of_a_long_recording(long_speech):
    # sherpa-onnx даёт Whisper только первые ~30 с и молча отбрасывает остальное; в первых 30 с — 3 повтора из 10
    text = reference_text(long_speech.wav)
    repeats = len(long_speech.words) // 12
    assert text.lower().count("сегодня") >= repeats * 0.7, text
    assert text == text.strip() and "  " not in text  # окна склеены одним пробелом,
    assert not re.search(r"[.!?][^\s]", text), text  # и предложения на стыках не слиплись


@pytest.mark.slow
@needs_whisper
def test_reference_text_of_noise_is_empty(tmp_path):
    # на шуме Whisper придумывает текст («Субтитры сделал DimaTorzok»): куски без речи ему не отдаются
    noise = 0.01 * np.random.default_rng(4).standard_normal(5 * RATE)
    assert reference_text(write_wav(tmp_path / "noise.wav", noise)) == ""


@pytest.mark.slow
@needs_whisper
@pytest.mark.parametrize("samples", [0, 1, 800], ids=["empty", "one sample", "50 ms"])
def test_whisper_never_sees_audio_too_short_for_a_word(tmp_path, samples):
    assert reference_text(write_wav(tmp_path / "short.wav", tone(1)[:samples])) == ""


@pytest.mark.slow
def test_models_are_loaded_once_per_process():
    giga, whisper = (str(asr._model(*args)) for args in (("ASR_MODEL", asr.GIGAAM), ("ASR_REF_MODEL", asr.WHISPER)))
    assert asr._gigaam(giga) is asr._gigaam(giga)
    assert asr._whisper(whisper) is asr._whisper(whisper)
