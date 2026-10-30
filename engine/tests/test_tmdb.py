"""Кадры из TMDB для разбора персонажа (vm tmdb): что ищем, что скачиваем, куда кладём — на подставном API."""
import io
import json

import pytest
from PIL import Image

from vm import tmdb
from vm.job import Job


def jpeg(color=(200, 30, 30), size=(780, 439)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, "JPEG")
    return out.getvalue()


class FakeApi:
    """Ответы TMDB по пути запроса; картинки — по пути на image.tmdb.org. Запоминает, что спрашивали."""

    def __init__(self, routes: dict, images: dict | None = None):
        self.routes, self.images, self.asked = routes, images or {}, []

    def __call__(self, url: str, token: str) -> bytes:
        self.asked.append(url)
        assert url.startswith(tmdb.IMG) or token == "secret", "токен — только API, не CDN картинок"
        if url.startswith(tmdb.IMG):
            path = url.split("/t/p/", 1)[1].split("/", 1)[1]
            return self.images.get("/" + path) or jpeg()
        path = url.removeprefix(tmdb.API).split("?", 1)[0]
        if path not in self.routes:
            raise tmdb.TmdbError(f"404 {path}")
        return json.dumps(self.routes[path]).encode()


LOKI = {
    "/search/multi": {"results": [
        {"media_type": "movie", "id": 846214, "title": "Симпсоны: Добрый, Бартистый и Локистый", "original_title": "The Good, the Bart, and the Loki"},
        {"media_type": "tv", "id": 84958, "name": "Локи", "original_name": "Loki"},
        {"media_type": "person", "id": 91606, "name": "Tom Hiddleston"},
    ]},
    "/tv/84958/images": {"backdrops": [
        {"file_path": "/b1.jpg", "iso_639_1": None, "vote_average": 5.5, "width": 3840, "height": 2160},
        {"file_path": "/b2.jpg", "iso_639_1": "en", "vote_average": 5.9, "width": 3840, "height": 2160},  # с надписью — ниже
        {"file_path": "/b3.jpg", "iso_639_1": None, "vote_average": 5.7, "width": 1920, "height": 1080},
    ]},
    "/tv/84958/aggregate_credits": {"cast": [
        {"id": 1, "name": "Owen Wilson", "roles": [{"character": "Mobius"}]},
        {"id": 91606, "name": "Tom Hiddleston", "roles": [{"character": "Loki Laufeyson"}]},
    ]},
    "/person/91606/images": {"profiles": [{"file_path": "/p1.jpg", "vote_average": 5.3}, {"file_path": "/p2.jpg", "vote_average": 5.6}]},
    "/person/91606/tagged_images": {"results": [
        {"file_path": "/t1.jpg", "image_type": "backdrop", "media_type": "tv", "media": {"id": 84958}},
        {"file_path": "/t2.jpg", "image_type": "backdrop", "media_type": "movie", "media": {"id": 10195}},  # другой фильм
        {"file_path": "/t3.jpg", "image_type": "poster", "media_type": "tv", "media": {"id": 84958}},
    ]},
}


def job_with(tmp_path, character) -> Job:
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("job.json", {"id": "abc", "brief": "", "runs": [], "uploads": [], "format": "character", "character": character})
    return job


def test_tmdb_finds_the_series_its_stills_the_character_and_his_photos(tmp_path):
    job = job_with(tmp_path, {"film": "Локи", "name": "Локи"})
    api = FakeApi(LOKI)
    found = tmdb.find(job, token="secret", get=api)
    assert found["title"] == {"kind": "tv", "id": 84958, "name": "Локи"}, "сериал по точному названию, а не первый в поиске"
    assert found["person"] == {"id": 91606, "name": "Tom Hiddleston"}, "актёр — по имени персонажа в ролях"
    kinds = [(f["kind"], f["source"]) for f in found["files"]]
    assert kinds == [("still", "/t1.jpg"), ("still", "/b3.jpg"), ("still", "/b1.jpg"), ("still", "/b2.jpg"),
                     ("photo", "/p2.jpg"), ("photo", "/p1.jpg")], "кадры с актёром из этого сериала, потом кадры без надписей, потом фото"
    for n, f in enumerate(found["files"], 1):
        assert f["file"] == f"found/tmdb-{n}.jpg" and job.path(f["file"]).is_file()
    assert json.loads(job.path("found/tmdb.json").read_text(encoding="utf-8")) == found
    assert job.path(found["sheet"]).is_file()
    assert any("/w780/" in u for u in api.asked) and any("/h632/" in u for u in api.asked), "кадры — w780, фото — h632"


def test_the_actor_named_by_pavel_wins_over_the_character(tmp_path):
    routes = {**LOKI, "/search/person": {"results": [{"id": 1, "name": "Owen Wilson"}]}}
    routes["/person/1/images"] = {"profiles": [{"file_path": "/o.jpg", "vote_average": 5}]}
    routes["/person/1/tagged_images"] = {"results": []}
    found = tmdb.find(job_with(tmp_path, {"film": "Loki", "actor": "Owen Wilson"}), token="secret", get=FakeApi(routes))
    assert found["person"] == {"id": 1, "name": "Owen Wilson"}


def test_limits_and_no_title_found(tmp_path):
    many = {**LOKI, "/tv/84958/images": {"backdrops": [{"file_path": f"/x{k}.jpg", "iso_639_1": None, "vote_average": 5, "width": 1920,
                                                        "height": 1080} for k in range(30)]}}
    found = tmdb.find(job_with(tmp_path, {"film": "Локи"}), token="secret", get=FakeApi(many))
    assert sum(f["kind"] == "still" for f in found["files"]) == tmdb.STILLS
    with pytest.raises(tmdb.TmdbError, match="не нашёл"):
        tmdb.find(job_with(tmp_path / "2", {"film": "Нет такого"}), token="secret", get=FakeApi({"/search/multi": {"results": []}}))


def test_without_a_token_or_a_breakdown_there_is_nothing_to_do(tmp_path, monkeypatch):
    monkeypatch.delenv("TMDB_TOKEN", raising=False)
    with pytest.raises(tmdb.TmdbError, match="TMDB_TOKEN"):
        tmdb.find(job_with(tmp_path, {"film": "Локи"}))
    plain = Job(tmp_path / "jobs" / "plain")
    plain.root.mkdir(parents=True)
    plain.write("job.json", {"id": "plain", "brief": "", "runs": [], "uploads": []})
    with pytest.raises(tmdb.TmdbError, match="не разбор"):
        tmdb.find(plain, token="secret", get=FakeApi(LOKI))


def test_the_summary_lists_each_file_for_claude():
    found = {"title": {"kind": "tv", "id": 1, "name": "Локи"}, "person": {"id": 2, "name": "Tom Hiddleston"}, "sheet": "look/found.png",
             "files": [{"file": "found/tmdb-1.jpg", "kind": "still", "source": "/a.jpg", "width": 780, "height": 439},
                       {"file": "found/tmdb-2.jpg", "kind": "photo", "source": "/b.jpg", "width": 421, "height": 632}]}
    text = tmdb.summary(found)
    assert "Локи" in text and "Tom Hiddleston" in text and "found/tmdb-1.jpg — кадр" in text and "found/tmdb-2.jpg — фото" in text
    assert "look/found.png" in text


def test_vm_tmdb_says_why_there_is_nothing_and_does_not_fail(tmp_path, monkeypatch, capsys):
    from vm.__main__ import main

    monkeypatch.delenv("TMDB_TOKEN", raising=False)
    job = job_with(tmp_path, {"film": "Локи"})
    main(["tmdb", str(job.root)])
    assert "TMDB_TOKEN" in capsys.readouterr().out
