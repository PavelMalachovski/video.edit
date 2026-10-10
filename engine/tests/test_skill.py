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


def test_the_page_contract_names_what_the_page_reads_and_waits_for():
    page = section("Страница")
    for must in ("job.json", "answers.json", "restyle.json", "fix.json", "<qid>.own", "needs: answers", "sample.inserts",
                 "vm style", "released.json", "final-v<version>.mp4", "PNG"):
        assert must in page, must
    assert "vm style" in section("Команды движка")
    assert "vm style" in section("Шаг render")


def test_the_rules_work_in_the_language_of_the_video():
    frame = section("1. Кадр")
    assert "только русская" not in frame and "language.json" in frame
    texts = section("6. Тексты")
    assert "Parakeet" in texts and "языке ролика" in texts  # звёздочки и слова — на языке ролика
    assert "vm fonts" in section("2. Стиль A — домашний стиль Павла")


def test_the_service_part_knows_the_language_and_the_fonts():
    commands = section("Команды движка")
    assert "--lang" in commands and "vm fonts" in commands
    assert "language.json" in section("Файлы задачи")
    assert "--lang" in section("Шаг analyze") and "--lang" in section("Шаг render")
    assert "`language`" in section("Вопросы (questions.json)")
    assert "vm fonts" in section("Стили (styles.json)")
    assert "пока не поддерживается" in section("Ошибки")


def test_the_steps_say_what_to_do_when_language_or_fonts_go_wrong():
    analyze = section("Шаг analyze")
    assert "проверь" in analyze  # язык по речи проверяется всегда, не только при «ВНИМАНИЕ»
    render = section("Шаг render")
    assert "vm fonts" in render and "unsure" in render  # другой язык — заново хук, звёздочки, шрифты
    assert "эмодзи" in section("6. Тексты").lower()
