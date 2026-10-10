"""Язык ролика: из ТЗ, по голосам Whisper, путь распознавания, языки второго этапа."""
import pytest

from vm import lang


@pytest.mark.parametrize(
    "brief, code",
    [
        ("ЯЗЫК: чешский", "cs"),
        ("Хук: привет\nязык: cs\nМУЗЫКА: нет", "cs"),
        ("ЯЗЫК — английский", "en"),
        ("Язык: English.", "en"),
        ("ЯЗЫК: Deutsch", "de"),
        ("ЯЗЫК: на украинском", "uk"),
        ("ЯЗЫК:польский", "pl"),
        ("  язык : Русский  ", "ru"),
        ("ЯЗЫК: čeština", "cs"),
    ],
)
def test_language_from_the_brief(brief, code):
    assert lang.from_brief(brief) == (code, None)


@pytest.mark.parametrize("brief", ["", "ХУК: на английском языке не надо", "Сними меня красиво"])
def test_no_language_line_in_the_brief(brief):
    assert lang.from_brief(brief) == (None, None)


def test_a_language_line_that_is_not_understood_is_reported_not_guessed():
    assert lang.from_brief("ЯЗЫК: эльфийский") == (None, "эльфийский")


def test_language_from_an_answer_accepts_codes_and_names():
    assert lang.parse("sk") == "sk"
    assert lang.parse("Словацкий") == "sk"
    assert lang.parse("klingon") is None


def test_votes_that_agree_are_sure():
    assert lang.vote(["cs", "cs", "cs"]) == ("cs", True)


def test_votes_that_disagree_take_the_majority_and_are_not_sure():
    assert lang.vote(["uk", "ru", "uk"]) == ("uk", False)


def test_a_tie_goes_to_the_first_window():
    assert lang.vote(["sk", "cs"]) == ("sk", False)


def test_no_votes_is_russian_and_not_sure():
    assert lang.vote([]) == ("ru", False)


def test_decide_prefers_the_brief_over_the_votes():
    info = lang.decide("ЯЗЫК: чешский", ["sk", "sk"])
    assert info == {"code": "cs", "name": "чешский", "source": "brief", "sure": True, "votes": ["sk", "sk"]}


def test_decide_by_the_votes():
    assert lang.decide("", ["en", "en"]) == {"code": "en", "name": "английский", "source": "detected", "sure": True, "votes": ["en", "en"]}


def test_decide_without_whisper_is_russian_by_default_and_not_sure():
    assert lang.decide("", []) == {"code": "ru", "name": "русский", "source": "default", "sure": False, "votes": []}


def test_decide_with_an_answer_beats_everything():
    info = lang.decide("ЯЗЫК: чешский", ["sk"], answer="pl")
    assert (info["code"], info["source"], info["sure"]) == ("pl", "answer", True)


def test_decide_with_an_answer_that_is_not_a_language_fails():
    with pytest.raises(ValueError, match="эльфийский"):
        lang.decide("", ["en"], answer="эльфийский")


@pytest.mark.parametrize(
    "code, engine",
    [("ru", "gigaam"), ("en", "parakeet"), ("cs", "parakeet"), ("uk", "parakeet"), ("de", "parakeet"),
     ("sr", "whisper"), ("tr", "whisper"), ("vi", "whisper")],
)  # fmt: skip
def test_engine_for_a_language(code, engine):
    assert lang.engine(code) == engine


@pytest.mark.parametrize("code, name", [("el", "греческий"), ("ar", "арабский"), ("zh", "китайский"), ("ja", "японский"),
                                        ("hi", "хинди"), ("th", "тайский"), ("he", "иврит")])  # fmt: skip
def test_second_stage_languages_are_refused_with_a_clear_message(code, name):
    with pytest.raises(lang.Unsupported, match=f"{name}.*пока не поддерживается"):
        lang.engine(code)


def test_an_unknown_code_is_refused():
    with pytest.raises(lang.Unsupported, match="xx"):
        lang.engine("xx")


def test_every_first_stage_language_has_a_russian_name_and_an_engine():
    for code in lang.NAMES:
        assert lang.NAMES[code] and lang.engine(code) in {"gigaam", "parakeet", "whisper"}


def test_parakeet_languages_are_first_stage_except_greek():
    assert lang.PARAKEET - set(lang.NAMES) == {"el"}
