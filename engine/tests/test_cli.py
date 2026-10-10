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
        self._next = 100

    def draft(self, tag: str, files: dict[str, bytes]) -> None:
        """Черновик `tag` с ассетами `files` (имя → байты) в случайном порядке."""
        rid = len(self.releases) + 1
        self.releases.append({"id": rid, "tag_name": tag, "draft": True, "assets": []})
        items = []
        for name, body in files.items():
            self._next += 1
            self.blobs[self._next] = body
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
                return self._json(fake.releases if page == 1 else [])
            if m := re.fullmatch(r"/repos/o/r/releases/(\d+)/assets", url.path):
                items = fake.assets.get(int(m[1]), [])
                return self._json(items[(page - 1) * 2 : page * 2])  # по два на страницу: листание обязательно
            if m := re.fullmatch(r"/repos/o/r/releases/assets/(\d+)", url.path):
                assert self.headers.get("Accept") == "application/octet-stream"
                self.send_response(302)
                self.send_header("Location", f"/blob/{m[1]}")
                self.end_headers()
                return None
            if m := re.fullmatch(r"/blob/(\d+)", url.path):
                fake.downloads += 1
                body = fake.blobs[int(m[1])]
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
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


def test_fetch_rejects_a_size_mismatch(tmp_path, github, capsys):
    body = random.Random(4).randbytes(6000)
    files = parts("source", body, 3000)
    files.pop("source.part-00001")  # кусок потерян
    github.draft("job-abc", {**files, "manifest.json": manifest("a.mov", body, 2)})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 1
    assert "source" in capsys.readouterr().err
    assert not (job / "in" / "source.mov").exists()


def test_fetch_twice_downloads_once(tmp_path, github):
    body = random.Random(5).randbytes(6000)
    files = parts("source", body, 3000)
    github.draft("job-abc", {**files, "manifest.json": manifest("a.mov", body, 2)})
    job = tmp_path / "jobs" / "abc"
    assert main(["fetch", str(job)]) == 0
    first = github.downloads
    assert main(["fetch", str(job)]) == 0
    assert github.downloads - first == 1, "only manifest.json again — the joined file is already there"


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
    for name in ("source.mp4", "words.json", "cuts.json", "sheet.png"):
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
    assert main(["render", str(job.root), "--preset", "ultrafast"]) == 0
    assert job.path("out/final.mp4").stat().st_size > 0
    assert job.path("out/final.srt").is_file()
    assert job.path("qa/qa.png").is_file()
    result = job.read("result.json")  # проходит схему
    assert result["durations"]["final"] > 0 and "music: none chosen" in result["missing"]
    assert set(result["qa"]) == {"ok", "problems"}
