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
                self.send_header("Location", f"/blob/{m[1]}")
                self.end_headers()
                return None
            if m := re.fullmatch(r"/blob/(\d+)", url.path):
                fake.downloads += 1
                body = fake.blobs[int(m[1])]
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
    job.path("out").mkdir()
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


def test_validate_finds_insert_files_of_edit_json(tmp_path, capsys):
    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    edit = {"speed": 1.1, "keep": [[0.0, 3.0]], "words": [], "hook": None, "cta": None, "zooms": [], "face": {"x": 0.5, "y": 0.3},
            "music": {"file": "assets/music/nope.mp3", "gainDb": -18}, "hold": 0.0, "style": STYLE,
            "inserts": [{"kind": "image", "src": "in/uploads/nope.png", "t0": 1.0, "t1": 2.5, "x": 100, "y": 600, "w": 300}]}
    job.write("edit.json", edit)
    job.path("in").mkdir()  # после vm fetch
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
    job.path("in").mkdir()  # после vm fetch — проверяются
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
    assert main(["render", str(job.root)]) == 0
    result = job.read("result.json")
    assert result["caption"] == caption and result["done"] == ["вырезал паузы"]


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
