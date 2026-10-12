"""Подготовка задачи к монтажу: исходник, звук, слова, план резки, контактный лист — и сводка для Claude.

Видео из `in/` (`in/source.*`, как кладёт fetch; иначе все видео по имени) → `source.mp4` (1080×1920 SDR 30 к/с;
озвучка Павла — upload `kind: "audio"` в job.json — вместо звука видео, ролик длиной в неё)
→ `work/source.wav` (16 кГц) → `language.json` (язык ролика: `ЯЗЫК:` в ТЗ, ответ Павла `--lang` или Whisper по
речи) → `reference.txt` (сплошной текст Whisper, по нему Claude правит слова) → `words.json` (слова с временем:
GigaAM для русского, Parakeet для 25 европейских языков, иначе Whisper по фразам), `speech.json` (где речь по VAD:
резка внутри неё не режет), `cuts.json` (`plan_keep` — плотная резка — и `joins` — резкие смены кадра в исходнике,
места для переходов), `sheet.png`. Какие модели были и каких нет — в сводке: без модели слов для языка ролика
работать нельзя, без Whisper и VAD — можно, но хуже. Язык второго этапа (своя письменность) — ошибка с понятным
текстом.

Делается только недостающее. `source.mp4` в git нет, поэтому каждая новая сессия (render, fix, restyle) запускает
prepare, чтобы его восстановить; речь при этом заново не распознаётся: есть `words.json` — распознавание, план резки
(если `cuts.json` есть) и контактный лист пропускаются. `redo=True` (`--redo`) делает всё заново, `language`
(`--lang`, ответ Павла) — распознаёт заново, если язык не тот, что в `language.json`.
"""
import json
import math
import re
from collections.abc import Callable
from pathlib import Path

from . import asr, editor, lang
from .cuts import SOFT, plan_keep
from .job import Job, _atomic_write
from .media import (
    contact_sheet,
    extract_wav,
    normalize,
    probe,
    scene_cuts,
    voice_seconds,
)

VIDEO = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp", ".hevc"}
SHEET_THUMBS = 60  # кадров на контактном листе — не больше, иначе лист выходит в десятки тысяч пикселей
PHRASE_GAP = 0.6  # с — пауза, после которой сводка начинает новую строку текста
LINE_MAX = 10.0  # с — строка сводки не длиннее: по её времени Claude выбирает кадры
MODEL = {"gigaam": "GigaAM", "parakeet": "Parakeet", "whisper": "Whisper"}  # чем распознаётся язык → модель
SOURCE = {"brief": "из ТЗ", "answer": "ответ Павла", "detected": "по речи", "default": "по умолчанию"}


def models() -> dict[str, bool]:
    """Какие модели распознавания стоят: GigaAM, Parakeet, Whisper, VAD."""
    return {
        "GigaAM": not asr._missing(asr._model("ASR_MODEL", asr.GIGAAM), asr.GIGAAM_FILES),
        "Parakeet": not asr._missing(asr._model("PARAKEET_MODEL", asr.PARAKEET), asr.PARAKEET_FILES),
        "Whisper": not asr._missing(asr._model("ASR_REF_MODEL", asr.WHISPER), asr.WHISPER_FILES),
        "VAD": asr._model("VAD_MODEL", asr.SILERO).is_file(),
    }


def _engine(code: str, have: dict[str, bool], hint: str = "") -> str:
    """Чем распознавать язык `code`; второй этап или нет нужной модели — ValueError с понятным текстом."""
    try:
        how = lang.engine(code)
    except lang.Unsupported as err:
        raise lang.Unsupported(f"{err}{hint}") from None
    if not have[MODEL[how]]:
        raise ValueError(f"нет модели {MODEL[how]} для языка {lang.name(code)}: запустите setup/cloud-setup.sh")
    return how


def _brief(job: Job) -> str:
    path = job.path("job.json")
    return str(json.loads(path.read_text(encoding="utf-8")).get("brief") or "") if path.is_file() else ""


def _voice(job: Job) -> tuple[Path, str] | None:
    """Озвучка Павла — upload `kind: "audio"` в job.json: (файл, как он назывался у Павла); нет — None. В job.json есть,
    а файла нет — ValueError: без неё ролик собрался бы со звуком видео."""
    path = job.path("job.json")
    uploads = json.loads(path.read_text(encoding="utf-8")).get("uploads") or [] if path.is_file() else []
    up = next((u for u in uploads if isinstance(u, dict) and u.get("kind") == "audio"), None)
    if up is None:
        return None
    file = job.path(str(up.get("file") or ""))
    if not (file.is_file() and file.is_relative_to(job.path("in"))):
        raise ValueError(f"озвучки {up.get('name')} нет ({up.get('file')}) — сначала vm fetch {job.root}")
    return file, str(up.get("name") or file.name)


def _voice_line(name: str, voice: float, video: float) -> str:
    """Строка сводки об озвучке: её длина и что стало с видео."""
    if video < voice - 0.05:
        fate = "последний кадр держится до конца записи"
    elif video > voice + 0.05:
        fate = "обрезано по записи"
    else:
        fate = "той же длины"
    sec = lambda t: f"{t:.1f}".replace(".", ",")
    return f"Озвучка: {name} ({sec(voice)} с) — вместо звука видео; видео {sec(video)} с — {fate}"


def _language_lines(info: dict, unknown: str | None) -> list[str]:
    """Строка сводки о языке и предупреждения: язык не ясен, строка «ЯЗЫК:» не понята, время слов грубое."""
    lines = [f"Язык: {info['name']} ({info['code']}, {SOURCE[info['source']]})"]
    if unknown:
        lines.append(f"ВНИМАНИЕ: в ТЗ «ЯЗЫК: {unknown}» — не понял такой язык, определял по речи")
    if not info["sure"]:
        why = f"окна записи: {', '.join(info['votes'])}" if info["votes"] else "Whisper нет, некому определить"
        lines.append(
            f"ВНИМАНИЕ: язык не ясен ({why}): прочитай reference.txt и words.json; язык другой — "
            "vm prepare --lang <код> (распознает заново); сам не понял — вопрос `language`"
        )
    if info["source"] == "detected" and (near := lang.siblings(info["code"])):
        names = ", ".join(lang.name(code) for code in near)
        lines.append(f"Язык по речи — проверь по тексту, не {names} ли это: Whisper их путает (все окна могут ошибиться "
                     "одинаково, а reference.txt — выйти переводом); другой — vm prepare --lang <код>")
    if lang.engine(info["code"]) == "whisper":
        lines.append(
            f"ВНИМАНИЕ: для языка {info['name']} нет модели с временем слов: время слов разложено по фразам примерно — "
            "подсветка слова может отставать; напиши об этом в unsure"
        )
    return lines


def _clock(t: float) -> str:
    tenths = round(t * 10)  # сначала округлить: 59,96 с — это 1:00.0, а не 0:60.0
    return f"{tenths // 600}:{tenths % 600 / 10:04.1f}"


def _lines(words: list[asr.Word]) -> list[str]:
    """Текст по фразам (не длиннее `LINE_MAX`) с временем начала — чтобы Claude находил места «добавь сюда»."""
    out, phrase, start = [], [], 0.0
    for i, w in enumerate(words):
        if not phrase:
            start = w.t0
        phrase.append(w.text)
        last = i + 1 == len(words)
        if last or words[i + 1].t0 - w.t1 > PHRASE_GAP or words[i + 1].t0 - start >= LINE_MAX:
            out.append(f"[{_clock(start)}] {' '.join(phrase)}")
            phrase = []
    return out


def _coverage(words: list[asr.Word], reference: str, model: str = "GigaAM") -> str | None:
    """Предупреждение, если модель слов (`model`) услышала заметно меньше слов, чем Whisper (меньше 60 %): значит,
    в words.json могли пропасть целые фразы, и по ним не будет субтитров."""
    heard = len(re.findall(r"\w+", reference))
    if heard < 10 or len(words) >= 0.6 * heard:
        return None
    return (f"ВНИМАНИЕ: {model} услышал {len(words)} слов, а Whisper — {heard}: сверь words.json с reference.txt — "
            "пропавшие фразы допиши словами с временем из соседних слов или скажи об этом в unsure")


def _uncovered(words: list[asr.Word], spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Речь по VAD (не короче 0,5 с), на которую слова покрывают меньше трети: там GigaAM ничего не разобрал, и
    резка вырезала бы эту речь как паузу."""
    out = []
    for a, b in spans:
        covered = sum(max(0.0, min(b, w.t1) - max(a, w.t0)) for w in words)
        if b - a >= 0.5 and covered < (b - a) / 3:
            out.append((a, b))
    return out


def _videos(folder: Path) -> list[Path]:
    """Видео исходника: `in/source.*` (так его кладёт fetch), а если такого нет — все видео в `in/` по имени."""
    videos = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO) if folder.is_dir() else []
    return [p for p in videos if p.stem == "source"] or videos


def _write_cuts(path: Path, cuts: dict) -> None:
    """cuts.json — по отрезку в строке (json с отступами ставит каждое число на свою строку)."""
    rows = ",\n".join(f"  {json.dumps(list(k))}" for k in cuts["keep"])
    keep = f"[\n{rows}\n]" if rows else "[]"
    head = f'"duration": {cuts["duration"]}, "cut_seconds": {cuts["cut_seconds"]}, "joins": {json.dumps(cuts["joins"])}'
    _atomic_write(path, f'{{{head}, "keep": {keep}}}\n')


def _editor_files(job: Job) -> str:
    """Файлы редактора (бета) → строка сводки. Сбой не останавливает шаг: недоделанное убирается, монтаж идёт как раньше."""
    try:
        made = editor.make(job)
    except Exception as e:  # noqa: BLE001 — любой сбой беты (ffmpeg, память, схема) не должен ронять анализ
        for name in ("out/proxy.mp4", "film.jpg", "editor.json"):
            job.path(name).unlink(missing_ok=True)
        return f"Редактор (бета): не вышло — {e}; монтаж это не задевает"
    if made["proxy"] is None:
        return f"Редактор (бета): без видео — исходник длинный; film.jpg ({made['film']['n']} кадров), editor.json"
    size = job.path("out/proxy.mp4").stat().st_size / editor.MB
    return f"Редактор (бета): out/proxy.mp4 ({size:.1f} МБ), film.jpg ({made['film']['n']} кадров), editor.json — уйдут с vm push"


def prepare(
    job: Job, step: Callable[[str, str], None] | None = None, redo: bool = False, language: str | None = None
) -> str:
    """Готовит задачу (только недостающее; `redo` — всё заново; `language` — язык ролика по ответу Павла);
    `step(фаза, текст)` зовётся на каждой смене фазы. → сводка для Claude."""
    step = step or (lambda phase, message: None)
    source, words_path, cuts_path = job.path("source.mp4"), job.path("words.json"), job.path("cuts.json")
    speech_path, language_path = job.path("speech.json"), job.path("language.json")
    brief = _brief(job)
    answer = lang.parse(language) if language is not None else None
    if language is not None and answer is None:
        raise ValueError(f"не понял язык «{language}»: напиши код (cs) или название (чешский)")
    if language_path.is_file():
        known = job.read("language.json")
    else:  # задача до мультиязычности — русская
        known = {"code": "ru", "name": "русский", "source": "default", "sure": True, "votes": []} if words_path.is_file() else None
    recognise = redo or not words_path.is_file() or (answer is not None and (known or {}).get("code") != answer)
    if answer is None and known and known["source"] == "answer":
        answer = known["code"]  # ответ Павла переживает --redo
    told, unknown = (answer, None) if answer else lang.from_brief(brief)
    have = models() if recognise else {}
    if recognise:  # до тяжёлой работы: распознавать нечем, язык не поддержан или нет его модели
        if not (have["GigaAM"] or have["Parakeet"] or have["Whisper"]):
            raise ValueError("нет моделей распознавания (GigaAM, Parakeet, Whisper): запустите setup/cloud-setup.sh")
        if told:
            _engine(told, have)
    notes = []

    if redo or not source.is_file():
        parts = _videos(job.path("in"))
        if not parts:
            raise ValueError(f"{job.path('in')}: нет видео — сначала python -m vm fetch {job.root}")
        if len(parts) > 1:
            notes.append(f"Части по порядку: {', '.join(p.name for p in parts)}")
        voice = _voice(job)
        step("Готовлю видео", "Привожу к 1080×1920, 30 к/с, SDR" + (" и ставлю озвучку" if voice else ""))
        if voice:
            notes.append(_voice_line(voice[1], voice_seconds(voice[0]), sum(probe(p).duration for p in parts)))
        info = normalize(parts, source, voice=voice[0] if voice else None)
    else:
        info = probe(source)
    if not (math.isfinite(info.duration) and info.duration > 0):
        raise ValueError(f"source.mp4: непонятная длительность {info.duration!r}")

    reference = ""
    if recognise:
        wav = extract_wav(source, job.path("work/source.wav"))
        step("Расшифровываю", f"Язык — {lang.name(told)}: слушаю речь" if told else "Слушаю речь и определяю язык")
        reference, votes = asr.reference(wav, told or "") if have["Whisper"] else ("", [])
        spoken = lang.decide(brief, [] if told else votes, answer=answer)
        how = _engine(spoken["code"], have, "" if told else ". Если язык другой — напиши его в ТЗ строкой «ЯЗЫК: …»")
        model = MODEL[how]
        step("Расшифровываю", f"Язык — {spoken['name']}: расставляю слова по времени")
        words = asr.transcribe(wav, spoken["code"])
        job.write("language.json", spoken)
        asr.save_words(words, words_path)
        _atomic_write(job.path("reference.txt"), reference + ("\n" if reference else ""))
        speech = asr.speech_spans(wav)
        _atomic_write(speech_path, json.dumps([list(span) for span in speech]) + "\n")
        notes += _language_lines(spoken, unknown)
        if model != "Whisper" and (warning := _coverage(words, reference, model)):
            notes.append(warning)
        if lost := _uncovered(words, speech):
            spans = ", ".join(f"{_clock(a)}–{_clock(b)}" for a, b in lost)
            notes.append(f"ВНИМАНИЕ: речь без слов ({spans}) — {model} там ничего не разобрал, субтитров там не будет; "
                         "сверь с reference.txt и добавь слова (asr.distribute_words)")
    else:
        words = asr.load_words(words_path)
        spoken = known
        if answer and spoken["source"] != "answer":  # Павел (или Claude) подтвердил язык: заново не распознаём
            spoken = {**spoken, "source": "answer", "sure": True}
            job.write("language.json", spoken)
        notes.append(f"Язык: {spoken['name']} ({spoken['code']}, {SOURCE[spoken['source']]})")
        notes.append("Речь уже расшифрована (words.json) — распознавание не повторял; заново — --redo")

    if recognise or not cuts_path.is_file():
        step("Ищу паузы", "Отмечаю паузы и смены сцены")
        speech = json.loads(speech_path.read_text(encoding="utf-8")) if speech_path.is_file() else []
        keep = [(round(a, 6), round(b, 6)) for a, b in plan_keep(words, info.duration, speech=speech)]
        kept = sum(b - a for a, b in keep)
        cuts = {"duration": round(info.duration, 3), "keep": [list(k) for k in keep], "cut_seconds": round(info.duration - kept, 3),
                "joins": scene_cuts(source)}
        _write_cuts(cuts_path, cuts)
    else:
        cuts = json.loads(cuts_path.read_text(encoding="utf-8"))
        keep = [tuple(k) for k in cuts["keep"]]
        kept = sum(b - a for a, b in keep)
    if recognise:
        contact_sheet(source, job.path("sheet.png"), fps=min(1.0, SHEET_THUMBS / info.duration))
    if redo or not job.path("editor.json").is_file():  # для редактора на странице (бета); прокси уйдёт в релиз с push
        step("Готовлю редактор", "Прокси-видео, волна и лента кадров для редактора")
        notes.append(_editor_files(job))

    cut_line = f"Слов: {len(words)}; плотная резка: {max(0, len(keep) - 1)} пауз, вырезано {cuts['cut_seconds']:.1f} с"
    speech_spans = json.loads(speech_path.read_text(encoding="utf-8")) if speech_path.is_file() else []
    soft = plan_keep(words, info.duration, speech=speech_spans, **SOFT)
    soft_line = f"мягкая: {max(0, len(soft) - 1)} пауз → {sum(b - a for a, b in soft):.1f} с"
    summary = [
        f"Длительность: {info.duration:.1f} с, кадр {info.width}×{info.height}",
        f"{cut_line} → {kept:.1f} с; {soft_line} (до ускорения)",
        *notes,
    ]
    if "joins" in cuts:  # у задач до переходов поля нет
        joins = cuts["joins"]
        summary.append(f"Смены сцены (cuts.json joins): {', '.join(_clock(t) for t in joins)}" if joins
                       else "Резких смен кадра в исходнике нет (cuts.json joins пуст)")
    if recognise:
        lack = [name for name, ok in have.items() if not ok]
        summary.append(f"Модели: {', '.join(n for n, ok in have.items() if ok)}" + (f"; нет: {', '.join(lack)}" if lack else ""))
        if not have["Whisper"]:
            summary.append("Whisper нет: reference.txt пуст — слова правьте по смыслу")
        if not have["VAD"]:
            summary.append("VAD нет: паузы для кусков распознавания ищутся по громкости")
    summary += ["", "Текст (по фразам; слова — words.json):", *_lines(words)]
    if reference or (not recognise and job.path("reference.txt").is_file()):
        summary += ["", "Сплошной текст (Whisper) — reference.txt"]
    return "\n".join(summary)

