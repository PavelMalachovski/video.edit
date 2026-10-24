"""Команды `python -m vm …` для Claude: fetch, prepare, frames, preview, render, push.

GitHub подменяет маленький HTTP-сервер на 127.0.0.1 (релизы, ассеты, переход на «подписанную» ссылку), git —
настоящие репозитории во временных папках. Сквозной prepare → render — медленный (модели, ffmpeg, Chromium).
"""
import hashlib
import json
import random
import re
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pytest

from vm.__main__ import main
from vm.job import Job

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")
MB = 1024 * 1024

STYLE = {
    "font": "montserrat",
    "hand": "caveat",
    "colors": {"text": "#FFFFFF", "accent": "#FFD23F", "bar": "#FFD23F", "plate": "#111111", "outline": "#000000"},
    "subtitles": {"mode": "karaoke", "words": 3, "size": 64, "y": 1300},
    "hook": {"mode": "plate", "size": 72},
    "bar": {"pos": "bottom", "height": 14},
}


# ---------- поддельный GitHub ----------


class Fake:
    def __init__(self):
        self.releases: list[dict] = []
        self.assets: dict[int, list[dict]] = {}
        self.blobs: dict[int, bytes] = {}
        self.downloads = 0
        self.release_pages = 0
        self.ids: dict[str, int] = {}
        self.cut_once: set[int] = set()  # эти ассеты в первый раз отдаются наполовину и рвут соединение
        self.ranges: list[tuple[int, str]] = []  # (ассет, Range) — запросы диапазонов
        self._next = 100

    def draft(self, tag: str, files: dict[str, bytes]) -> None:
        """Черновик `tag` с ассетами `files` (имя → байты) в случайном порядке."""
        rid = len(self.releases) + 1
        self.releases.append({"id": rid, "tag_name": tag, "draft": True, "assets": []})
        items = []
        for name, body in files.items():
            self._next += 1
            self.blobs[self._next] = body
            self.ids[name] = self._next
            items.append({"id": self._next, "name": name, "size": len(body)})
        random.Random(7).shuffle(items)
        self.assets[rid] = items


def parts(name: str, body: bytes, size: int) -> dict[str, bytes]:
    """Куски `<name>.part-NNNNN` по `size` байт, как их грузит страница."""
    return {f"{name}.part-{i:05d}": body[k : k + size] for i, k in enumerate(range(0, len(body), size))}


@pytest.fixture
def github(monkeypatch):
    fake = Fake()

    class Handler(BaseHTTPRequestHandler):
        def _json(self, data):
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # имя задаёт BaseHTTPRequestHandler
            url = urlparse(self.path)
            page = int(parse_qs(url.query).get("page", ["1"])[0])
            if url.path == "/repos/o/r/releases":
                fake.release_pages += 1
                return self._json(fake.releases[(page - 1) * 2 : page * 2])  # тоже по два на страницу
            if m := re.fullmatch(r"/repos/o/r/releases/(\d+)/assets", url.path):
                items = fake.assets.get(int(m[1]), [])
                return self._json(items[(page - 1) * 2 : page * 2])  # по два на страницу: листание обязательно
            if m := re.fullmatch(r"/repos/o/r/releases/assets/(\d+)", url.path):
                assert self.headers.get("Accept") == "application/octet-stream"
                self.send_response(302)
                self.send_header("Location", f"/blob/{int(m[1])}")
                self.end_headers()
                return None
            if m := re.fullmatch(r"/blob/(\d+)", url.path):
                fake.downloads += 1
                body = fake.blobs[int(m[1])]
                if span := re.fullmatch(r"bytes=(\d+)-(\d+)", self.headers.get("Range") or ""):  # как хранилище GitHub
                    fake.ranges.append((int(m[1]), span[0]))
                    first, last = int(span[1]), min(int(span[2]), len(body) - 1)
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {first}-{last}/{len(body)}")
                    body = body[first : last + 1]
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if int(m[1]) in fake.cut_once:
                    fake.cut_once.discard(int(m[1]))
                    self.wfile.write(body[: len(body) // 2])
                    self.close_connection = True
                    return None
                self.wfile.write(body)
                return None
            self.send_response(404)
            self.end_headers()
            return None

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("GITHUB_API_URL", f"http://127.0.0.1:{server.server_port}")
    monkeypatch.setenv("VM_REPO", "o/r")
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    yield fake
    server.shutdown()


def manifest(name: str, body: bytes, count: int, **extra) -> bytes:
    return json.dumps({"job": "abc", "name": name, "size": len(body), "type": "video/quicktime", "parts": count, **extra}).encode()


def test_fetch_joins_parts_in_order(tmp_path, github):
    body = random.Random(1).randbytes(10_000)
    files = parts("source", body, 3000)  # 4 куска, последний короче
    github.draft("job-abc", {**files, "manifest.json": manifest("IMG_0001.MOV", body, len(files))})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 0
    assert (job / "in" / "source.mov").read_bytes() == body


def test_fetch_joins_uploads_too(tmp_path, github):
    body = random.Random(2).randbytes(5000)
    pic = random.Random(3).randbytes(2500)
    uploads = [{"asset": "upload-i1.png", "name": "логотип.PNG", "size": len(pic), "type": "image/png", "parts": 2}]
    github.draft(
        "job-abc",
        {**parts("source", body, 3000), **parts("upload-i1.png", pic, 2000), "manifest.json": manifest("a.mp4", body, 2, uploads=uploads)},
    )
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 0
    assert (job / "in" / "uploads" / "upload-i1.png").read_bytes() == pic
    assert (job / "in" / "source.mp4").read_bytes() == body


def test_fetch_joins_upload_parts(tmp_path, github):
    body = random.Random(6).randbytes(7000)
    clip = random.Random(7).randbytes(4500)
    uploads = [{"asset": "upload-i1.mov", "name": "демо.mov", "size": len(clip), "type": "video/quicktime", "parts": 3}]
    pieces = {**parts("upload-i1.mov", clip, 2000), **parts("source", body, 3000)}
    shuffled = dict(sorted(pieces.items(), key=lambda kv: random.Random(8).random()))  # куски вперемешку
    github.draft("job-abc", {**shuffled, "manifest.json": manifest("a.mov", body, 3, uploads=uploads)})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 0
    assert (job / "in" / "uploads" / "upload-i1.mov").read_bytes() == clip
    assert (job / "in" / "source.mov").read_bytes() == body


def test_fetch_takes_only_referenced_uploads(tmp_path, github):
    # заново выбранная картинка к ответу лежит новым ассетом, а брошенная (оборванная) осталась в черновике:
    # качаются исходник, вставки манифеста и картинки ответов, остальное — нет, иначе дыра в брошенной валит шаг
    body = random.Random(11).randbytes(5000)
    pic = random.Random(12).randbytes(2500)
    insert = random.Random(13).randbytes(1500)
    gone = parts("upload-q-logo.png", random.Random(14).randbytes(5000), 2000)
    gone.pop("upload-q-logo.png.part-00000")  # загрузка оборвалась
    dropped = parts("upload-i2.mov", random.Random(15).randbytes(3000), 2000)  # не выбрана заново при продолжении
    uploads = [{"asset": "upload-i1.png", "name": "a.png", "size": len(insert), "type": "image/png", "parts": 1}]
    github.draft("job-abc", {**parts("source", body, 3000), **parts("upload-i1.png", insert, 2000), **gone, **dropped,
                             **parts("upload-q-logo-2.png", pic, 2000), "manifest.json": manifest("a.mp4", body, 2, uploads=uploads)})
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("answers.json", {"answers": {"logo": "upload"}, "uploads": {"logo": "in/uploads/upload-q-logo-2.png"},
                               "style": {"variant": "A", "font": "montserrat", "hand": "caveat",
                                         "colors": {"text": "#FFFFFF", "accent": "#FFD23F", "bar": "#FFD23F"}}})
    assert main(["fetch", str(job.root)]) == 0
    assert job.path("in/uploads/upload-q-logo-2.png").read_bytes() == pic
    assert job.path("in/uploads/upload-i1.png").read_bytes() == insert
    assert not job.path("in/uploads/upload-q-logo.png").exists() and not job.path("in/uploads/upload-i2.mov").exists()


def test_fetch_rejects_upload_size_mismatch(tmp_path, github, capsys):
    body = random.Random(9).randbytes(5000)
    pic = random.Random(10).randbytes(2500)
    uploads = [{"asset": "upload-i1.png", "name": "a.png", "size": len(pic) + 1, "type": "image/png", "parts": 2}]
    github.draft("job-abc", {**parts("source", body, 3000), **parts("upload-i1.png", pic, 2000),
                             "manifest.json": manifest("a.mp4", body, 2, uploads=uploads)})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 1
    assert "upload-i1.png" in capsys.readouterr().err
    assert not (job / "in" / "uploads" / "upload-i1.png").exists()


def test_cli_style_prints_final_spec(tmp_path, capsys):
    fixture = json.loads((Path(__file__).parent / "fixtures" / "style-merge.json").read_text(encoding="utf-8"))
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("styles.json", fixture["styles"])
    job.write("answers.json", fixture["answers"])
    assert main(["style", str(job.root)]) == 0
    assert json.loads(capsys.readouterr().out) == fixture["expected"]


def test_cli_style_onto_lays_the_editor_style_over_the_video_style(tmp_path, capsys):
    """«Монтировать» из редактора со стилем: в последней правке fix.json — прошлый выбор (`styleFrom`); `vm style
    --onto` берёт из нового выбора только то, что Павел поменял, остальное — из edit.json.style (правки текстом)."""
    fixture = json.loads((Path(__file__).parent / "fixtures" / "style-merge.json").read_text(encoding="utf-8"))
    old = {k: v for k, v in fixture["answers"]["style"].items() if k != "subShade"}  # выбор Павла без затемнения
    new = {**old, "colors": {**old["colors"], "accent": "#FF3B30"}}
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.write("styles.json", fixture["styles"])
    job.write("answers.json", {**fixture["answers"], "style": new})
    job.write("edit.json", {"speed": 1.0, "keep": [[0.0, 1.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
                            "face": {"x": 0.5, "y": 0.3}, "music": None, "hold": 0.0,
                            "style": fixture["expected"]})  # стиль ролика: тот выбор + затемнение 0,6 из правки текстом
    job.write("fix.json", {"fixes": [{"text": "Правки в редакторе", "at": "2026-10-12T15:00:00Z", "version": 2, "style": True, "styleFrom": old}]})
    assert main(["style", str(job.root), "--onto"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["colors"]["accent"] == "#FF3B30" and out["subtitles"]["shade"] == 0.6
    job.write("fix.json", {"fixes": [{"text": "x", "at": "2026-10-12T15:00:00Z", "version": 2}]})
    assert main(["style", str(job.root), "--onto"]) == 0
    assert "shade" not in json.loads(capsys.readouterr().out)["subtitles"], "прошлого выбора нет — новый стиль целиком"


def test_fetch_rejects_a_size_mismatch(tmp_path, github, capsys):
    body = random.Random(4).randbytes(6000)
    files = parts("source", body, 3000)
    files.pop("source.part-00001")  # кусок потерян
    github.draft("job-abc", {**files, "manifest.json": manifest("a.mov", body, 2)})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 1
    assert "source" in capsys.readouterr().err
    assert not (job / "in" / "source.mov").exists()


def test_fetch_takes_every_video_of_the_job_in_order(tmp_path, github):
    first = random.Random(21).randbytes(7000)
    second = random.Random(22).randbytes(4000)
    videos = [{"asset": "source", "name": "IMG_1.MOV", "size": len(first), "type": "video/quicktime", "parts": 3},
              {"asset": "source-2", "name": "IMG_2.mp4", "size": len(second), "type": "video/mp4", "parts": 2}]
    github.draft("job-abc", {**parts("source", first, 3000), **parts("source-2", second, 3000),
                             "manifest.json": manifest("IMG_1.MOV", first, 3, videos=videos)})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 0
    assert (job / "in" / "source.mov").read_bytes() == first
    assert (job / "in" / "source-2.mp4").read_bytes() == second


@pytest.mark.parametrize("videos", [
    [{"asset": "../x", "name": "a.mov", "size": 3000, "parts": 1}],  # не видео задачи
    [{"asset": "source-2", "name": "a.mov", "size": 3000, "parts": 1}],  # первое — не source
    [{"asset": "source", "name": "a.mov", "size": 3000, "parts": 1}, {"asset": "source", "name": "b.mov", "size": 3000, "parts": 1}],
    "source",
])
def test_fetch_refuses_a_video_list_the_page_does_not_write(tmp_path, github, capsys, videos):
    body = random.Random(23).randbytes(3000)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 1, videos=videos)})
    assert main(["fetch", str(tmp_path / "jobs" / "abc")]) == 1
    assert "videos" in capsys.readouterr().err


def test_fetch_twice_downloads_once(tmp_path, github):
    body = random.Random(5).randbytes(6000)
    files = parts("source", body, 3000)
    github.draft("job-abc", {**files, "manifest.json": manifest("a.mov", body, 2)})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 0
    first = github.downloads
    assert main(["fetch", str(job)]) == 0
    assert github.downloads - first == 1, "only manifest.json again — the joined file is already there"


def ready_job(tmp_path, body: bytes, analyzed: bool = True, **extra):
    """Задача с job.json (по нему — ключ готового исходника) для fetch; `analyzed` — анализ уже в ветке (editor.json
    есть: шаги render и fix)."""
    from vm import source

    job = Job(tmp_path / "jobs" / "abc")
    job.write("job.json", {"id": "abc", "name": "a.mov", "size": len(body), "type": "video/quicktime", "duration": 3,
                           "createdAt": "2026-10-13T10:10:10Z", "brief": "", "uploads": [], "runs": [], **extra})
    if analyzed:
        job.write("editor.json", {"duration": 3.0, "proxy": None, "film": {"file": "film.jpg", "step": 1.0, "w": 54, "h": 96, "n": 3},
                                  "peaks": {"perS": 10, "data": ""}})
    return job, source.asset(job)


def ready_files(name: str, ready: bytes, size: int = 3000, **over) -> dict[str, bytes]:
    """Готовый исходник в черновике, как его кладёт Action job-source: куски и (последним) описание."""
    import hashlib

    pieces = parts(name, ready, size)
    info = {"size": len(ready), "sha256": hashlib.sha256(ready).hexdigest(), "parts": len(pieces), "normalize": 1, **over}
    return {**pieces, name.removesuffix(".mp4") + ".json": json.dumps(info).encode()}


def test_fetch_takes_the_ready_source_instead_of_the_videos(tmp_path, github, capsys):
    """Action job-source уже сделал исходник: качается он, а не видео Павла (2 ГБ 4K) — prepare не нормализует заново."""
    body = random.Random(31).randbytes(9000)
    ready = random.Random(32).randbytes(7000)
    job, name = ready_job(tmp_path, body)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 3), **ready_files(name, ready)})
    assert main(["fetch", str(job.root)]) == 0
    assert job.path("source.mp4").read_bytes() == ready
    assert not job.path("in/source.mov").exists(), "видео Павла не качалось"
    assert "готовый исходник" in capsys.readouterr().out
    assert main(["fetch", str(job.root), "--originals"]) == 0, "для vm prepare --redo — видео Павла"
    assert job.path("in/source.mov").read_bytes() == body


def test_fetch_takes_a_big_piece_in_ranges_side_by_side(tmp_path, github, monkeypatch):
    """Готовый исходник лежит кусками по 256 МБ: целый кусок одним соединением шёл и 111 с, когда соседний — 4 с, и
    держал весь fetch (2 ГБ — 111 с; диапазонами по 16 МБ в 16 соединений — 9 с). Большой кусок качается диапазонами
    `RANGE` параллельно; оборванный диапазон — заново, остальные — нет."""
    from vm import fetch as fetch_mod

    monkeypatch.setattr(fetch_mod, "RANGE", 1000)
    body = random.Random(41).randbytes(9000)
    ready = random.Random(42).randbytes(7000)
    job, name = ready_job(tmp_path, body)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 3),
                             **ready_files(name, ready, size=3500)})
    piece = github.ids[f"{name}.part-00000"]
    github.cut_once = {piece}
    assert main(["fetch", str(job.root)]) == 0
    assert job.path("source.mp4").read_bytes() == ready
    asked = [r for i, r in github.ranges if i == piece]
    assert sorted(set(asked)) == ["bytes=0-999", "bytes=1000-1999", "bytes=2000-2999", "bytes=3000-3499"]
    assert len(asked) == 5, "оборванный диапазон — ещё раз"


def test_fetch_takes_the_videos_for_the_analysis_even_with_the_ready_source(tmp_path, github):
    """Анализ (editor.json ещё нет: первый запуск, повтор после сбоя, «Повторить без озвучки») качает видео Павла даже
    при готовом исходнике: по ним prepare размечает, где какое видео (editor.json.videos, «Видео по порядку»)."""
    body = random.Random(35).randbytes(9000)
    ready = random.Random(36).randbytes(7000)
    job, name = ready_job(tmp_path, body, analyzed=False)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 3), **ready_files(name, ready)})
    assert main(["fetch", str(job.root)]) == 0
    assert job.path("in/source.mov").read_bytes() == body
    assert not job.path("source.mp4").exists(), "исходник анализ делает сам — из видео"


def test_fetch_brings_the_matte_of_the_last_render(tmp_path, github):
    """Маска затемнения фона прошлого рендера (render кладёт её в out/, Action — в черновик) → work/matte/cache-<ключ>.*:
    правка берёт из неё готовые отрезки, а не считает минуты заново. Маска другого исходника (ключ не тот) не качается;
    уже скачанная — второй раз тоже."""
    from vm import matte

    body = random.Random(37).randbytes(9000)
    ready = random.Random(38).randbytes(7000)
    job, name = ready_job(tmp_path, body)
    key = matte.job_key(job)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 3), **ready_files(name, ready),
                             f"matte-{key}.mkv": b"mask" * 100, f"matte-{key}.json": b'{"plan": [[0, 100]]}',
                             "matte-0123456789ab.mkv": b"other", "matte-0123456789ab.json": b'{"plan": []}'})
    assert main(["fetch", str(job.root)]) == 0
    assert sorted(p.name for p in job.path("work/matte").iterdir()) == [f"cache-{key}.json", f"cache-{key}.mkv"]
    assert job.path(f"work/matte/cache-{key}.mkv").read_bytes() == b"mask" * 100
    assert job.path(f"work/matte/cache-{key}.json").read_bytes() == b'{"plan": [[0, 100]]}'
    first = github.downloads
    assert main(["fetch", str(job.root)]) == 0
    assert github.downloads - first == 2, "снова только manifest.json и описание исходника"


def test_fetch_starts_warming_what_the_step_reads_next(tmp_path, github, monkeypatch):
    """`vm fetch` — первая команда шага: пока качается видео, отдельный процесс читает модели (анализ: editor.json ещё
    нет) или Chromium и модель маски (рендер, правки)."""
    from vm import warm

    started = []
    monkeypatch.setattr(warm, "start", lambda analyze: started.append(analyze))
    body = random.Random(40).randbytes(6000)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 2)})
    job, _ = ready_job(tmp_path, body, analyzed=False)
    assert main(["fetch", str(job.root)]) == 0
    job.write("editor.json", {"duration": 3.0, "proxy": None, "film": {"file": "film.jpg", "step": 1.0, "w": 54, "h": 96, "n": 3},
                              "peaks": {"perS": 10, "data": ""}})
    assert main(["fetch", str(job.root)]) == 0
    assert started == [True, False]


def test_fetch_for_the_analysis_brings_no_matte(tmp_path, github):
    """Анализ (editor.json ещё нет) не рендерит — маска ему не нужна."""
    from vm import matte

    body = random.Random(39).randbytes(9000)
    job, _ = ready_job(tmp_path, body, analyzed=False)
    key = matte.job_key(job)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 3),
                             f"matte-{key}.mkv": b"mask", f"matte-{key}.json": b'{"plan": []}'})
    assert main(["fetch", str(job.root)]) == 0
    assert not job.path("work/matte").exists()


@pytest.mark.parametrize("trouble", ["other inputs", "no json yet", "bad sha256", "part lost"])
def test_fetch_takes_the_videos_when_the_ready_source_does_not_fit(tmp_path, github, trouble):
    body = random.Random(33).randbytes(9000)
    ready = random.Random(34).randbytes(7000)
    job, name = ready_job(tmp_path, body)
    files = ready_files(name, ready)
    if trouble == "other inputs":  # исходник с озвучкой, а её убрали («Повторить без озвучки»)
        files = ready_files("source-0123456789ab.mp4", ready)
    elif trouble == "no json yet":  # Action ещё грузит куски
        files.pop(name.removesuffix(".mp4") + ".json")
    elif trouble == "bad sha256":
        files = ready_files(name, ready, sha256="0" * 64)
    else:
        files.pop(f"{name}.part-00001")
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 3), **files})
    assert main(["fetch", str(job.root)]) == 0
    assert job.path("in/source.mov").read_bytes() == body
    assert not job.path("source.mp4").exists(), "битый или чужой исходник не остаётся"


def test_fetch_without_a_draft_names_it(tmp_path, github, capsys):
    assert main(["fetch", str(tmp_path / "jobs" / "abc")]) == 1
    assert "job-abc" in capsys.readouterr().err


# ---------- push --outputs ----------


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture
def repo_job(tmp_path, monkeypatch):
    config = tmp_path / "gitconfig"
    config.write_text("[user]\n\tname = Test\n\temail = t@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(origin))
    work = tmp_path / "work-clone"
    git(tmp_path, "clone", "-q", str(origin), str(work))
    (work / "README.md").write_text("seed\n")
    git(work, "add", "README.md")
    git(work, "commit", "-q", "-m", "seed")
    git(work, "push", "-q", "-u", "origin", "HEAD")
    shutil.copy(Path(__file__).parents[2] / ".gitignore", work / ".gitignore")
    return origin, Job(work / "jobs" / "abc")


def test_push_outputs_splits_large_files(repo_job):
    origin, job = repo_job
    out = job.path("out")
    out.mkdir(parents=True)
    with open(out / "final.mp4", "wb") as f:
        f.truncate(200 * MB)  # нули, на диске почти не занимают места
    (out / "final.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nпривет\n\n", encoding="utf-8")
    assert main(["push", str(job.root), "-m", "outputs", "--outputs"]) == 0
    tree = git(origin, "ls-tree", "-r", "-l", "main").splitlines()
    names = {line.split("\t")[1]: int(line.split()[3]) for line in tree}
    parts_ = {n: s for n, s in names.items() if "/out/final.mp4.part-" in n}
    assert sorted(Path(n).name for n in parts_) == ["final.mp4.part-aa", "final.mp4.part-ab", "final.mp4.part-ac"]
    assert all(size <= 95 * MB for size in parts_.values()) and sum(parts_.values()) == 200 * MB
    assert "jobs/abc/out/final.mp4" not in names
    assert "jobs/abc/out/final.srt" in names
    digest = hashlib.sha256(b"\0" * (200 * MB)).hexdigest()
    assert git(origin, "show", "main:jobs/abc/out/final.mp4.sha256") == f"{digest}  final.mp4"
    assert job.path("work/out/final.mp4").stat().st_size == 200 * MB, "the whole file stays locally, out of git"


def test_push_does_not_commit_inputs(repo_job):
    origin, job = repo_job
    job.path("in/uploads").mkdir(parents=True)
    job.path("in/uploads/upload-i1.png").write_bytes(b"png")
    job.path("words.json").write_text("[]\n", encoding="utf-8")
    assert main(["push", str(job.root), "-m", "work"]) == 0
    names = git(origin, "ls-tree", "-r", "--name-only", "main").splitlines()
    assert "jobs/abc/words.json" in names and not any("/in/" in n for n in names)


# ---------- кадры ----------


def make_source(path, seconds: float, audio: Path | None = None):
    inputs = ["-f", "lavfi", "-i", f"testsrc2=s=1080x1920:r=30:d={seconds}"]
    inputs += ["-i", str(audio)] if audio else ["-f", "lavfi", "-i", f"sine=f=440:r=48000:d={seconds}"]
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *inputs, "-c:v", "libx264", "-preset", "ultrafast",
         "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-shortest", str(path)],
        check=True,
    )
    return path


@needs_ffmpeg
def test_frames_and_preview(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("source.mp4"), 3)
    assert main(["frames", str(job.root), "--at", "0.5", "1.25", "--grid"]) == 0
    assert len(list(job.path("look").glob("grid_*.png"))) == 2
    assert main(["frames", str(job.root), "--at", "2"]) == 0
    assert len(list(job.path("look").glob("frame_*.png"))) == 1
    assert main(["preview", str(job.root), "--at", "1.0"]) == 0
    assert job.path("frame.png").stat().st_size > 0
    assert "frame.png" in capsys.readouterr().out


# ---------- сквозной путь ----------


@pytest.mark.slow
@needs_ffmpeg
def test_cli_prepare_then_render_on_fixture(tmp_path, speech, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), speech.duration, speech.wav)
    assert main(["prepare", str(job.root)]) == 0
    out = capsys.readouterr().out
    for name in ("source.mp4", "words.json", "speech.json", "cuts.json", "sheet.png"):
        assert job.path(name).is_file(), name
    assert job.path("work/source.wav").is_file()
    assert "длительность" in out.lower()
    words = json.loads(job.path("words.json").read_text(encoding="utf-8"))
    cuts = json.loads(job.path("cuts.json").read_text(encoding="utf-8"))
    assert words and cuts["keep"]
    edit = {
        "speed": 1.1,
        "keep": cuts["keep"],
        "words": words,
        "hook": {"text": "Как я монтирую", "until": 2.0},
        "cta": None,
        "inserts": [],
        "zooms": [{"t": 3.0, "level": 1.05}],
        "face": {"x": 0.5, "y": 0.3},
        "music": None,
        "hold": 0.3,
        "style": STYLE,
    }
    job.write("edit.json", edit)
    job.path("out").mkdir(exist_ok=True)  # prepare уже положил туда прокси редактора
    job.path("out/final.mp4.part-aa").write_bytes(b"old render")  # от прошлого push --outputs
    job.path("out/final.mp4.sha256").write_text("0  final.mp4\n", encoding="utf-8")
    assert main(["render", str(job.root), "--preset", "ultrafast"]) == 0
    assert not job.path("out/final.mp4.part-aa").exists() and not job.path("out/final.mp4.sha256").exists()
    assert job.path("out/final.mp4").stat().st_size > 0
    assert job.path("out/final.srt").is_file()
    assert job.path("qa/qa.png").is_file()
    result = job.read("result.json")  # проходит схему
    assert result["durations"]["final"] > 0 and not any("music" in m for m in result["missing"])
    assert set(result["qa"]) == {"ok", "problems"}


# ---------- исправления после ревью ----------


def no_models(monkeypatch, tmp_path):
    """Моделей нет: если команда возьмётся распознавать речь, она упадёт."""
    monkeypatch.setenv("VM_CACHE", str(tmp_path / "no-models"))
    for name in ("ASR_MODEL", "ASR_REF_MODEL", "VAD_MODEL"):
        monkeypatch.delenv(name, raising=False)


SPEECH_WORK = {
    "words.json": '[\n  {"t0": 0.5, "t1": 0.9, "text": "исправлено"}\n]\n',
    "reference.txt": "Исправлено.\n",
    "cuts.json": '{"duration": 2.0, "keep": [[0.38, 0.98]], "cut_seconds": 1.4}\n',
}


@needs_ffmpeg
def test_prepare_in_a_later_session_only_restores_the_source(tmp_path, monkeypatch, capsys):
    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), 2)
    for name, text in SPEECH_WORK.items():
        job.path(name).write_text(text, encoding="utf-8")
    assert main(["prepare", str(job.root)]) == 0
    assert job.path("source.mp4").is_file()
    for name, text in SPEECH_WORK.items():
        assert job.path(name).read_text(encoding="utf-8") == text, f"{name} stays as the earlier session left it"
    assert not job.path("sheet.png").exists() and not job.path("work/source.wav").exists()
    assert "исправлено" in capsys.readouterr().out


@needs_ffmpeg
def test_prepare_makes_the_editor_files_once(tmp_path, monkeypatch, capsys):
    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), 2)
    for name, text in SPEECH_WORK.items():
        job.path(name).write_text(text, encoding="utf-8")
    assert main(["prepare", str(job.root)]) == 0
    assert job.path("out/proxy.mp4").is_file() and job.path("film.jpg").is_file()
    assert job.read("editor.json")["proxy"]["file"] == "out/proxy.mp4"
    assert "Редактор" in capsys.readouterr().out
    job.path("out/proxy.mp4").unlink()  # Action перенёс прокси в релиз, editor.json остался в ветке
    assert main(["prepare", str(job.root)]) == 0
    assert not job.path("out/proxy.mp4").exists(), "второй раз прокси не делается"


@needs_ffmpeg
def test_prepare_goes_on_when_the_editor_files_fail(tmp_path, monkeypatch, capsys):
    """Редактор — бета: его сбой не останавливает шаг — вопросы, стили и монтаж идут как раньше."""
    from vm import editor

    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), 2)
    for name, text in SPEECH_WORK.items():
        job.path(name).write_text(text, encoding="utf-8")

    def broken(j):
        j.path("out").mkdir(exist_ok=True)
        j.path("out/proxy.mp4").write_bytes(b"half")  # половина работы осталась
        raise RuntimeError("ffmpeg упал")

    monkeypatch.setattr(editor, "make", broken)
    assert main(["prepare", str(job.root)]) == 0
    out = capsys.readouterr().out
    assert "Редактор (бета): не вышло" in out and "ffmpeg упал" in out
    assert not job.path("out/proxy.mp4").exists() and not job.path("editor.json").exists()


@needs_ffmpeg
def test_prepare_redo_recognises_again(tmp_path, monkeypatch, capsys):
    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), 2)
    for name, text in SPEECH_WORK.items():
        job.path(name).write_text(text, encoding="utf-8")
    assert main(["prepare", str(job.root), "--redo"]) == 1
    assert "GigaAM" in capsys.readouterr().err


@needs_ffmpeg
def test_prepare_takes_the_fetched_source_not_every_video_in_in(tmp_path, monkeypatch):
    from vm.media import probe

    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), 2)
    make_source(job.path("in/old.mp4"), 3)
    words = [{"t0": 0.2, "t1": 0.5, "text": "раз"}, {"t0": 0.6, "t1": 0.9, "text": "два"}, {"t0": 1.6, "t1": 1.9, "text": "три"}]
    job.path("words.json").write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
    assert main(["prepare", str(job.root)]) == 0
    assert probe(job.path("source.mp4")).duration == pytest.approx(2.0, abs=0.1)
    cuts = job.path("cuts.json").read_text(encoding="utf-8")
    assert len(json.loads(cuts)["keep"]) == 2 and len(cuts.splitlines()) <= 6, cuts


def test_the_videos_of_a_job_go_in_their_order_not_by_name(tmp_path):
    from vm.media import source_parts

    folder = tmp_path / "in"
    folder.mkdir()
    for name in ("source-10.mp4", "source-2.mov", "source.mp4", "old.mp4", "source-3.MTS", "source.mov.part"):
        (folder / name).write_bytes(b"x")
    # расширение — какое было у Павла (.MTS и т. п. тоже): видео задачи не выпадает молча (ревью фазы 4)
    assert [p.name for p in source_parts(folder)] == ["source.mp4", "source-2.mov", "source-3.MTS", "source-10.mp4"]
    for name in ("source-10.mp4", "source-2.mov", "source.mp4", "source-3.MTS"):
        (folder / name).unlink()
    assert [p.name for p in source_parts(folder)] == ["old.mp4"], "не через fetch — все видео папки по имени"


@needs_ffmpeg
def test_prepare_joins_the_videos_and_the_editor_knows_where_each_one_is(tmp_path, monkeypatch, capsys):
    from vm.media import probe

    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mov"), 2)
    make_source(job.path("in/source-2.mp4"), 1)
    videos = [{"file": "in/source.mov", "asset": "source", "name": "IMG_1.MOV", "size": 1, "type": "video/quicktime", "duration": 2},
              {"file": "in/source-2.mp4", "asset": "source-2", "name": "IMG_2.mp4", "size": 1, "type": "video/mp4", "duration": 1}]
    job.path("job.json").write_text(json.dumps({"brief": "", "name": "IMG_1.MOV", "videos": videos}), encoding="utf-8")
    job.path("words.json").write_text('[{"t0": 0.2, "t1": 0.6, "text": "раз"}, {"t0": 2.2, "t1": 2.6, "text": "два"}]', encoding="utf-8")
    assert main(["prepare", str(job.root)]) == 0
    assert probe(job.path("source.mp4")).duration == pytest.approx(3.0, abs=0.1)
    marks = job.read("editor.json")["videos"]
    assert [v["name"] for v in marks] == ["IMG_1.MOV", "IMG_2.mp4"]
    assert marks[0]["t0"] == 0 and marks[0]["t1"] == pytest.approx(2.0, abs=0.04) and marks[1]["t0"] == marks[0]["t1"]
    assert marks[1]["t1"] == pytest.approx(job.read("editor.json")["duration"], abs=1e-3)
    assert "Видео по порядку: IMG_1.MOV 0:00.0–0:02.0, IMG_2.mp4 0:02.0–0:03.0" in capsys.readouterr().out


@needs_ffmpeg
def test_prepare_marks_the_scene_changes_for_transitions(tmp_path, monkeypatch, capsys):
    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    job.path("in").mkdir(parents=True)
    subprocess.run(  # два плана: полоски, на 1,5 с — таблица цветов
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=1.5",
         "-f", "lavfi", "-i", "smptebars=s=1080x1920:r=30:d=1.5", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=3",
         "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-map", "2:a",
         "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(job.path("in/source.mp4"))],
        check=True,
    )
    job.path("words.json").write_text('[{"t0": 0.2, "t1": 0.6, "text": "раз"}, {"t0": 2.0, "t1": 2.5, "text": "два"}]',
                                      encoding="utf-8")
    assert main(["prepare", str(job.root)]) == 0
    cuts = json.loads(job.path("cuts.json").read_text(encoding="utf-8"))
    assert cuts["joins"] == [pytest.approx(1.5, abs=0.04)]
    assert "Смены сцены (cuts.json joins): 0:01.5" in capsys.readouterr().out


def voice_job(tmp_path, seconds: float, voice=True) -> Job:
    """Задача с видео 2 с и озвучкой Павла `seconds` с (в job.json — upload kind audio)."""
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), 2)
    job.path("in/uploads").mkdir(parents=True)
    if voice:
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                        f"sine=frequency=700:sample_rate=48000:duration={seconds}", "-c:a", "aac",
                        str(job.path("in/uploads/upload-voice.m4a"))], check=True)
    upload = {"file": "in/uploads/upload-voice.m4a", "asset": "upload-voice.m4a", "name": "Запись.m4a", "size": 1,
              "type": "audio/mp4", "kind": "audio"}
    job.path("job.json").write_text(json.dumps({"brief": "", "uploads": [upload]}, ensure_ascii=False), encoding="utf-8")
    job.path("words.json").write_text("[]\n", encoding="utf-8")
    return job


@needs_ffmpeg
def test_prepare_puts_pavels_voiceover_instead_of_the_video_sound(tmp_path, monkeypatch, capsys):
    from vm.media import probe

    no_models(monkeypatch, tmp_path)
    job = voice_job(tmp_path, 3.0)
    assert main(["prepare", str(job.root)]) == 0
    assert probe(job.path("source.mp4")).duration == pytest.approx(3.0, abs=0.1)
    assert "Озвучка: Запись.m4a (3,0 с) — вместо звука видео; видео 2,0 с — последний кадр держится до конца записи" in capsys.readouterr().out


@needs_ffmpeg
def test_prepare_stops_when_the_voiceover_was_not_fetched(tmp_path, monkeypatch, capsys):
    no_models(monkeypatch, tmp_path)
    job = voice_job(tmp_path, 3.0, voice=False)
    assert main(["prepare", str(job.root)]) == 1
    assert "озвучки Запись.m4a нет (in/uploads/upload-voice.m4a) — сначала vm fetch" in capsys.readouterr().err


@needs_ffmpeg
def test_prepare_status_keeps_the_state_of_the_step(repo_job, monkeypatch, tmp_path):
    origin, job = repo_job
    no_models(monkeypatch, tmp_path)
    make_source(job.path("in/source.mp4"), 2)
    job.path("words.json").write_text("[]\n", encoding="utf-8")
    assert main(["prepare", str(job.root), "--status", "--state", "rendering"]) == 0
    assert json.loads(git(origin, "show", "main:jobs/abc/status.json"))["state"] == "rendering"


@needs_ffmpeg
def test_a_failed_status_push_does_not_stop_the_command(tmp_path, monkeypatch, capsys):
    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")  # не в репозитории: статус не отправить
    make_source(job.path("in/source.mp4"), 2)
    job.path("words.json").write_text("[]\n", encoding="utf-8")
    assert main(["prepare", str(job.root), "--status"]) == 0
    assert job.path("source.mp4").is_file()
    assert "статус" in capsys.readouterr().err


def test_summary_clock_and_line_length():
    from vm.asr import Word
    from vm.prepare import _clock, _lines

    assert [_clock(t) for t in (0.0, 59.96, 75.4)] == ["0:00.0", "1:00.0", "1:15.4"]
    words = [Word(i * 0.5, i * 0.5 + 0.4, f"w{i}") for i in range(60)]  # 30 с речи без пауз
    assert [len(line.split()) - 1 for line in _lines(words)] == [20, 20, 20]


def test_push_leaves_heavy_pictures_out(repo_job):
    origin, job = repo_job
    for rel in ("sheet.png", "look/frame_0001.000.png", "qa/qa-hook.png", "qa/qa.png", "frame.png"):
        job.path(rel).parent.mkdir(parents=True, exist_ok=True)
        job.path(rel).write_bytes(b"png")
    assert main(["push", str(job.root), "-m", "work"]) == 0
    names = set(git(origin, "ls-tree", "-r", "--name-only", "main").splitlines())
    assert {"jobs/abc/qa/qa.png", "jobs/abc/frame.png"} <= names
    assert not names & {"jobs/abc/sheet.png", "jobs/abc/look/frame_0001.000.png", "jobs/abc/qa/qa-hook.png"}


def test_push_outputs_drops_stale_parts_after_a_smaller_rerender(repo_job):
    origin, job = repo_job
    out = job.path("out")
    out.mkdir(parents=True)
    with open(out / "final.mp4", "wb") as f:
        f.truncate(96 * MB)
    assert main(["push", str(job.root), "-m", "v1", "--outputs"]) == 0
    (out / "final.mp4").write_bytes(b"a smaller render")
    assert main(["push", str(job.root), "-m", "v1 again", "--outputs"]) == 0
    names = git(origin, "ls-tree", "-r", "--name-only", "main").splitlines()
    assert "jobs/abc/out/final.mp4" in names
    assert not [n for n in names if "final.mp4.part-" in n or n.endswith("final.mp4.sha256")], names


def test_push_skips_hidden_temp_files(repo_job):
    origin, job = repo_job
    out = job.path("out")
    out.mkdir(parents=True)
    with open(out / ".final.part.mp4", "wb") as f:  # оставила убитая сборка
        f.truncate(96 * MB)
    (out / "final.srt").write_text("1\n", encoding="utf-8")
    assert main(["push", str(job.root), "-m", "outputs", "--outputs"]) == 0
    names = git(origin, "ls-tree", "-r", "--name-only", "main").splitlines()
    assert "jobs/abc/out/final.srt" in names and not [n for n in names if ".final.part" in n], names


def test_push_of_a_too_big_file_points_at_outputs(repo_job, capsys):
    _, job = repo_job
    job.path("out").mkdir(parents=True)
    with open(job.path("out/final.mp4"), "wb") as f:
        f.truncate(96 * MB)
    assert main(["push", str(job.root), "-m", "outputs"]) == 1
    assert "--outputs" in capsys.readouterr().err


def test_render_version_starts_at_one(tmp_path):
    with pytest.raises(SystemExit):
        main(["render", str(tmp_path / "jobs" / "abc"), "--version", "0"])


def test_render_names_what_is_wrong_in_edit_json(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.path("edit.json").write_text(json.dumps({"speed": 1.1}), encoding="utf-8")
    assert main(["render", str(job.root)]) == 1
    assert "keep" in capsys.readouterr().err
    job.path("edit.json").write_text("{", encoding="utf-8")
    assert main(["render", str(job.root)]) == 1
    assert "edit.json" in capsys.readouterr().err


def test_fetch_reuses_pieces_from_an_interrupted_run(tmp_path, github):
    body = random.Random(6).randbytes(9000)
    files = parts("source", body, 3000)
    github.draft("job-abc", {**files, "manifest.json": manifest("a.mov", body, len(files))})
    job = tmp_path / "jobs" / "abc"
    work = job / "work" / "fetch" / "source"
    work.mkdir(parents=True)
    (work / "00000").write_bytes(body[:3000])  # скачан целиком
    (work / "00001").write_bytes(body[3000:4000])  # оборван
    assert main(["fetch", str(job)]) == 0
    assert (job / "in" / "source.mov").read_bytes() == body
    assert github.downloads == 1 + 2, "manifest.json, the cut piece and the missing one"


def test_fetch_survives_a_connection_cut_mid_piece(tmp_path, github):
    body = random.Random(7).randbytes(6000)
    files = parts("source", body, 3000)
    github.draft("job-abc", {**files, "manifest.json": manifest("a.mov", body, len(files))})
    github.cut_once = {github.ids["source.part-00001"]}
    assert main(["fetch", str(tmp_path / "jobs" / "abc")]) == 0
    assert (tmp_path / "jobs" / "abc" / "in" / "source.mov").read_bytes() == body


def test_fetch_checks_every_group_before_downloading(tmp_path, github, capsys):
    body = random.Random(8).randbytes(6000)
    pic = random.Random(9).randbytes(2500)
    pic_parts = parts("upload-i1.png", pic, 1000)
    pic_parts.pop("upload-i1.png.part-00001")
    uploads = [{"asset": "upload-i1.png", "name": "logo.png", "size": len(pic), "type": "image/png", "parts": 3}]
    github.draft("job-abc", {**parts("source", body, 3000), **pic_parts, "manifest.json": manifest("a.mov", body, 2, uploads=uploads)})
    assert main(["fetch", str(tmp_path / "jobs" / "abc")]) == 1
    assert "upload-i1.png" in capsys.readouterr().err
    assert github.downloads == 1, "only manifest.json: nothing heavy before every group checks out"


def test_fetch_stops_listing_releases_at_its_draft(tmp_path, github):
    body = random.Random(10).randbytes(3000)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": manifest("a.mov", body, 1)})
    for k in range(5):
        github.draft(f"job-other{k}", {})
    assert main(["fetch", str(tmp_path / "jobs" / "abc")]) == 0
    assert github.release_pages == 1


def test_fetch_rejects_a_manifest_that_is_not_an_object(tmp_path, github, capsys):
    body = random.Random(11).randbytes(3000)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": b"[1, 2]"})
    assert main(["fetch", str(tmp_path / "jobs" / "abc")]) == 1
    assert "manifest.json" in capsys.readouterr().err


def test_fetch_rejects_pieces_that_do_not_add_up_to_the_manifest(tmp_path, github, capsys):
    body = random.Random(12).randbytes(6000)
    github.draft("job-abc", {**parts("source", body, 3000), "manifest.json": json.dumps({"name": "a.mov", "size": 5999, "parts": 2}).encode()})
    assert main(["fetch", str(tmp_path / "jobs" / "abc")]) == 1
    err = capsys.readouterr().err
    assert "5999" in err and "6000" in err


def pixels(path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-frames:v", "1", "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(1920, 1080, 3).astype(int)


@pytest.mark.slow
@needs_ffmpeg
def test_check_shows_the_layout_before_the_render(tmp_path, capsys, monkeypatch):
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("source.mp4"), 4)
    job.write("edit.json", {
        "speed": 1.0,
        "keep": [[0.0, 4.0]],
        "words": [{"t0": 0.5, "t1": 0.9, "text": "раз"}, {"t0": 1.0, "t1": 1.4, "text": "два"}, {"t0": 2.5, "t1": 2.9, "text": "три"}],
        "hook": {"text": "Как я монтирую", "until": 1.5},
        "cta": None,
        "inserts": [],
        "zooms": [],
        "face": {"x": 0.5, "y": 0.2},  # хук по умолчанию (y 400) — на лице
        "music": None,
        "hold": 0.0,
        "style": STYLE,
    })
    assert main(["check", str(job.root)]) == 0
    out = capsys.readouterr().out
    assert "хук на лице" in out
    assert job.path("look/check.png").is_file() and not job.path("out").exists()
    hook = pixels(job.path("look/check-hook.png"))
    plain = job.path("look/plain.png")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", "0.25", "-i", str(job.path("source.mp4")),
                    "-frames:v", "1", str(plain)], check=True)
    source = pixels(plain)
    assert abs(hook[330:470, 200:750] - source[330:470, 200:750]).mean() > 20, "the hook is drawn over the frame"
    assert abs(hook[1000:1100, 100:300] - source[1000:1100, 100:300]).mean() < 6, "the rest is the source frame"
    boxes = job.path("work/render/frames/boxes.json")
    drawn = boxes.stat().st_mtime_ns
    monkeypatch.setattr("vm.render.loudness", lambda path: -36.4)  # тихая запись
    assert main(["render", str(job.root), "--preset", "ultrafast"]) == 0
    assert boxes.stat().st_mtime_ns == drawn, "render reuses the layer the check drew"
    assert job.path("out/final.mp4").is_file()
    out = capsys.readouterr().out
    assert "тихая запись (−36.4 LUFS) — убрал шум" in out, out


# ---------- для SKILL.md ----------


def variants() -> list[dict]:
    return [{"id": v, "label": f"Вариант {v}", "spec": STYLE} for v in "ABC"]


def test_validate_names_bad_fields_and_missing_pictures(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    question = {"id": "logo", "type": "insert", "title": "Что поставить?", "image": "q-logo.png",
                "options": [{"id": "a", "label": "Логотип", "image": "../../assets/logos/nope.png"}, {"id": "none", "label": "Не надо"}]}
    job.path("questions.json").write_text(json.dumps({"questions": [question]}), encoding="utf-8")
    styles = {"frame": "frame.png", "frameTime": 1.0, "sample": {"words": ["раз"], "spoken": 0}, "variants": variants()[:2]}
    job.path("styles.json").write_text(json.dumps(styles), encoding="utf-8")
    assert main(["validate", str(job.root)]) == 1
    err = capsys.readouterr().err
    assert "variants" in err and "q-logo.png" in err and "nope.png" in err
    question["options"][0]["image"] = "q-logo.png"
    job.path("questions.json").write_text(json.dumps({"questions": [question]}), encoding="utf-8")
    job.path("styles.json").write_text(json.dumps({**styles, "variants": variants()}), encoding="utf-8")
    job.path("q-logo.png").write_bytes(b"png")
    assert main(["validate", str(job.root)]) == 1  # ссылки файла проверяются, когда он прошёл схему
    assert "frame.png" in capsys.readouterr().err
    job.path("frame.png").write_bytes(b"png")
    assert main(["validate", str(job.root)]) == 0
    assert "questions.json" in capsys.readouterr().out


def test_validate_checks_the_review_and_the_script_too(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    for name, bad in (("review.json", {"items": [{"id": "hook", "title": "Мысль", "status": "maybe", "note": "…"}]}),
                      ("script.json", {"story": "vlog", "hooks": [], "scenes": [], "cta": "", "tips": [], "caption": {}})):
        job.path(name).write_text(json.dumps(bad), encoding="utf-8")
        assert main(["validate", str(job.root)]) == 1, name
        assert name in capsys.readouterr().err
        job.path(name).unlink()


def test_validate_finds_insert_files_of_edit_json(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    edit = {"speed": 1.1, "keep": [[0.0, 3.0]], "words": [], "hook": None, "cta": None, "zooms": [], "face": {"x": 0.5, "y": 0.3},
            "music": {"file": "assets/music/nope.mp3", "gainDb": -18}, "hold": 0.0, "style": STYLE,
            "inserts": [{"kind": "image", "src": "in/uploads/nope.png", "t0": 1.0, "t1": 2.5, "x": 100, "y": 600, "w": 300}]}
    job.write("edit.json", edit)
    job.path("in").mkdir()
    job.path("in/source.mov").write_bytes(b"mov")  # после vm fetch
    assert main(["validate", str(job.root)]) == 1
    err = capsys.readouterr().err
    assert "in/uploads/nope.png" in err and "assets/music/nope.mp3" in err


def test_validate_leaves_uploads_alone_until_fetch(tmp_path, capsys):
    # шаг restyle идёт без vm fetch: in/ нет, и вставка Павла из ТЗ — не потерянный файл
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    edit = {"speed": 1.1, "keep": [[0.0, 3.0]], "words": [], "hook": None, "cta": None, "zooms": [], "face": {"x": 0.5, "y": 0.3},
            "music": None, "hold": 0.0, "style": STYLE,
            "inserts": [{"kind": "image", "src": "in/uploads/upload-i1.png", "t0": 1.0, "t1": 2.5, "x": 100, "y": 600, "w": 300}]}
    job.write("edit.json", edit)
    assert main(["validate", str(job.root)]) == 0
    assert "in/" in capsys.readouterr().out  # сказано, что их не проверял
    job.path("in/brand").mkdir(parents=True)  # копия логотипа бренда лежит в ветке задачи — это ещё не vm fetch
    job.path("in/brand/logo.png").write_bytes(b"png")
    assert main(["validate", str(job.root)]) == 0
    assert "in/uploads/upload-i1.png" in capsys.readouterr().out
    job.path("in/source.mov").write_bytes(b"mov")  # после vm fetch — проверяются
    assert main(["validate", str(job.root)]) == 1
    assert "in/uploads/upload-i1.png" in capsys.readouterr().err
    job.path("in/source.mov").unlink()  # vm fetch взял готовый исходник: видео Павла в in/ нет, а source.mp4 есть
    job.path("source.mp4").write_bytes(b"mp4")
    assert main(["validate", str(job.root)]) == 1
    assert "in/uploads/upload-i1.png" in capsys.readouterr().err


@needs_ffmpeg
def test_preview_makes_a_marked_picture_for_a_question(tmp_path):
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("source.mp4"), 3)
    assert main(["preview", str(job.root), "--at", "1.0", "--out", "q-logo.jpg", "--mark", "100,600,300,200"]) == 0
    img = pixels(job.path("q-logo.jpg"))
    assert all(abs(img[603, 250] - (0xFF, 0xD2, 0x3F)) <= 40), img[603, 250]  # верхняя сторона рамки
    assert all(abs(img[700, 103] - (0xFF, 0xD2, 0x3F)) <= 40), img[700, 103]  # левая
    assert not job.path("frame.png").exists()
    with pytest.raises(SystemExit):
        main(["preview", str(job.root), "--at", "1.0", "--out", "../escape.png"])


@needs_ffmpeg
def test_preview_shows_the_background_dimmed_for_the_question(tmp_path, monkeypatch):
    """Картинка к вопросу «Фон»: тот же кадр, фон темнее на долю `--dim` по маске человека."""
    def left_person(rgb, state):
        mask = np.zeros(rgb.shape[:2], np.uint8)
        mask[:, : rgb.shape[1] // 2] = 255
        return mask, state

    monkeypatch.setattr("vm.matte.unavailable", lambda: None)
    monkeypatch.setattr("vm.matte._rvm", lambda threads=None: left_person)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("source.mp4"), 3)
    assert main(["preview", str(job.root), "--at", "1.0", "--out", "q-dim-none.png"]) == 0
    assert main(["preview", str(job.root), "--at", "1.0", "--out", "q-dim-30.png", "--dim", "0.3"]) == 0
    plain, dimmed = pixels(job.path("q-dim-none.png")).astype(float), pixels(job.path("q-dim-30.png")).astype(float)
    assert abs(plain[:, :400].mean() - dimmed[:, :400].mean()) < 3, "человек как был"
    assert 0.6 < dimmed[:, 700:].mean() / plain[:, 700:].mean() < 0.8, "фон темнее на 30 %"


def test_preview_without_the_matting_model_says_what_is_missing(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("vm.matte.unavailable", lambda: "нет модели rvm_mobilenetv3_fp32.onnx (setup/cloud-setup.sh)")
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    assert main(["preview", str(job.root), "--at", "1.0", "--out", "q-dim-30.png", "--dim", "0.3"]) == 1
    assert "нет модели" in capsys.readouterr().err


@needs_ffmpeg
def test_preview_with_a_failing_matte_is_a_clear_error(tmp_path, monkeypatch, capsys):
    class Boom(Exception):
        pass

    def fail(*args, **kwargs):
        raise Boom("модель сломалась")

    monkeypatch.setattr("vm.matte.unavailable", lambda: None)
    monkeypatch.setattr("vm.matte.frame_matte", fail)
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("source.mp4"), 2)
    assert main(["preview", str(job.root), "--at", "1.0", "--out", "q-dim-30.png", "--dim", "0.3"]) == 1
    assert "затемнение фона: модель сломалась" in capsys.readouterr().err


def test_summary_warns_when_gigaam_heard_much_less_than_whisper():
    from vm.asr import Word
    from vm.prepare import _coverage

    reference = "Сегодня покажу, как я монтирую ролики за десять минут. Я снимаю всё на айфон без штатива."
    few = [Word(0.5, 0.9, "сегодня"), Word(1.0, 1.4, "покажу")]
    assert "2" in _coverage(few, reference) and "16" in _coverage(few, reference)
    most = [Word(i, i + 0.5, "слово") for i in range(14)]
    assert _coverage(most, reference) is None
    assert _coverage(few, "") is None  # Whisper нет — сравнивать не с чем


def test_summary_names_speech_without_words():
    from vm.asr import Word
    from vm.prepare import _uncovered

    words = [Word(0.5, 0.9, "раз"), Word(1.0, 1.4, "два"), Word(6.0, 6.3, "аа")]
    spans = [(0.4, 1.5), (3.0, 5.0), (5.8, 8.8), (9.0, 9.3)]  # речь по VAD
    assert _uncovered(words, spans) == [(3.0, 5.0), (5.8, 8.8)]  # короче 0,5 с — не в счёт



# ---------- язык ролика ----------


@pytest.fixture
def heard(monkeypatch, tmp_path):
    """Подставное распознавание на 2-секундном исходнике. `votes` — какие языки «услышит» Whisper в окнах (если язык
    ему не задан); `calls` — с каким языком звали reference и transcribe; `have` — какие модели «стоят»."""
    from vm import asr, lang
    from vm import prepare as prepare_mod
    from vm.asr import Word

    calls = {"reference": [], "transcribe": []}
    votes = ["cs"]
    have = {"GigaAM": True, "Parakeet": True, "Whisper": True, "VAD": True}

    def reference(wav, language="ru"):
        calls["reference"].append(language)
        return "Ahoj.", list(votes) if not language else [language]

    def transcribe(wav, language="ru"):
        lang.engine(language)  # как настоящий: второй этап — отказ
        calls["transcribe"].append(language)
        return [Word(0.5, 0.9, "ahoj")]

    monkeypatch.setattr(asr, "reference", reference)
    monkeypatch.setattr(asr, "transcribe", transcribe)
    monkeypatch.setattr(asr, "speech_spans", lambda wav: [(0.4, 1.0)])
    monkeypatch.setattr(prepare_mod, "models", lambda: dict(have))
    job = Job(tmp_path / "jobs" / "abc")
    make_source(job.path("in/source.mp4"), 2)
    return job, calls, votes, have


def brief(job, text):
    job.path("job.json").write_text(json.dumps({"brief": text, "uploads": [], "runs": []}, ensure_ascii=False), encoding="utf-8")


@needs_ffmpeg
def test_prepare_tells_the_language_by_speech_and_writes_it_down(heard, capsys):
    job, calls, votes, _ = heard
    votes[:] = ["cs", "cs"]
    assert main(["prepare", str(job.root)]) == 0
    assert job.read("language.json") == {"code": "cs", "name": "чешский", "source": "detected", "sure": True, "votes": ["cs", "cs"]}
    assert calls == {"reference": [""], "transcribe": ["cs"]}
    out = capsys.readouterr().out
    assert "Язык: чешский (cs, по речи)" in out and "ВНИМАНИЕ: язык" not in out


@needs_ffmpeg
def test_prepare_listens_to_the_speech_while_it_makes_the_editor_files(heard, monkeypatch, capsys):
    """Распознавание (Whisper и GigaAM — 2 ядра из 4) идёт своим потоком, а тем временем — смены сцены, контактный лист
    и файлы редактора: им нужен только исходник. Анализ ролика в 4,5 минуты — на 2–3 минуты короче. Сводка — как была:
    язык, потом редактор."""
    from vm import asr, editor

    job, calls, _, _ = heard
    made, seen = threading.Event(), []
    make, reference = editor.make, asr.reference

    def making(j):
        made.set()
        return make(j)

    def hearing(wav, language="ru"):
        seen.append(made.wait(5))
        return reference(wav, language)

    monkeypatch.setattr(editor, "make", making)
    monkeypatch.setattr(asr, "reference", hearing)
    assert main(["prepare", str(job.root)]) == 0
    assert seen == [True], "файлы редактора делались, пока шло распознавание"
    assert calls == {"reference": [""], "transcribe": ["cs"]}
    assert job.read("language.json")["code"] == "cs" and job.path("words.json").is_file() and job.path("sheet.png").is_file()
    assert job.read("cuts.json")["keep"] and job.path("editor.json").is_file()
    out = capsys.readouterr().out
    assert out.index("Язык: чешский") < out.index("Редактор (бета)")


@needs_ffmpeg
def test_prepare_listens_to_the_speech_while_it_normalizes_the_video(heard, monkeypatch):
    """Звук для распознавания — прямо из видео Павла (`media.source_wav`, секунды), и распознавание идёт, пока
    нормализуется картинка (на 4K с iPhone — 2–7 минут): анализ на столько же короче."""
    from vm import asr
    from vm import prepare as prepare_mod

    job, calls, _, _ = heard
    started, seen = threading.Event(), []
    make, reference = prepare_mod.make_source, asr.reference

    def normalizing(j):
        seen.append(started.wait(5))
        return make(j)

    def hearing(wav, language="ru"):
        started.set()
        return reference(wav, language)

    monkeypatch.setattr(prepare_mod, "make_source", normalizing)
    monkeypatch.setattr(asr, "reference", hearing)
    assert main(["prepare", str(job.root)]) == 0
    assert seen == [True], "распознавание началось до нормализации видео"
    assert calls == {"reference": [""], "transcribe": ["cs"]} and job.path("words.json").is_file()
    assert job.path("source.mp4").is_file() and job.path("work/source.wav").is_file()


@needs_ffmpeg
def test_prepare_takes_the_language_from_the_brief(heard):
    job, calls, _, _ = heard
    brief(job, "ХУК: привет\nЯЗЫК: английский")
    assert main(["prepare", str(job.root)]) == 0
    assert calls == {"reference": ["en"], "transcribe": ["en"]}
    assert job.read("language.json")["source"] == "brief"


@needs_ffmpeg
def test_prepare_says_when_it_is_not_sure_of_the_language(heard, capsys):
    job, _, votes, _ = heard
    votes[:] = ["uk", "ru", "uk"]
    assert main(["prepare", str(job.root)]) == 0
    assert job.read("language.json")["sure"] is False
    out = capsys.readouterr().out
    assert "ВНИМАНИЕ: язык" in out and "uk, ru, uk" in out and "--lang" in out


@needs_ffmpeg
def test_prepare_reports_a_language_line_it_did_not_understand(heard, capsys):
    job, calls, _, _ = heard
    brief(job, "ЯЗЫК: эльфийский")
    assert main(["prepare", str(job.root)]) == 0
    assert calls["reference"] == [""]  # не понял — определил по речи
    assert "эльфийский" in capsys.readouterr().out


@needs_ffmpeg
def test_prepare_with_an_answer_hears_the_speech_again_in_that_language(heard, capsys):
    job, calls, votes, _ = heard
    votes[:] = ["ru"]
    assert main(["prepare", str(job.root)]) == 0
    assert main(["prepare", str(job.root), "--lang", "украинский"]) == 0
    assert calls["transcribe"] == ["ru", "uk"] and calls["reference"] == ["", "uk"]
    assert job.read("language.json")["source"] == "answer"
    assert main(["prepare", str(job.root), "--lang", "uk"]) == 0  # тот же язык — заново не распознаёт
    assert calls["transcribe"] == ["ru", "uk"]


@needs_ffmpeg
def test_prepare_refuses_an_answer_that_is_not_a_language(heard, capsys):
    job, calls, _, _ = heard
    assert main(["prepare", str(job.root), "--lang", "эльфийский"]) == 1
    assert "эльфийский" in capsys.readouterr().err and calls["transcribe"] == []


@needs_ffmpeg
def test_prepare_refuses_a_second_stage_language_with_a_clear_message(heard, capsys):
    job, calls, votes, _ = heard
    votes[:] = ["ja"]
    assert main(["prepare", str(job.root)]) == 1
    err = capsys.readouterr().err
    assert "японский" in err and "пока не поддерживается" in err and "ЯЗЫК:" in err
    assert calls["transcribe"] == [] and not job.path("words.json").exists()


@needs_ffmpeg
def test_prepare_refuses_a_second_stage_language_from_the_brief_before_any_work(heard, capsys):
    job, calls, _, _ = heard
    brief(job, "ЯЗЫК: японский")
    assert main(["prepare", str(job.root)]) == 1
    assert "японский" in capsys.readouterr().err
    assert not job.path("source.mp4").exists() and calls["reference"] == []


@needs_ffmpeg
def test_prepare_names_the_missing_model_for_the_language(heard, capsys):
    job, _, _, have = heard
    have["Parakeet"] = False
    assert main(["prepare", str(job.root)]) == 1
    err = capsys.readouterr().err
    assert "Parakeet" in err and "чешский" in err and "cloud-setup" in err


@needs_ffmpeg
def test_prepare_warns_that_word_times_are_rough_without_a_timing_model(heard, capsys):
    job, calls, votes, _ = heard
    votes[:] = ["sr"]
    assert main(["prepare", str(job.root)]) == 0
    assert calls["transcribe"] == ["sr"]
    assert "сербский" in (out := capsys.readouterr().out) and "время слов" in out


@needs_ffmpeg
def test_prepare_without_whisper_is_russian_and_says_so(heard, capsys):
    job, calls, _, have = heard
    have["Whisper"] = False
    assert main(["prepare", str(job.root)]) == 0
    assert calls == {"reference": [], "transcribe": ["ru"]}
    info = job.read("language.json")
    assert (info["code"], info["source"], info["sure"]) == ("ru", "default", False)
    assert "ВНИМАНИЕ: язык" in capsys.readouterr().out


@needs_ffmpeg
def test_prepare_in_a_later_session_shows_the_language(heard, capsys):
    job, calls, _, _ = heard
    assert main(["prepare", str(job.root)]) == 0
    capsys.readouterr()
    assert main(["prepare", str(job.root)]) == 0
    assert calls["transcribe"] == ["cs"] and "Язык: чешский" in capsys.readouterr().out


@needs_ffmpeg
def test_prepare_asks_to_check_languages_whisper_confuses(heard, capsys):
    job, _, votes, _ = heard
    votes[:] = ["ru", "ru"]
    assert main(["prepare", str(job.root)]) == 0
    out = capsys.readouterr().out
    assert "проверь" in out and "украинский" in out and "белорусский" in out


@needs_ffmpeg
def test_prepare_does_not_count_a_told_language_as_votes(heard):
    job, _, _, _ = heard
    brief(job, "ЯЗЫК: чешский")
    assert main(["prepare", str(job.root)]) == 0
    assert job.read("language.json")["votes"] == []


@needs_ffmpeg
def test_prepare_records_an_answer_that_confirms_the_language(heard):
    job, calls, votes, _ = heard
    votes[:] = ["uk", "ru", "uk"]
    assert main(["prepare", str(job.root)]) == 0
    assert main(["prepare", str(job.root), "--lang", "uk"]) == 0
    info = job.read("language.json")
    assert (info["code"], info["source"], info["sure"]) == ("uk", "answer", True)
    assert calls["transcribe"] == ["uk"]  # заново не распознавал


@needs_ffmpeg
def test_prepare_redo_keeps_the_language_pavel_gave(heard):
    job, calls, votes, _ = heard
    votes[:] = ["ru"]
    assert main(["prepare", str(job.root), "--lang", "uk"]) == 0
    assert main(["prepare", str(job.root), "--redo"]) == 0
    assert calls["reference"] == ["uk", "uk"] and job.read("language.json")["source"] == "answer"


@needs_ffmpeg
def test_prepare_takes_a_job_from_before_languages_as_russian(heard):
    job, calls, _, _ = heard
    job.path("words.json").write_text('[\n  {"t0": 0.5, "t1": 0.9, "text": "раз"}\n]\n', encoding="utf-8")
    assert main(["prepare", str(job.root), "--lang", "ru"]) == 0
    assert calls["transcribe"] == []  # старая задача и так русская — распознавать заново незачем


# ---------- подпись к посту ----------

CHECKS = [{"id": "format", "title": "9:16, 1080×1920, 30 к/с", "ok": True}, {"id": "end", "title": "финальная карточка с призывом", "ok": False}]


def test_render_keeps_the_caption_claude_wrote(tmp_path, monkeypatch):
    """vm render пишет result.json заново (длительности, missing, qa), а done, unsure и подпись к посту — от Claude."""
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {"speed": 1.0, "keep": [[0.0, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
                            "face": {"x": 0.5, "y": 0.3}, "music": None, "hold": 0.0, "style": STYLE})
    caption = {"text": "Три ошибки новичка в монтаже 🔥\nСохрани, чтобы не потерять", "hashtags": ["монтаж", "reels"]}
    job.write("result.json", {"durations": {"source": 4, "final": 4}, "done": ["вырезал паузы"], "unsure": [], "missing": [],
                              "qa": {"ok": True, "problems": []}, "caption": caption})
    job.path("work/render/frames").mkdir(parents=True)
    job.path("work/render/frames/boxes.json").write_text("[]", encoding="utf-8")
    job.path("out").mkdir()
    job.path("out/final.mp4").write_bytes(b"video")
    monkeypatch.setattr(cli, "render", lambda *a, **k: {"durations": {"source": 4.0, "final": 4.0}, "missing": [], "warnings": [], "voice": {}})
    monkeypatch.setattr(cli, "_fonts_ok", lambda job: None)
    monkeypatch.setattr(cli, "check_render", lambda *a, **k: [])
    monkeypatch.setattr(cli, "control_frames", lambda *a, **k: {"sheet": job.path("qa/qa.png")})
    monkeypatch.setattr(cli, "checklist", lambda final, boxes, report: CHECKS)
    assert main(["render", str(job.root)]) == 0
    result = job.read("result.json")
    assert result["caption"] == caption and result["done"] == ["вырезал паузы"]
    assert result["checklist"] == CHECKS, "чек-лист по гайду — от vm render"


# ---------- A/B ----------


def test_version_b_is_the_same_edit_without_the_teaser_or_the_music():
    from vm.render import RenderError, variant_b

    edit = {"keep": [[0, 4]], "teaser": {"t0": 2.0, "t1": 3.0}, "music": {"file": "assets/music/a.mp3", "gainDb": -18}, "ab": "teaser"}
    assert variant_b(edit) == {**edit, "teaser": None, "ab": None}
    assert variant_b({**edit, "ab": "music"}) == {**edit, "music": None, "ab": None}
    with pytest.raises(RenderError, match="тизера нет"):
        variant_b({**edit, "teaser": None})
    with pytest.raises(RenderError, match="ab"):
        variant_b({**edit, "ab": "colors"})


def test_render_builds_version_b_too_and_checks_it(tmp_path, monkeypatch):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {"speed": 1.0, "keep": [[0.0, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
                            "face": {"x": 0.5, "y": 0.3}, "music": {"file": "assets/music/a.mp3", "gainDb": -18}, "hold": 0.0,
                            "style": STYLE, "ab": "music"})
    calls = []

    def fake_render(job_, out_dir, name="final", preset="medium", edit=None, work="work/render"):
        calls.append((name, edit and edit.get("music"), work))
        (job_.path(work) / "frames").mkdir(parents=True, exist_ok=True)
        (job_.path(work) / "frames" / "boxes.json").write_text("[]", encoding="utf-8")
        job_.path("out").mkdir(exist_ok=True)
        job_.path(f"out/{name}.mp4").write_bytes(b"video")
        return {"durations": {"source": 4.0, "final": 4.0}, "missing": [], "warnings": [], "voice": {}}

    monkeypatch.setattr(cli, "render", fake_render)
    monkeypatch.setattr(cli, "_fonts_ok", lambda job: None)
    monkeypatch.setattr(cli, "check_render", lambda final, edit, boxes, report: [] if edit.get("music") else ["тихо"])
    monkeypatch.setattr(cli, "control_frames", lambda *a, **k: {"sheet": job.path("qa/qa.png")})
    monkeypatch.setattr(cli, "checklist", lambda final, boxes, report: CHECKS)
    assert main(["render", str(job.root), "--version", "2"]) == 0
    assert calls == [("final-v2", None, "work/render"), ("final-v2-b", None, "work/render-b")]
    result = job.read("result.json")
    assert result["ab"] == {"differs": "music", "durations": {"source": 4.0, "final": 4.0}, "qa": {"ok": False, "problems": ["тихо"]}}


def test_version_b_without_its_part_fails_before_the_first_render(tmp_path, monkeypatch, capsys):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {"speed": 1.0, "keep": [[0.0, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
                            "face": {"x": 0.5, "y": 0.3}, "music": None, "hold": 0.0, "style": STYLE, "teaser": None, "ab": "teaser"})
    calls = []
    monkeypatch.setattr(cli, "render", lambda *a, **k: calls.append(a))
    monkeypatch.setattr(cli, "_fonts_ok", lambda job: None)
    assert main(["render", str(job.root)]) == 1
    assert calls == [], "ошибка в ab — сразу, а не после сборки первой версии"
    assert "тизера нет" in capsys.readouterr().err


@pytest.mark.parametrize("beats, line", [
    ({"bpm": 121.4, "moved": 3}, "в такт музыке (121 уд/мин): к долям подвинуто событий — 3"),
    ({"bpm": 0.0, "moved": 0}, "в такт музыке: ровного ритма в треке нет — зумы и вставки на своих местах"),
    (None, None),
])
def test_render_says_how_the_events_follow_the_beats(tmp_path, monkeypatch, capsys, beats, line):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {"speed": 1.0, "keep": [[0.0, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
                            "face": {"x": 0.5, "y": 0.3}, "music": {"file": "assets/music/a.mp3", "gainDb": -18}, "hold": 0.0,
                            "style": STYLE})

    def fake_render(job_, out_dir, name="final", preset="medium", edit=None, work="work/render"):
        (job_.path(work) / "frames").mkdir(parents=True, exist_ok=True)
        (job_.path(work) / "frames" / "boxes.json").write_text("[]", encoding="utf-8")
        job_.path("out").mkdir(exist_ok=True)
        job_.path(f"out/{name}.mp4").write_bytes(b"video")
        return {"durations": {"source": 4.0, "final": 4.0}, "missing": [], "warnings": [], "voice": {}, "beats": beats}

    monkeypatch.setattr(cli, "render", fake_render)
    monkeypatch.setattr(cli, "_fonts_ok", lambda job: None)
    monkeypatch.setattr(cli, "check_render", lambda *a: [])
    monkeypatch.setattr(cli, "control_frames", lambda *a, **k: {"sheet": job.path("qa/qa.png")})
    monkeypatch.setattr(cli, "checklist", lambda final, boxes, report: CHECKS)
    assert main(["render", str(job.root)]) == 0
    out = capsys.readouterr().out
    assert (line in out) if line else ("в такт" not in out), out


# ---------- второй заход: отложенное из ревью ----------


def test_a_teaser_must_be_a_real_phrase_inside_the_source():
    from vm.render import RenderError, timeline

    edit = {"keep": [[0.0, 10.0]], "speed": 1.0, "teaser": {"t0": 4.0, "t1": 6.0}}
    assert timeline(edit, 10.0).teaser_duration == pytest.approx(2.0)
    for teaser, why in (({"t0": 6.0, "t1": 4.0}, "teaser"), ({"t0": 4.0, "t1": 4.5}, "1–5 с"), ({"t0": 1.0, "t1": 7.5}, "1–5 с"),
                        ({"t0": 11.0, "t1": 13.0}, "за концом")):
        with pytest.raises(RenderError, match=why):
            timeline({**edit, "teaser": teaser}, 10.0)


def test_version_b_without_music_keeps_the_events_of_version_a_on_its_beats(tmp_path, monkeypatch):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {"speed": 1.0, "keep": [[0.0, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [],
                            "zooms": [{"t": 1.1, "level": 1.05}], "face": {"x": 0.5, "y": 0.3},
                            "music": {"file": "assets/music/a.mp3", "gainDb": -18}, "hold": 0.0, "style": STYLE, "ab": "music"})
    seen = []

    def fake_render(job_, out_dir, name="final", preset="medium", edit=None, work="work/render"):
        seen.append(edit)
        (job_.path(work) / "frames").mkdir(parents=True, exist_ok=True)
        (job_.path(work) / "frames" / "boxes.json").write_text("[]", encoding="utf-8")
        job_.path("out").mkdir(exist_ok=True)
        job_.path(f"out/{name}.mp4").write_bytes(b"video")
        used = {**(edit or job_.read("edit.json"))}
        if used.get("music"):  # A: смена зума встала на долю 1,0 с
            used["zooms"] = [{"t": 1.0, "level": 1.05}]
        return {"durations": {"source": 4.0, "final": 4.0}, "missing": [], "warnings": [], "voice": {}, "edit": used}

    monkeypatch.setattr(cli, "render", fake_render)
    monkeypatch.setattr(cli, "_fonts_ok", lambda job: None)
    monkeypatch.setattr(cli, "check_render", lambda *a: [])
    monkeypatch.setattr(cli, "control_frames", lambda *a, **k: {"sheet": job.path("qa/qa.png")})
    monkeypatch.setattr(cli, "checklist", lambda *a: [])
    assert main(["render", str(job.root)]) == 0
    assert seen[1]["music"] is None and seen[1]["zooms"] == [{"t": 1.0, "level": 1.05}], "B — те же доли, что у A"


def _fake_outputs(monkeypatch, cli, job, fail_on=None):
    """render, проверки и чек-лист без ffmpeg: ролик — байты, слой — пустой; `fail_on` — имя, на котором render падает."""
    calls = []

    def fake_render(job_, out_dir, name="final", preset="medium", edit=None, work="work/render"):
        calls.append(name)
        if name == fail_on:
            from vm.render import RenderError

            raise RenderError(f"{name}: сломался")
        (job_.path(work) / "frames").mkdir(parents=True, exist_ok=True)
        (job_.path(work) / "frames" / "boxes.json").write_text("[]", encoding="utf-8")
        job_.path("out").mkdir(exist_ok=True)
        job_.path(f"out/{name}.mp4").write_bytes(b"video")
        return {"durations": {"source": 4.0, "final": 3.5}, "missing": [], "warnings": [], "voice": {}}

    monkeypatch.setattr(cli, "render", fake_render)
    monkeypatch.setattr(cli, "_fonts_ok", lambda job: None)
    monkeypatch.setattr(cli, "check_render", lambda *a: [])
    monkeypatch.setattr(cli, "control_frames", lambda *a, **k: {"sheet": job.path("qa/qa.png")})
    monkeypatch.setattr(cli, "checklist", lambda *a: [])
    return calls


EDIT_4S = {"speed": 1.0, "keep": [[0.0, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
           "face": {"x": 0.5, "y": 0.3}, "music": None, "hold": 0.0, "style": STYLE}
RESULT_OLD = {"durations": {"source": 4.0, "final": 4.0}, "done": ["вырезал паузы"], "unsure": [], "missing": [], "qa": {"ok": True, "problems": []}}


def test_render_refuses_a_broken_result_json_before_encoding(tmp_path, monkeypatch, capsys):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", EDIT_4S)
    job.path("result.json").write_text(json.dumps({**RESULT_OLD, "caption": {"text": "Подпись", "hashtags": ["#reels"]}}), encoding="utf-8")
    calls = _fake_outputs(monkeypatch, cli, job)
    assert main(["render", str(job.root)]) == 1
    assert calls == [], "кривая подпись — ошибка до кодирования"
    assert "result.json" in capsys.readouterr().err


def test_render_writes_version_a_result_before_version_b(tmp_path, monkeypatch):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {**EDIT_4S, "teaser": {"t0": 1.0, "t1": 3.0}, "ab": "teaser"})
    job.write("result.json", RESULT_OLD)
    _fake_outputs(monkeypatch, cli, job, fail_on="final-b")
    assert main(["render", str(job.root)]) == 1
    result = job.read("result.json")
    assert result["durations"]["final"] == 3.5 and result["done"] == ["вырезал паузы"], "итоги A — от нового ролика"


def test_render_without_ab_drops_an_old_version_b(tmp_path, monkeypatch):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", EDIT_4S)
    job.path("out").mkdir(parents=True)
    for old in ("final-b.mp4", "final-b.srt", "final-b.mp4.part-aa"):
        job.path(f"out/{old}").write_bytes(b"old")
    _fake_outputs(monkeypatch, cli, job)
    assert main(["render", str(job.root)]) == 0
    assert sorted(p.name for p in job.path("out").iterdir()) == ["final.mp4"]


def test_render_makes_the_cover_next_to_the_video_and_drops_an_old_one(tmp_path, monkeypatch):
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {**EDIT_4S, "cover": {"t": 1.0, "text": "Как я учу"}})
    _fake_outputs(monkeypatch, cli, job)
    made = []

    def fake_cover(job_, edit, out):
        made.append(out.name)
        out.write_bytes(b"png")
        return {"box": {"x": 100, "y": 100, "w": 900, "h": 300}}  # верх — выше того, что видно в сетке профиля

    monkeypatch.setattr(cli, "render_cover", fake_cover)
    assert main(["render", str(job.root), "--version", "2"]) == 0
    assert made == ["final-v2-cover.png"]
    assert any("обложк" in p for p in job.read("result.json")["qa"]["problems"])
    job.write("edit.json", EDIT_4S)
    assert main(["render", str(job.root), "--version", "2"]) == 0
    assert not job.path("out/final-v2-cover.png").exists(), "обложки в этот раз нет — старая не от этого ролика"


def test_validate_finds_a_missing_cover_frame(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    job.path("frame.png").write_bytes(b"png")
    styles = {"frame": "frame.png", "frameTime": 1.0, "sample": {"words": ["раз"], "spoken": 0}, "variants": variants(),
              "cover": {"frames": [{"t": 1.0, "image": "cover-1.jpg"}], "text": "Как я учу"}}
    job.path("styles.json").write_text(json.dumps(styles), encoding="utf-8")
    assert main(["validate", str(job.root)]) == 1
    assert "cover-1.jpg" in capsys.readouterr().err
    job.path("cover-1.jpg").write_bytes(b"jpg")
    assert main(["validate", str(job.root)]) == 0


def test_render_makes_the_ads_version_in_the_ads_zone_and_drops_an_old_one(tmp_path, monkeypatch):
    import vm.__main__ as cli
    from vm.qa import ADS_SAFE, SAFE

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {**EDIT_4S, "ad": True})
    _fake_outputs(monkeypatch, cli, job)
    seen, zones = [], []
    plain = cli.render

    def render(job_, out_dir, name="final", preset="medium", edit=None, work="work/render"):
        seen.append((name, (edit or {}).get("zone"), work))
        return plain(job_, out_dir, name=name, preset=preset, edit=edit, work=work)

    monkeypatch.setattr(cli, "render", render)
    monkeypatch.setattr(cli, "check_layout", lambda boxes, face, inserts=None, safe=SAFE, zoom=None: zones.append(safe) or [])
    assert main(["render", str(job.root)]) == 0
    assert seen == [("final", None, "work/render"), ("final-ad", "ads", "work/render-ad")]
    assert zones == [SAFE, ADS_SAFE]
    assert job.read("result.json")["ad"] == {"durations": {"source": 4.0, "final": 3.5}, "qa": {"ok": True, "problems": []}}
    job.write("edit.json", EDIT_4S)
    assert main(["render", str(job.root)]) == 0
    assert not job.path("out/final-ad.mp4").exists()


# ---------- второй заход: ревью ветки ----------


def test_a_failing_version_b_ad_or_cover_leaves_no_old_file_and_version_a_results_are_written(tmp_path, monkeypatch):
    """Сломались версия B, реклама или обложка — их файлов прошлого рендера в out/ нет, а итоги A уже от нового ролика."""
    import vm.__main__ as cli
    from vm.render import RenderError

    def broken_cover(job_, edit_, out):
        raise RenderError("обложка: сломалась")

    for fail_on, extra in (("final-b", {"teaser": {"t0": 1.0, "t1": 3.0}, "ab": "teaser"}), ("final-ad", {"ad": True}),
                           ("cover", {"cover": {"t": 1.0, "text": "Как я учу"}})):
        job = Job(tmp_path / fail_on / "jobs" / "abc")
        job.write("edit.json", {**EDIT_4S, **extra})
        job.write("result.json", RESULT_OLD)
        job.path("out").mkdir(parents=True)
        for old in ("final-b.mp4", "final-ad.mp4", "final-cover.png"):
            job.path(f"out/{old}").write_bytes(b"old")
        _fake_outputs(monkeypatch, cli, job, fail_on=fail_on)
        monkeypatch.setattr(cli, "render_cover", broken_cover)
        assert main(["render", str(job.root)]) == 1
        assert sorted(p.name for p in job.path("out").iterdir()) == ["final.mp4"], fail_on
        assert job.read("result.json")["durations"]["final"] == 3.5, f"{fail_on}: итоги A — от нового ролика"


def test_cover_problems_name_the_field_to_change_and_a_wrong_size():
    from vm.__main__ import _cover_problems

    inside = {"x": 100, "y": 800, "w": 880, "h": 300}
    assert _cover_problems({"box": inside, "size": [1080, 1920]}) == []
    (high,) = _cover_problems({"box": {**inside, "y": 100}, "size": [1080, 1920]})
    assert "edit.cover.text" in high
    assert _cover_problems({"box": inside, "size": [1080, 608]}) == ["обложка: картинка 1080×608 вместо 1080×1920"]


@needs_ffmpeg
def test_preview_of_a_landscape_source_is_the_9_by_16_frame_of_the_video(tmp_path):
    """Кадры для превью и обложки — как в ролике: горизонтальный исходник по центру на размытой копии; рамка `--mark` —
    в координатах кадра 1080×1920."""
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x608:r=30:d=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", str(job.path("source.mp4"))], check=True)
    assert main(["preview", str(job.root), "--at", "0.5", "--out", "q-logo.png", "--mark", "100,1500,300,200"]) == 0
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(job.path("q-logo.png")), "-f", "rawvideo",
                          "-pix_fmt", "rgb24", "-"], check=True, capture_output=True).stdout
    assert len(raw) == 1080 * 1920 * 3, "кадр 1080×1920"
    frame = np.frombuffer(raw, np.uint8).reshape(1920, 1080, 3).astype(int)
    assert frame[100, 540].max() > 20, "сверху — размытая копия кадра"
    assert np.abs(frame[1503, 200] - [255, 210, 63]).max() < 40, "рамка там, где встанет вставка"


def test_render_checks_the_hook_against_the_face_as_big_as_the_strongest_zoom_makes_it(tmp_path, monkeypatch):
    """Зум держит лицо на месте и делает его крупнее: хук в 50 px над лицом без зума при зуме 1.16 уже на лице."""
    import vm.__main__ as cli
    from vm.qa import face_box

    face = {"x": 0.5, "y": 0.4}
    top = face_box(face)["y"]
    hook = {"x": 150, "y": top - 50 - 160, "w": 600, "h": 160}
    job = Job(tmp_path / "jobs" / "abc")
    _fake_outputs(monkeypatch, cli, job)
    plain = cli.render

    def render(job_, out_dir, name="final", preset="medium", edit=None, work="work/render"):
        result = plain(job_, out_dir, name=name, preset=preset, edit=edit, work=work)
        job_.path(f"{work}/frames/boxes.json").write_text(json.dumps([{"t0": 0, "t1": 2, "boxes": {"hook": hook}}]), encoding="utf-8")
        return result

    monkeypatch.setattr(cli, "render", render)
    for level, flagged in ((1.0, False), (1.16, True)):
        job.write("edit.json", {**EDIT_4S, "face": face, "zooms": [{"t": 0.5, "level": level}]})
        assert main(["render", str(job.root)]) == 0
        problems = job.read("result.json")["qa"]["problems"]
        assert any("хук на лице" in p for p in problems) == flagged, (level, problems)


def test_prepare_stops_when_a_video_of_the_job_is_missing(tmp_path, monkeypatch, capsys):
    no_models(monkeypatch, tmp_path)
    job = Job(tmp_path / "jobs" / "abc")
    job.path("in").mkdir(parents=True)
    job.path("in/source.mov").write_bytes(b"x")
    videos = [{"file": "in/source.mov", "name": "IMG_1.MOV"}, {"file": "in/source-2.mp4", "name": "IMG_2.mp4"}]
    job.path("job.json").write_text(json.dumps({"brief": "", "videos": videos}), encoding="utf-8")
    job.path("words.json").write_text("[]\n", encoding="utf-8")  # речь уже разобрана — моделей не нужно
    assert main(["prepare", str(job.root)]) == 1
    err = capsys.readouterr().err
    assert "IMG_2.mp4" in err and "vm fetch" in err, err


def test_render_encodes_with_veryfast_by_default(tmp_path, monkeypatch):
    """Финал — x264 veryfast, crf 18: втрое быстрее medium на настоящем ролике (34 → 11 с на 20 с), SSIM к
    исходнику не ниже (0,978 против 0,975), файл больше на ~18 %. `--preset` — для проверок (ultrafast)."""
    import vm.__main__ as cli

    job = Job(tmp_path / "jobs" / "abc")
    job.write("edit.json", {"speed": 1.0, "keep": [[0.0, 4.0]], "words": [], "hook": None, "cta": None, "inserts": [], "zooms": [],
                            "face": {"x": 0.5, "y": 0.3}, "music": None, "hold": 0.0, "style": STYLE})
    presets = []

    def fake_render(job_, out_dir, name="final", preset="medium", edit=None, work="work/render"):
        presets.append(preset)
        (job_.path(work) / "frames").mkdir(parents=True, exist_ok=True)
        (job_.path(work) / "frames" / "boxes.json").write_text("[]", encoding="utf-8")
        job_.path("out").mkdir(exist_ok=True)
        job_.path(f"out/{name}.mp4").write_bytes(b"video")
        return {"durations": {"source": 4.0, "final": 4.0}, "missing": [], "warnings": [], "voice": {}}

    monkeypatch.setattr(cli, "render", fake_render)
    monkeypatch.setattr(cli, "_fonts_ok", lambda job: None)
    monkeypatch.setattr(cli, "check_render", lambda final, edit, boxes, report: [])
    monkeypatch.setattr(cli, "control_frames", lambda *a, **k: {"sheet": job.path("qa/qa.png")})
    monkeypatch.setattr(cli, "checklist", lambda final, boxes, report: CHECKS)
    assert main(["render", str(job.root)]) == 0
    assert presets == ["veryfast"]
    import inspect

    from vm.render import render as real_render
    assert inspect.signature(real_render).parameters["preset"].default == "veryfast"
