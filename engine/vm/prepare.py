"""Подготовка задачи к монтажу: исходник, звук, слова, план мягкой резки, контактный лист — и сводка для Claude.

Части из `in/` (видео) → `source.mp4` (1080×1920 SDR 30 к/с) → `work/source.wav` (16 кГц) → `words.json` (GigaAM),
`reference.txt` (сплошной текст Whisper, по нему Claude правит слова), `cuts.json` (`plan_keep`), `sheet.png`.
Какие модели были и каких нет — в сводке: без GigaAM работать нельзя, без Whisper и VAD — можно, но хуже.
"""
import json
import math
from collections.abc import Callable

from . import asr
from .cuts import plan_keep
from .job import Job
from .media import contact_sheet, extract_wav, normalize

VIDEO = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".3gp", ".hevc"}
SHEET_THUMBS = 60  # кадров на контактном листе — не больше, иначе лист выходит в десятки тысяч пикселей
PHRASE_GAP = 0.6  # с — пауза, после которой сводка начинает новую строку текста


def models() -> tuple[list[str], list[str]]:
    """(что есть, чего нет) из моделей распознавания; без GigaAM — ValueError."""
    have, lack = [], []
    gigaam = asr._model("ASR_MODEL", asr.GIGAAM)
    if asr._missing(gigaam, asr.GIGAAM_FILES):
        raise ValueError(f"нет модели распознавания GigaAM ({gigaam}): запустите setup/cloud-setup.sh")
    have.append("GigaAM")
    whisper = asr._model("ASR_REF_MODEL", asr.WHISPER)
    (lack if asr._missing(whisper, asr.WHISPER_FILES) else have).append("Whisper")
    vad = asr._model("VAD_MODEL", asr.SILERO)
    (have if vad.is_file() else lack).append("VAD")
    return have, lack


def _clock(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def _lines(words: list[asr.Word]) -> list[str]:
    """Текст по фразам с временем начала — чтобы Claude находил места «добавь сюда»."""
    out, phrase, start = [], [], 0.0
    for i, w in enumerate(words):
        if not phrase:
            start = w.t0
        phrase.append(w.text)
        if i + 1 == len(words) or words[i + 1].t0 - w.t1 > PHRASE_GAP:
            out.append(f"[{_clock(start)}] {' '.join(phrase)}")
            phrase = []
    return out


def prepare(job: Job, step: Callable[[str, str], None] | None = None) -> str:
    """Готовит задачу; `step(фаза, текст)` зовётся на каждой смене фазы. → сводка для Claude."""
    step = step or (lambda phase, message: None)
    folder = job.path("in")
    parts = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in VIDEO) if folder.is_dir() else []
    if not parts:
        raise ValueError(f"{folder}: нет видео — сначала python -m vm fetch {job.root}")
    have, lack = models()

    step("Готовлю видео", "Привожу к 1080×1920, 30 к/с, SDR")
    info = normalize(parts, job.path("source.mp4"))
    if not (math.isfinite(info.duration) and info.duration > 0):
        raise ValueError(f"source.mp4: непонятная длительность {info.duration!r}")
    wav = extract_wav(job.path("source.mp4"), job.path("work/source.wav"))

    step("Расшифровываю", "Слушаю речь и расставляю слова по времени")
    words = asr.transcribe(wav)
    asr.save_words(words, job.path("words.json"))
    reference = asr.reference_text(wav) if "Whisper" in have else ""
    job.path("reference.txt").write_text(reference + ("\n" if reference else ""), encoding="utf-8")

    step("Ищу паузы", "Отмечаю длинные паузы для мягкой резки")
    keep = [(round(a, 6), round(b, 6)) for a, b in plan_keep(words, info.duration)]
    kept = sum(b - a for a, b in keep)
    cuts = {"duration": round(info.duration, 3), "keep": [list(k) for k in keep], "cut_seconds": round(info.duration - kept, 3)}
    job.path("cuts.json").write_text(json.dumps(cuts, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    contact_sheet(job.path("source.mp4"), job.path("sheet.png"), fps=min(1.0, SHEET_THUMBS / info.duration))

    cut_line = f"Слов: {len(words)}; мягкая резка: {max(0, len(keep) - 1)} пауз, вырезано {cuts['cut_seconds']:.1f} с"
    summary = [
        f"Длительность: {info.duration:.1f} с, кадр {info.width}×{info.height}",
        f"{cut_line} → {kept:.1f} с (до ускорения)",
        f"Модели: {', '.join(have)}" + (f"; нет: {', '.join(lack)}" if lack else ""),
    ]
    if "Whisper" in lack:
        summary.append("Whisper нет: reference.txt пуст — слова правьте по смыслу")
    if "VAD" in lack:
        summary.append("VAD нет: паузы для кусков распознавания ищутся по громкости")
    summary += ["", "Текст (GigaAM, по фразам):", *_lines(words)]
    if reference:
        summary += ["", "Сплошной текст (Whisper) — reference.txt"]
    return "\n".join(summary)

