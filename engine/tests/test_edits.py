"""Правки Павла руками в редакторе (timeline.json) поверх монтажа сессии (edit.json): куски, голос, музыка, звуки."""
import json
from pathlib import Path

import pytest

from vm import edits
from vm.job import Job

SHARED = json.loads((Path(__file__).parent / "fixtures" / "edits.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", SHARED["cases"], ids=lambda c: c["name"])
def test_keep_matches_the_shared_fixture(case):
    assert edits.apply_keep(case["keep"], case["edits"], case["duration"]) == case["expected"]
    assert edits.SLIVER == SHARED["sliver"]


@pytest.mark.parametrize("bad", SHARED["refused"])
def test_a_broken_edit_is_refused_with_its_number(bad):
    with pytest.raises(ValueError, match="edits\\[1\\]"):
        edits.apply_keep([[0, 3]], [{"op": "cut", "t0": 0, "t1": 0.5}, bad], 4)


EDIT = {
    "speed": 1.1, "keep": [[0.5, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
    "face": {"x": 0.5, "y": 0.4}, "music": {"file": "assets/music/a.mp3", "gainDb": -14}, "hold": 0, "style": {},
}


def test_sound_edits_reach_the_edit():
    timeline = {
        "rev": 3, "edits": [{"op": "cut", "t0": 1, "t1": 2}],
        "voice": {"gainDb": -3, "muted": False},
        "music": {"gainDb": -20, "at": 1.5, "from": 12, "fadeIn": 0.5, "fadeOut": 2},
        "sounds": {"insert:0": {"gainDb": 4, "muted": False}, "teaser": {"gainDb": 0, "muted": True}},
    }
    out = edits.apply(EDIT, timeline, 5)
    assert out["keep"] == [[0.5, 1], [2, 4.0]]
    assert out["voice"] == {"gainDb": -3, "muted": False}
    assert out["music"] == {"file": "assets/music/a.mp3", "gainDb": -20, "at": 1.5, "from": 12, "fadeIn": 0.5, "fadeOut": 2}
    assert out["sounds"] == timeline["sounds"]
    assert EDIT["keep"] == [[0.5, 4.0]], "edit.json сессии не меняется"


def test_muted_music_is_no_music_and_without_music_there_is_nothing_to_adjust():
    assert edits.apply(EDIT, {"rev": 1, "edits": [], "music": {"muted": True}}, 5)["music"] is None
    assert edits.apply({**EDIT, "music": None}, {"rev": 1, "edits": [], "music": {"gainDb": -8}}, 5)["music"] is None


def test_no_timeline_is_the_session_edit_as_is():
    assert edits.apply(EDIT, None, 5) is EDIT


def test_edit_of_reads_timeline_json_from_the_job(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.path("edit.json").write_text(json.dumps(EDIT), encoding="utf-8")
    assert edits.edit_of(job, 5)["keep"] == [[0.5, 4.0]]
    job.write("timeline.json", {"rev": 2, "at": "2026-10-12T15:00:00Z", "edits": [{"op": "cut", "t0": 3, "t1": 4.5}]})
    assert edits.edit_of(job, 5)["keep"] == [[0.5, 3]]


@pytest.mark.parametrize("bad", [
    {"rev": 0, "edits": []},
    {"rev": 1, "edits": [{"op": "cut", "t0": -1, "t1": 1}]},
    {"rev": 1, "edits": [{"op": "jump", "t": 1}]},
    {"rev": 1, "edits": [], "voice": {"gainDb": 40}},
    {"rev": 1, "edits": [], "music": {"fadeIn": 20}},
    {"rev": 1, "edits": [], "sounds": {"insert:0": {"gainDb": "громче"}}},
    {"rev": 1, "edits": [], "extra": True},
])
def test_the_schema_refuses_a_broken_timeline(tmp_path, bad):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    with pytest.raises(ValueError):
        job.write("timeline.json", bad)
