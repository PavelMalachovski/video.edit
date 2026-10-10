"""SKILL.md — инструкция, которую рутина исполняет буквально. Здесь закреплены места, где буквальное исполнение
ломало ролик (финальное ревью Плана 2): место вставки «добавь сюда» между шагами, лицо из примера, долгая фаза
без статуса, тихая запись и предел зумов."""
import re
from pathlib import Path

SKILL = (Path(__file__).resolve().parents[2] / ".claude" / "skills" / "video-montage" / "SKILL.md").read_text(encoding="utf-8")


def section(title: str) -> str:
    """Раздел `## <title>…` до следующего заголовка того же или старшего уровня."""
    start = SKILL.index(f"## {title}")
    nxt = re.search(r"^#{1,2} ", SKILL[start + 3 :], re.MULTILINE)
    return SKILL[start : start + 3 + nxt.start()] if nxt else SKILL[start:]


def test_planned_inserts_keep_their_place_from_analyze_to_render():
    analyze, render = section("Шаг analyze"), section("Шаг render")
    assert '"question": "insert-' in analyze, "черновик edit.json хранит место и время вставки «добавь сюда»"
    assert "question" in render and "место и время" in render


def test_the_edit_draft_has_no_literal_face():
    analyze = section("Шаг analyze")
    assert not re.search(r'"face":\s*\{\s*"x":\s*[\d.]+', analyze), "лицо — по кадрам, а не числа из примера"


def test_analyze_refreshes_the_status_before_the_long_text_work():
    analyze = section("Шаг analyze")
    looking, fixing = analyze.index('--phase "Смотрю кадры"'), analyze.index('--phase "Правлю текст"')
    assert looking < fixing < analyze.index('job.write("edit.json"')
    assert "25 мин" in section("Команды движка"), "страница считает шаг зависшим — скажи, как часто обновлять статус"


def test_quiet_recordings_and_the_zoom_cap_are_in_the_rules():
    assert "тихая запись" in section("5. Звук").lower()
    assert "90" in section("4. Зумы")
