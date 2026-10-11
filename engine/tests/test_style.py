"""Итоговый стиль ролика: вариант, выбранный Павлом на превью, с его шрифтами и тремя цветами. То же правило —
у страницы (web/lib/style.ts), обе стороны сверяются с общей фикстурой tests/fixtures/style-merge.json."""
import json
from pathlib import Path

import pytest

from vm.job import Job
from vm.style import final_style

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "style-merge.json").read_text(encoding="utf-8"))


def test_final_style_matches_shared_fixture(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("styles.json", FIXTURE["styles"])  # фикстура — настоящие файлы задачи: проходят схемы
    job.write("answers.json", FIXTURE["answers"])
    assert final_style(FIXTURE["styles"], FIXTURE["answers"]) == FIXTURE["expected"]


def test_final_style_names_a_missing_variant():
    styles = {**FIXTURE["styles"], "variants": FIXTURE["styles"]["variants"][:1]}
    with pytest.raises(ValueError, match="B"):
        final_style(styles, FIXTURE["answers"])


def test_subtitles_stay_where_the_variant_has_them_unless_pavel_moved_them():
    answers = {**FIXTURE["answers"], "style": {k: v for k, v in FIXTURE["answers"]["style"].items() if k != "subY"}}
    variant = next(v for v in FIXTURE["styles"]["variants"] if v["id"] == answers["style"]["variant"])
    assert final_style(FIXTURE["styles"], answers)["subtitles"]["y"] == variant["spec"]["subtitles"]["y"]


@pytest.mark.parametrize("sub_y", [100, 1500, "1200"])
def test_a_subtitle_place_outside_the_safe_zone_is_refused(tmp_path, sub_y):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    with pytest.raises(ValueError, match="subY"):
        job.write("answers.json", {**FIXTURE["answers"], "style": {**FIXTURE["answers"]["style"], "subY": sub_y}})
