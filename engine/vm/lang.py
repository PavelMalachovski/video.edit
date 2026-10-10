"""Язык ролика: откуда он взялся (ТЗ, ответ Павла, речь) и чем его распознавать.

Этап 1 — языки на латинице и кириллице с пробелами между словами (`NAMES`). Русский распознаёт GigaAM, языки
модели Parakeet TDT v3 (`PARAKEET`, 25 европейских) — она же; остальные языки этапа 1 — Whisper с временем слов,
разложенным по фразам VAD (неточно: сводка `prepare` об этом предупреждает). Языки с другой письменностью (`STAGE2`:
греческий, арабский, иврит, китайский и т. д.) — второй этап: `engine` отказывает с понятным текстом.
Замеры: docs/spikes/2026-10-results.md, раздел «Другие языки».
"""
import re
from collections import Counter

# код ISO 639-1 → (название по-русски, начала слов, по которым язык узнаётся в ТЗ и ответах: по-русски, по-английски,
# на самом языке; в нижнем регистре, «ё» → «е»)
_STAGE1 = {
    "ru": ("русский", "русск", "russian"),
    "uk": ("украинский", "украинск", "ukrainian", "українськ"),
    "be": ("белорусский", "белорусск", "belarusian", "беларуск"),
    "bg": ("болгарский", "болгарск", "bulgarian", "българск"),
    "sr": ("сербский", "сербск", "serbian", "srpsk", "српск"),
    "mk": ("македонский", "македонск", "macedonian"),
    "kk": ("казахский", "казахск", "kazakh", "қазақ"),
    "mn": ("монгольский", "монгольск", "mongolian"),
    "tg": ("таджикский", "таджикск", "tajik"),
    "tt": ("татарский", "татарск", "tatar"),
    "ba": ("башкирский", "башкирск", "bashkir"),
    "en": ("английский", "английск", "english"),
    "de": ("немецкий", "немецк", "german", "deutsch"),
    "fr": ("французский", "французск", "french", "français", "francais"),
    "es": ("испанский", "испанск", "spanish", "español", "espanol"),
    "it": ("итальянский", "итальянск", "italian"),
    "pt": ("португальский", "португальск", "portugu"),
    "nl": ("нидерландский", "нидерландск", "голландск", "dutch", "nederlands"),
    "sv": ("шведский", "шведск", "swedish", "svensk"),
    "da": ("датский", "датск", "danish", "dansk"),
    "no": ("норвежский", "норвежск", "norwegian", "norsk"),
    "fi": ("финский", "финск", "finnish", "suomi"),
    "et": ("эстонский", "эстонск", "estonian", "eesti"),
    "lv": ("латышский", "латышск", "latvian", "latvieš"),
    "lt": ("литовский", "литовск", "lithuanian", "lietuvi"),
    "pl": ("польский", "польск", "polish", "polski"),
    "cs": ("чешский", "чешск", "czech", "česk", "češt", "cesk", "cest"),
    "sk": ("словацкий", "словацк", "slovak", "slovenč"),
    "sl": ("словенский", "словенск", "slovenian", "slovene", "slovenš"),
    "hr": ("хорватский", "хорватск", "croatian", "hrvatsk"),
    "bs": ("боснийский", "боснийск", "bosnian", "bosansk"),
    "hu": ("венгерский", "венгерск", "hungarian", "magyar"),
    "ro": ("румынский", "румынск", "romanian", "român"),
    "tr": ("турецкий", "турецк", "turkish", "türk", "turkce"),
    "az": ("азербайджанский", "азербайджанск", "azerbaijani", "azərbaycan"),
    "uz": ("узбекский", "узбекск", "uzbek", "o'zbek"),
    "id": ("индонезийский", "индонезийск", "indones"),
    "ms": ("малайский", "малайск", "malay", "melayu"),
    "vi": ("вьетнамский", "вьетнамск", "vietnam", "tiếng việt"),
    "ca": ("каталанский", "каталанск", "catalan", "català"),
    "gl": ("галисийский", "галисийск", "galician", "galego"),
    "eu": ("баскский", "баскск", "basque", "euskara"),
    "cy": ("валлийский", "валлийск", "welsh", "cymraeg"),
    "is": ("исландский", "исландск", "icelandic", "íslensk"),
    "mt": ("мальтийский", "мальтийск", "maltese", "malti"),
    "af": ("африкаанс", "африкаанс", "afrikaans"),
    "sw": ("суахили", "суахили", "swahili", "kiswahili"),
    "tl": ("тагальский", "тагальск", "tagalog", "filipino"),
    "sq": ("албанский", "албанск", "albanian", "shqip"),
    "la": ("латинский", "латинск", "latin"),
}
_STAGE2 = {
    "el": ("греческий", "греческ", "greek", "ελληνικ"),
    "ar": ("арабский", "арабск", "arabic"),
    "he": ("иврит", "иврит", "hebrew"),
    "yi": ("идиш", "идиш", "yiddish"),
    "fa": ("персидский", "персидск", "фарси", "persian", "farsi"),
    "ur": ("урду", "урду", "urdu"),
    "ps": ("пушту", "пушту", "pashto"),
    "zh": ("китайский", "китайск", "chinese", "mandarin"),
    "yue": ("кантонский", "кантонск", "cantonese"),
    "ja": ("японский", "японск", "japanese"),
    "ko": ("корейский", "корейск", "korean"),
    "hi": ("хинди", "хинди", "hindi"),
    "bn": ("бенгальский", "бенгальск", "bengali", "bangla"),
    "ta": ("тамильский", "тамильск", "tamil"),
    "te": ("телугу", "телугу", "telugu"),
    "mr": ("маратхи", "маратхи", "marathi"),
    "gu": ("гуджарати", "гуджарати", "gujarati"),
    "pa": ("панджаби", "панджаби", "пенджаби", "punjabi"),
    "ne": ("непальский", "непальск", "nepali"),
    "si": ("сингальский", "сингальск", "sinhala"),
    "th": ("тайский", "тайск", "thai"),
    "lo": ("лаосский", "лаосск", "lao"),
    "km": ("кхмерский", "кхмерск", "khmer"),
    "my": ("бирманский", "бирманск", "burmese", "myanmar"),
    "ka": ("грузинский", "грузинск", "georgian"),
    "hy": ("армянский", "армянск", "armenian"),
    "am": ("амхарский", "амхарск", "amharic"),
    "bo": ("тибетский", "тибетск", "tibetan"),
}
NAMES = {code: row[0] for code, row in _STAGE1.items()}  # этап 1: код → название по-русски
STAGE2 = {code: row[0] for code, row in _STAGE2.items()}  # второй этап: своя письменность
# языки NeMo Parakeet TDT 0.6B v3 (греческий у модели есть, но его письменность — второй этап)
PARAKEET = frozenset([
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it",
    "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk",
])  # fmt: skip
# языки Whisper (токены <|код|>): язык не из этого списка sherpa-onnx не принимает и завершает процесс — поэтому
# ирландского в этапе 1 нет
WHISPER = frozenset("""
en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk
te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo
ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue
""".split())  # noqa: SIM905
ALIASES = {"nn": "no", "nb": "no"}  # Whisper различает нюнорск и букмол; для нас это норвежский
# языки, которые Whisper путает между собой: все окна могут согласно ошибиться — Claude проверяет по тексту
CONFUSED = (("ru", "uk", "be"), ("bg", "mk"), ("sr", "hr", "bs"), ("cs", "sk"), ("no", "da", "sv"), ("id", "ms"))
_STEMS = [(code, stem) for table in (_STAGE1, _STAGE2) for code, row in table.items() for stem in row[1:]]
_FILLER = {"на", "язык", "языке", "language", "the"}
_BRIEF = re.compile(r"^[ \t]*язык[ \t]*[:—–-][ \t]*(.*?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_REGION = re.compile(r"^([a-z]{2,3})[-_][a-z0-9]{2,4}$")  # pt-BR, uk_UA
MAX_WORDS = 3  # «ЯЗЫК: на чешском» — язык; «Язык: простой, без английских слов» — уже не он


class Unsupported(ValueError):
    """Язык, который сервис пока не монтирует (письменность второго этапа или неизвестный код)."""


def name(code: str) -> str:
    return NAMES.get(code) or STAGE2.get(code) or code


def siblings(code: str) -> list[str]:
    """Языки, с которыми Whisper путает `code`."""
    return next(([c for c in group if c != code] for group in CONFUSED if code in group), [])


def parse(value: str) -> str | None:
    """Код языка по тому, как его написал человек: «cs», «Чешский», «на чешском», «čeština», «English». Не понял — None."""
    text = value.strip().lower().replace("ё", "е")
    if region := _REGION.match(text):
        text = region.group(1)
    if text in NAMES or text in STAGE2:
        return text
    for word in re.findall(r"[\w']+", text):
        if word in _FILLER:
            continue
        for code, stem in _STEMS:
            if word.startswith(stem) or (" " in stem and stem in text):
                return code
    return None


def from_brief(brief: str) -> tuple[str | None, str | None]:
    """Строка `ЯЗЫК: …` в ТЗ → (код, None); строки нет — (None, None); язык не понят — (None, как написано)."""
    match = _BRIEF.search(brief or "")
    if not match or not match.group(1):
        return None, None
    if len(re.findall(r"[\w']+", match.group(1))) > MAX_WORDS:
        return None, match.group(1)
    code = parse(match.group(1))
    return (code, None) if code else (None, match.group(1))


def vote(votes: list[str]) -> tuple[str, bool]:
    """Язык по окнам записи, которые определил Whisper: большинство (при равенстве — что раньше в записи), уверены —
    если все окна согласны. Голосов нет (нет Whisper) — русский, не уверены."""
    if not votes:
        return "ru", False
    counts = Counter(votes)
    best = max(counts.values())
    return next(v for v in votes if counts[v] == best), len(counts) == 1


def decide(brief: str, votes: list[str], answer: str | None = None) -> dict:
    """Содержимое language.json: ответ Павла важнее ТЗ, ТЗ — важнее речи."""
    if answer is not None:
        code = parse(answer)
        if code is None:
            raise ValueError(f"не понял язык «{answer}»: напиши код (cs) или название (чешский)")
        source, sure = "answer", True
    elif code := from_brief(brief)[0]:
        source, sure = "brief", True
    elif votes:
        heard = [ALIASES.get(v, v) for v in votes]
        code, sure = vote(heard)
        known = [v for v in heard if v in NAMES or v in STAGE2]
        if code not in NAMES and code not in STAGE2 and known:  # редкий код Whisper (haw, jw…) уступает известному
            code, sure = vote(known)[0], False
        source = "detected"
    else:
        code, source, sure = "ru", "default", False
    return {"code": code, "name": name(code), "source": source, "sure": sure, "votes": list(votes)}


def engine(code: str) -> str:
    """Чем распознавать: `gigaam` (русский), `parakeet` (языки Parakeet), `whisper` (прочие языки этапа 1);
    письменность второго этапа или неизвестный код — Unsupported."""
    if code == "ru":
        return "gigaam"
    if code in NAMES:
        return "parakeet" if code in PARAKEET else "whisper"
    if code in STAGE2:
        raise Unsupported(f"Язык {STAGE2[code]} пока не поддерживается: его письменность — второй этап")
    raise Unsupported(f"Язык «{code}» пока не поддерживается")
