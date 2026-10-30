"""Кадры из TMDB для разбора персонажа (vm tmdb): что ищем, что скачиваем, куда кладём — на подставном API."""
import io
import json

import pytest
from PIL import Image

from vm import tmdb
from vm.job import Job


def jpeg(seed: str = "", size=(780, 439)) -> bytes:
    """Картинка со своим рисунком (у каждого пути — свой): одинаковые по смыслу картинки отсеиваются как повторы."""
    import hashlib

    from PIL import ImageDraw

    h = hashlib.sha1(seed.encode()).digest()
    im = Image.new("RGB", size, (h[0], h[1], h[2]))
    draw = ImageDraw.Draw(im)
    for k in range(6):
        x, y = h[3 + k] * size[0] // 256, h[9 + k] * size[1] // 256
        draw.rectangle((x, y, x + size[0] // 3, y + size[1] // 3), fill=(255 - h[k], h[k + 4], 255 - h[k + 8]))
    out = io.BytesIO()
    im.save(out, "JPEG")
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
            return self.images.get("/" + path) or jpeg("/" + path)
        path = url.removeprefix(tmdb.API).split("?", 1)[0]
        if path not in self.routes:
            raise tmdb.TmdbError(f"404 {path}")
        return json.dumps(self.routes[path]).encode()


LOKI = {
    "/search/movie": {"results": [
        {"id": 846214, "title": "Симпсоны: Добрый, Бартистый и Локистый", "original_title": "The Good, the Bart, and the Loki", "popularity": 9.1},
    ]},
    "/search/tv": {"results": [
        {"id": 28511, "name": "Мифический детектив Локи: Рагнарёк", "original_name": "Mythical Detective Loki Ragnarok", "popularity": 3.2},
        {"id": 99999, "name": "Локи", "original_name": "Loki", "popularity": 0.8},  # одноимённое и малоизвестное
        {"id": 84958, "name": "Локи", "original_name": "Loki", "popularity": 120.5},
    ]},
    "/tv/84958/images": {"backdrops": [
        {"file_path": "/b1.jpg", "iso_639_1": None, "vote_average": 5.5, "width": 3840, "height": 2160},
        {"file_path": "/b2.jpg", "iso_639_1": "en", "vote_average": 5.9, "width": 3840, "height": 2160},  # с надписью — ниже
        {"file_path": "/b3.jpg", "iso_639_1": None, "vote_average": 5.7, "width": 1920, "height": 1080},
    ]},
    "/tv/84958": {"seasons": [{"season_number": 0}, {"season_number": 1}]},  # 0 — спецвыпуски
    "/tv/84958/season/1": {"episodes": [{"still_path": "/e1.jpg"}, {"still_path": None}, {"still_path": "/e2.jpg"}]},
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
    assert found["title"] == {"kind": "tv", "id": 84958, "name": "Локи"}, "точное название, из одноимённых — самое популярное"
    assert found["person"] == {"id": 91606, "name": "Tom Hiddleston"}, "актёр — по имени персонажа в ролях"
    kinds = [(f["kind"], f["source"]) for f in found["files"]]
    assert kinds == [("still", "/t1.jpg"), ("still", "/e1.jpg"), ("still", "/e2.jpg"), ("still", "/b3.jpg"), ("still", "/b1.jpg"),
                     ("still", "/b2.jpg"), ("photo", "/p2.jpg"), ("photo", "/p1.jpg")], \
        "кадры с актёром из этого сериала, кадры серий (настоящие кадры, а не арт), потом картинки сериала, потом фото"
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
        tmdb.find(job_with(tmp_path / "2", {"film": "Нет такого"}), token="secret",
                  get=FakeApi({"/search/movie": {"results": []}, "/search/tv": {"results": []}}))


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


def test_a_character_named_in_russian_is_found_among_roles_written_in_latin():
    # в ролях TMDB имена — латиницей: Гермиона — Hermione Granger, Гарри — Harry Potter, Локи — Loki Laufeyson
    roles = ["Harry Potter", "Hermione Granger", "Rubeus Hagrid", "Loki Laufeyson", "Mobius", "Baron", "Ron Weasley",
             "Walter White", "Jack Torrance", "Mary Poppins", "Jesse Pinkman", "Данила Багров"]
    names = ("Гермиона", "Гарри", "Хагрид", "Локи", "Мобиус", "Гэндальф", "Рон", "Уолтер Уайт", "Джек", "Мэри", "Джесси",
             "Данила Багров", "Hermione")
    assert [tmdb.role_of(name, roles) for name in names] == [
        "Hermione Granger", "Harry Potter", "Rubeus Hagrid", "Loki Laufeyson", "Mobius", None, "Ron Weasley", "Walter White",
        "Jack Torrance", "Mary Poppins", "Jesse Pinkman", "Данила Багров", "Hermione Granger"]


def test_near_duplicate_pictures_are_kept_once(tmp_path):
    # у TMDB одна и та же картинка лежит в разных размерах и с разным языком — вторую не берём
    same = jpeg("/twin")
    smaller = io.BytesIO()
    Image.open(io.BytesIO(same)).resize((390, 220)).save(smaller, "JPEG", quality=70)
    api = FakeApi(LOKI, images={"/b1.jpg": same, "/b3.jpg": smaller.getvalue()})
    found = tmdb.find(job_with(tmp_path, {"film": "Локи", "name": "Локи"}), token="secret", get=api)
    sources = [f["source"] for f in found["files"]]
    assert ("/b1.jpg" in sources) != ("/b3.jpg" in sources), sources


def test_the_best_matching_role_wins_across_the_cast(tmp_path):
    routes = {**LOKI, "/tv/84958/aggregate_credits": {"cast": [
        {"id": 7, "name": "Someone", "roles": [{"character": "Lokir"}]},  # похоже, но хуже
        {"id": 91606, "name": "Tom Hiddleston", "roles": [{"character": "Loki"}]},
    ]}}
    found = tmdb.find(job_with(tmp_path, {"film": "Локи", "name": "Локи"}), token="secret", get=FakeApi(routes))
    assert found["person"]["id"] == 91606


def test_a_broken_answer_or_picture_does_not_crash_the_step_or_leave_stale_files(tmp_path):
    job = job_with(tmp_path, {"film": "Локи", "name": "Локи"})
    tmdb.find(job, token="secret", get=FakeApi(LOKI))
    before = len(list(job.path("found").glob("tmdb-*.jpg")))
    bad = FakeApi(LOKI, images={"/b3.jpg": b"<html>proxy error</html>"})
    found = tmdb.find(job, token="secret", get=bad)  # битая картинка — пропущена, остальные на месте
    assert "/b3.jpg" not in [f["source"] for f in found["files"]] and len(found["files"]) == before - 1
    assert sorted(p.name for p in job.path("found").glob("tmdb-*.jpg")) == sorted(f["file"].split("/")[1] for f in found["files"])

    def broken(url, token):
        return b"not json"
    with pytest.raises(tmdb.TmdbError):
        tmdb.find(job, token="secret", get=broken)
    assert not job.path("found/tmdb.json").exists(), "старый список не указывает на чужие файлы"


def test_the_token_is_not_carried_over_a_redirect():
    req = tmdb._request("https://api.themoviedb.org/3/configuration", "secret")
    assert "Authorization" not in req.headers and req.unredirected_hdrs.get("Authorization") == "Bearer secret"


def test_a_huge_episode_still_is_kept_at_most_1280_px(tmp_path):
    api = FakeApi(LOKI, images={"/e1.jpg": jpeg("/e1", size=(3840, 2160))})
    found = tmdb.find(job_with(tmp_path, {"film": "Локи", "name": "Локи"}), token="secret", get=api)
    big = next(f for f in found["files"] if f["source"] == "/e1.jpg")
    assert (big["width"], big["height"]) == (1280, 720)
    assert any("/original/e1.jpg" in u for u in api.asked), "кадры серий — в original: других больших размеров у них нет"
