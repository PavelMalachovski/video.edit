"""Буквы в шрифтах: есть ли в выбранном шрифте все буквы текста ролика (ролик может быть на любом языке этапа 1).

Каталог — как у шаблона: встроенные шрифты из `template/fonts.json` и свои шрифты Павла из `assets/fonts/` (правило
`template/fonts.mjs`: id — имя файла без расширения, «-hand» в конце — рукописный, встроенный с тем же id важнее).
Буквы шрифта — его таблица символов (cmap, fontTools). Буквы текста — сам текст и он же капсом (хук — капсом); в
счёт идут буквы, цифры, знаки препинания и валют. Невидимые символы (пробелы, U+200B/U+200D, мягкий перенос,
селекторы вариантов) глифа не требуют. Эмодзи шаблон рисует картинками (vm/emoji.py) — им шрифт не нужен; прочие
картинки-символы (♪, ❤ без U+FE0F) не рисует никто — это отдельная проблема `check`: их надо убрать из текста.
Субтитры — слова, как сказаны: эмодзи в них тоже проблема.

Основной шрифт рисует субтитры, хук, строки титра и тексты вставок; рукописный — последнее слово хука и кодовое
слово титра. Буквы, которой нет в шрифте, браузер подставит из другого шрифта — превью и ролик разойдутся, — поэтому
`vm check` и `vm render` такой стиль не пропускают (`check`), а `vm fonts` говорит, какие шрифты подходят тексту.
"""
import json
import unicodedata
from dataclasses import dataclass
from functools import cache
from pathlib import Path

from . import emoji

REPO = Path(__file__).resolve().parents[2]
TEMPLATE = REPO / "template"
CUSTOM = REPO / "assets" / "fonts"
FONT_FILE = {".ttf", ".otf"}
INVISIBLE = {*range(0xFE00, 0xFE10), *range(0xE0100, 0xE01F0), *range(0x1F3FB, 0x1F400)}  # селекторы, оттенки кожи


@dataclass(frozen=True)
class Font:
    id: str
    kind: str  # main | hand
    path: Path


def catalog(custom: Path | None = None) -> list[Font]:
    """Встроенные шрифты и свои (`custom`, по умолчанию assets/fonts) — одним списком, без повторов id."""
    built = [
        Font(f["id"], f["kind"], TEMPLATE / f["file"])
        for f in json.loads((TEMPLATE / "fonts.json").read_text(encoding="utf-8"))
    ]
    known = {f.id for f in built}
    folder = CUSTOM if custom is None else custom
    files = sorted(p for p in folder.iterdir() if p.suffix.lower() in FONT_FILE) if folder.is_dir() else []
    for path in files:
        if path.stem not in known:  # A.ttf и A.otf — один id, берём первый
            known.add(path.stem)
            built.append(Font(path.stem, "hand" if path.stem.lower().endswith("-hand") else "main", path))
    return built


@cache
def _cmap(path: Path) -> frozenset[int]:
    from fontTools.ttLib import TTFont  # тяжёлый импорт — только когда он нужен

    with TTFont(path, lazy=True) as font:
        return frozenset(font.getBestCmap())


def _drawn(c: str) -> bool:
    """Нужен ли символу глиф шрифта: буквы, знаки, цифры, препинание, валюты — да; невидимые и эмодзи — нет."""
    category = unicodedata.category(c)
    return ord(c) not in INVISIBLE and (category[0] in "LMNP" or category in ("Sc", "Sm", "Sk"))


def missing(font: Font, text: str) -> str:
    """Буквы текста (и его капса), которых нет в шрифте, по порядку кодов; пробелы, невидимые и эмодзи — не буквы."""
    have = _cmap(font.path)
    text = emoji.text_only(text)
    return "".join(sorted(c for c in set(text) | set(text.upper()) if _drawn(c) and ord(c) not in have))


def symbols(text: str) -> str:
    """Картинки-символы текста, которых нет среди эмодзи-картинок (♪, ❤ без U+FE0F): их не рисует никто."""
    return "".join(sorted({c for c in emoji.text_only(text) if unicodedata.category(c) == "So"}))


def _hand_word(title: str) -> str:
    """Рукописная часть хука (и обложки): последнее слово вместе с эмодзи после него — как hookTitle в
    template/overlay.js."""
    words = title.split()
    last = len(words) - 1
    while last > 0 and emoji.emoji_only(words[last]):
        last -= 1
    return " ".join(words[max(last, 0):])


def texts(edit: dict) -> tuple[str, str]:
    """Текст ролика и обложки из edit.json: (что рисует основной шрифт, что — рукописный)."""
    hook = (edit.get("hook") or {}).get("text") or ""
    cover = (edit.get("cover") or {}).get("text") or ""  # обложка — тот же хук другим текстом
    cta = edit.get("cta") or {}
    main = [w.get("text", "") for w in edit.get("words") or []]
    main += [hook, cover, *(cta.get("lines") or [])]
    main += [i.get(key) or "" for i in edit.get("inserts") or [] for key in ("title", "text")]
    card = edit.get("end") or {}
    main += [*(card.get("lines") or []), card.get("handle") or ""]  # финальная карточка — основным шрифтом
    hand = [_hand_word(hook), cta.get("word") or "", _hand_word(cover)]
    return "\n".join(main), " ".join(part for part in hand if part)


def coverage(main_text: str, hand_text: str, custom: Path | None = None) -> dict[str, list[str]]:
    """Шрифты, в которых есть все буквы: основные — для `main_text`, рукописные — для `hand_text`."""
    fonts = catalog(custom)
    return {
        kind: [f.id for f in fonts if f.kind == kind and not missing(f, text)]
        for kind, text in (("main", main_text), ("hand", hand_text))
    }


def check(edit: dict, custom: Path | None = None) -> list[str]:
    """Проблемы шрифтов стиля edit.json: в основном или рукописном нет букв ролика. Неизвестный id — не здесь."""
    fonts = {f.id: f for f in catalog(custom)}
    style = edit.get("style") or {}
    main_text, hand_text = texts(edit)
    problems = []
    if odd := symbols(f"{main_text}{hand_text}"):
        plain = [c for c in odd if emoji.text_default(c)]
        hint = f" ({', '.join(plain)} — эмодзи только с U+FE0F после знака: {', '.join(c + chr(0xFE0F) for c in plain)})" if plain else ""
        problems.append(f"символы {odd} не рисует ни шрифт ролика, ни эмодзи-картинки — убери их или замени эмодзи{hint}; "
                        "скажи об этом в unsure")
    if said := emoji.found(" ".join(w.get("text", "") for w in edit.get("words") or [])):
        problems.append(f"эмодзи {' '.join(dict.fromkeys(said))} в субтитрах — субтитры только слова, как сказаны: убери их из words")
    for kind, text in (("main", main_text), ("hand", hand_text)):
        font = fonts.get(style.get("font" if kind == "main" else "hand") or "")
        if font is None or not (lack := missing(font, text)):
            continue
        fits = coverage(main_text, hand_text, custom)[kind]
        role = "основном" if kind == "main" else "рукописном"
        problems.append(f"в {role} шрифте {font.id} нет букв {lack} — возьми тот, где они есть: {', '.join(fits) or 'таких нет'}")
    return problems
