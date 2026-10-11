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


def test_the_speed_pavel_picks_reaches_the_video():
    assert "answers.speed" in section("3. Скорость и резка")
    render = section("Шаг render")
    assert "answers.speed" in render and "until" in render  # хук уходит по времени исходника — пересчитать по скорости


def test_subtitles_pavel_dragged_stay_where_he_put_them():
    render = section("Шаг render")
    assert "subY" in render and "хук" in render  # мешают — двигается хук или вставка, а не субтитры


def test_a_hook_pavel_dragged_stays_where_he_put_it():
    render = section("Шаг render")
    assert "hookY" in render and "unsure" in render


def test_sizes_pavel_set_stay():
    render = section("Шаг render")
    assert "subSize" in render and "hookSize" in render


def test_insert_sizes_pavel_set_reach_the_video():
    render = section("Шаг render")
    assert "insertBoxes" in render and "placed_inserts" in render


def test_emoji_are_allowed_as_pictures_but_not_in_subtitles():
    texts = section("6. Тексты")
    assert "Эмодзи" in texts and "картинками" in texts and "U+FE0F" in texts
    assert "В субтитрах\n  эмодзи нет" in texts or "В субтитрах эмодзи нет" in texts
    assert "убери их (и из своего\n  хука" not in texts  # старое «эмодзи — убери всегда» ушло


def test_style_a_follows_pavels_brand():
    style = section("2. Стиль A — домашний стиль Павла")
    assert "job.json.brand" in style and "vm fonts" in style
    page = section("Страница")
    assert "brand" in page and "in/brand/logo.png" in page and "hashtags" in page
    assert "бренда Павла" in section("Стили (styles.json)")


def test_thesis_stickers_have_rules_a_question_and_a_render_step():
    inserts = section("7. Вставки")
    assert "`text` — стикер-тезис" in inserts and "`id`" in inserts and "2–5 на ролик" in inserts
    assert "`stickers` (multi)" in section("Вопросы (questions.json)")
    assert "стикеры-тезисы" in section("Шаг render") and "`stickers`" in section("Шаг render")
    assert "стикеры-тезисы" in section("Страница")


def test_the_end_card_has_a_rule_a_question_a_sample_and_a_render_step():
    rules = section("8. Стоп-кадр и финальная карточка")
    assert "end: {seconds, lines, handle, logo, sfx}" in rules and "только здесь" in rules
    assert "`end` (choice)" in section("Вопросы (questions.json)")
    assert "sample.end" in section("Стили (styles.json)")
    render = section("Шаг render")
    assert "финальная карточка" in render and 'answers["end.own"]' in render


def test_the_post_caption_has_a_rule_and_a_place_in_the_render_step():
    texts = section("6. Тексты")
    assert "Подпись к посту" in texts and "72 знаках" in texts and "brand.signature" in texts
    render = section("Шаг render")
    assert "`caption`" in render and "`done`, `unsure` и `caption` сохраняет" in render


def test_the_teaser_has_a_rule_a_question_and_a_render_step():
    texts = section("6. Тексты")
    assert "**Тизер**" in texts and "teaser: {t0, t1, sfx}" in texts and "Хук стоит на тизере" in texts
    assert "`teaser` (choice)" in section("Вопросы (questions.json)")
    assert "тизер: ответ `teaser`" in section("Шаг render")


def test_the_second_version_for_an_a_b_test_reaches_the_render_step():
    assert "`ab` — вторая версия для A/B-теста" in section("Страница")
    render = section("Шаг render")
    assert "A/B-тест: `answers.ab` → `edit.json.ab`" in render and "final-b.mp4" in render and "result.json.ab" in render
    assert "final-v<version>-b.mp4" in section("Шаг fix"), "правка — в обеих версиях"


def test_beats_have_a_rule_and_a_way_to_switch_them_off():
    sound = section("5. Звук")
    assert "**В такт**" in sound and "`music.beats: false`" in sound and "0,25 с" in sound
    assert "в такт музыке" in section("Шаг render")


def test_the_analyze_step_writes_the_guide_review_and_render_writes_the_checklist():
    analyze = section("Шаг analyze")
    assert "`review.json`" in analyze and "`status`" in analyze and "`warn`" in analyze
    for key in ("hook", "face", "value", "cta", "text", "length", "sound", "story"):
        assert f"`{key}`" in analyze, key
    files = section("Файлы задачи")
    assert "| `review.json` |" in files and "`checklist`" in files


def test_a_script_job_has_its_own_section_and_the_analyze_step_sends_there():
    script = section("Сценарий (задача без видео)")
    assert "`script.json`" in script and "`script_ready`" in script and "`job.json.script`" in script
    for key in ("hook", "hold", "reward", "sound", "motion", "engage", "value", "emotion", "tutorial", "before_after"):
        assert f"`{key}`" in script, key
    assert "раздел «Сценарий (задача без видео)»" in section("Шаг analyze")
    assert "| `script.json` |" in section("Файлы задачи") and "`kind`" in section("Файлы задачи")


def test_a_brief_from_a_script_feeds_the_stickers_and_the_end_card():
    rules = section("7. Вставки") + section("8. Стоп-кадр и финальная карточка")
    assert "`ТЕЗИСЫ:`" in rules and "`ПРИЗЫВ:`" in rules
