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


def test_pavel_may_put_the_subtitles_low_down_to_just_above_the_time_bar(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("answers.json", {**FIXTURE["answers"], "style": {**FIXTURE["answers"]["style"], "subY": 1760}})


@pytest.mark.parametrize("sub_y", [100, 1780, "1200"])
def test_a_subtitle_place_outside_the_safe_zone_is_refused(tmp_path, sub_y):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    with pytest.raises(ValueError, match="subY"):
        job.write("answers.json", {**FIXTURE["answers"], "style": {**FIXTURE["answers"]["style"], "subY": sub_y}})


def test_the_hook_stays_where_the_variant_has_it_unless_pavel_moved_it():
    answers = {**FIXTURE["answers"], "style": {k: v for k, v in FIXTURE["answers"]["style"].items() if k != "hookY"}}
    variant = next(v for v in FIXTURE["styles"]["variants"] if v["id"] == answers["style"]["variant"])
    assert final_style(FIXTURE["styles"], answers)["hook"].get("y") == variant["spec"]["hook"].get("y")


@pytest.mark.parametrize("hook_y", [150, 1400, "500"])
def test_a_hook_place_outside_the_safe_zone_is_refused(tmp_path, hook_y):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    with pytest.raises(ValueError, match="hookY"):
        job.write("answers.json", {**FIXTURE["answers"], "style": {**FIXTURE["answers"]["style"], "hookY": hook_y}})


def test_sizes_stay_as_in_the_variant_unless_pavel_changed_them():
    style = {k: v for k, v in FIXTURE["answers"]["style"].items() if k not in ("subSize", "hookSize")}
    variant = next(v for v in FIXTURE["styles"]["variants"] if v["id"] == style["variant"])
    spec = final_style(FIXTURE["styles"], {**FIXTURE["answers"], "style": style})
    assert (spec["subtitles"]["size"], spec["hook"]["size"]) == (variant["spec"]["subtitles"]["size"], variant["spec"]["hook"]["size"])


@pytest.mark.parametrize("key, size", [("subSize", 30), ("subSize", 120), ("hookSize", 40), ("hookSize", 130), ("hookSize", "80")])
def test_a_size_out_of_range_is_refused(tmp_path, key, size):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    with pytest.raises(ValueError, match=key):
        job.write("answers.json", {**FIXTURE["answers"], "style": {**FIXTURE["answers"]["style"], key: size}})


def test_no_shade_under_the_subtitles_unless_pavel_turned_it_on():
    style = {k: v for k, v in FIXTURE["answers"]["style"].items() if k != "subShade"}
    assert "shade" not in final_style(FIXTURE["styles"], {**FIXTURE["answers"], "style": style})["subtitles"]


@pytest.mark.parametrize("shade", [-0.1, 0.85, "0.5"])
def test_a_shade_out_of_range_is_refused(tmp_path, shade):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    with pytest.raises(ValueError, match="subShade"):
        job.write("answers.json", {**FIXTURE["answers"], "style": {**FIXTURE["answers"]["style"], "subShade": shade}})
    styles = json.loads(json.dumps(FIXTURE["styles"]))
    styles["variants"][0]["spec"]["subtitles"]["shade"] = shade
    with pytest.raises(ValueError, match="shade"):
        job.write("styles.json", styles)


# ---------- место и размер вставок ----------

BOXES = json.loads((Path(__file__).parent / "fixtures" / "insert-boxes.json").read_text(encoding="utf-8"))


def test_insert_boxes_match_the_shared_fixture():
    from vm.style import placed_inserts

    assert placed_inserts(BOXES["inserts"], BOXES["boxes"]) == BOXES["expected"]
    assert placed_inserts(BOXES["inserts"], {}) == BOXES["inserts"]


def test_answers_take_insert_boxes_within_the_safe_zone(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("answers.json", {**FIXTURE["answers"], "insertBoxes": {"insert-1": {"x": 60, "y": 420, "w": 330}}})
    bad_boxes = (
        {"insert-1": {"x": 60, "y": 420}},  # без ширины
        {"insert-1": {"x": 20, "y": 420, "w": 330}},
        {"insert-1": {"x": 60, "y": 60, "w": 330}},
        {"insert-1": {"x": 60, "y": 420, "w": 900}},
        {"insert-1": 330},  # прежний формат — только ширина
    )
    for bad in bad_boxes:
        with pytest.raises(ValueError, match="insertBoxes"):
            job.write("answers.json", {**FIXTURE["answers"], "insertBoxes": bad})
