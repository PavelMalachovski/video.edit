"""git.push: настоящие git-репозитории во временных папках, origin — bare, сети нет."""
import json
import subprocess
from pathlib import Path

import pytest

from vm.__main__ import main
from vm.git import GitError, push
from vm.job import Job, set_status


def git(cwd, *args):
    done = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True, encoding="utf-8")
    return done.stdout.strip()


def commits(origin: Path) -> list[str]:
    """Заголовки коммитов ветки main в remote, свежие первыми."""
    return git(origin, "log", "--format=%s", "main").splitlines()


def files_in(origin: Path) -> list[str]:
    return git(origin, "ls-tree", "-r", "--name-only", "main").splitlines()


def clone(origin: Path, dest: Path) -> Path:
    git(dest.parent, "clone", "-q", str(origin), str(dest))
    return dest


MB = 1024 * 1024


def make_sparse(path: Path, size: int) -> None:
    """Файл нужного размера без реальных данных на диске."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        f.truncate(size)


def commit_and_push(repo: Path, filename: str, text: str, message: str) -> None:
    (repo / filename).write_text(text, encoding="utf-8")
    git(repo, "add", filename)
    git(repo, "commit", "-q", "-m", message)
    git(repo, "push", "-q", "-u", "origin", "HEAD")


@pytest.fixture(autouse=True)
def isolated_git(tmp_path, monkeypatch):
    """Глобальный конфиг git окружения (подпись коммитов и т. п.) тестам не нужен."""
    config = tmp_path / "gitconfig"
    config.write_text(
        "[user]\n\tname = Test\n\temail = test@example.com\n"
        "[commit]\n\tgpgsign = false\n"
        "[init]\n\tdefaultBranch = main\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")


@pytest.fixture
def origin(tmp_path) -> Path:
    """Bare-репозиторий с одним коммитом `seed` в main."""
    bare = tmp_path / "origin.git"
    git(tmp_path, "init", "-q", "--bare", "-b", "main", str(bare))
    seed = clone(bare, tmp_path / "seed")
    commit_and_push(seed, "README.md", "seed\n", "seed")
    return bare


@pytest.fixture
def job(tmp_path, origin) -> Job:
    """Задача jobs/abc в рабочем клоне origin."""
    work = clone(origin, tmp_path / "work")
    return Job(work / "jobs" / "abc")


def write_status(job: Job, phase: str = "Расшифровываю") -> None:
    set_status(job, state="analyzing", phase=phase, message="Слушаю речь")


# --- основной путь ----------------------------------------------------------------


def test_push_commits_and_pushes_to_bare_remote(origin, job):
    write_status(job)
    push(job, "status(abc): analyzing")

    assert commits(origin)[0] == "status(abc): analyzing"
    assert "jobs/abc/status.json" in files_in(origin)
    shown = json.loads(git(origin, "show", "main:jobs/abc/status.json"))
    assert shown["state"] == "analyzing"


def test_push_adds_the_whole_job_folder_by_default(origin, job):
    write_status(job)
    job.write("words.json", [{"t0": 0, "t1": 1, "text": "а"}])
    job.path("out").mkdir()
    job.path("out/final.srt").write_text("1\n", encoding="utf-8")
    push(job, "everything")

    assert {"jobs/abc/status.json", "jobs/abc/words.json", "jobs/abc/out/final.srt"} <= set(files_in(origin))


def test_push_only_given_paths(origin, job):
    write_status(job)
    job.write("words.json", [])
    push(job, "status only", paths=["status.json"])

    files = files_in(origin)
    assert "jobs/abc/status.json" in files
    assert "jobs/abc/words.json" not in files


def test_push_with_empty_paths_stages_and_commits_nothing(origin, job):
    # [] не то же, что None: «ничего не добавлять», а не «всю папку»
    write_status(job)
    job.write("words.json", [])
    job.path("big.bin").write_bytes(b"x" * 1000)
    push(job, "must not appear", paths=[])

    assert commits(origin) == ["seed"]
    assert files_in(origin) == ["README.md"]
    assert git(job.root, "diff", "--cached", "--name-only") == ""  # и индекс не тронут


def test_push_with_empty_paths_still_pushes_local_commits(origin, job):
    write_status(job)
    git(job.root, "add", "status.json")
    git(job.root, "commit", "-q", "-m", "local only")  # коммит, сделанный не через push()
    push(job, "unused message", paths=[])

    assert commits(origin)[:2] == ["local only", "seed"]


def test_push_commits_deleted_files(origin, job):
    write_status(job)
    job.write("words.json", [])
    push(job, "add")
    job.path("words.json").unlink()
    push(job, "remove")

    assert commits(origin)[:2] == ["remove", "add"]
    assert "jobs/abc/words.json" not in files_in(origin)


def test_push_without_changes_is_not_an_error(origin, job):
    write_status(job)
    push(job, "one")
    push(job, "two")  # нечего коммитить — и не падаем

    assert commits(origin)[:2] == ["one", "seed"]


def test_push_does_not_sweep_in_unrelated_staged_files(origin, job):
    write_status(job)
    job.write("words.json", [])
    git(job.root, "add", "words.json")  # кто-то оставил в индексе чужое
    push(job, "status only", paths=["status.json"])

    assert "jobs/abc/words.json" not in files_in(origin)


# --- файлы больше 95 МБ в git не кладём -------------------------------------------


def test_push_refuses_files_over_95_mb_and_commits_nothing(origin, job):
    write_status(job)
    make_sparse(job.path("out/final.mp4"), 96 * MB)
    make_sparse(job.path("out/final.srt.bak"), 97 * MB)
    with pytest.raises(GitError) as exc:
        push(job, "doomed")

    assert "out/final.mp4" in str(exc.value) and "out/final.srt.bak" in str(exc.value)  # названы все
    assert git(job.root, "log", "--format=%s") == "seed"  # локального коммита нет
    assert git(job.root, "diff", "--cached", "--name-only") == ""  # и в индекс ничего не добавлено
    assert commits(origin) == ["seed"]


def test_push_accepts_a_file_of_exactly_95_mb(origin, job):
    # ровно столько весит часть `split -b 95M` — её пускать надо
    write_status(job)
    make_sparse(job.path("out/final.mp4.part-aa"), 95 * MB)
    push(job, "part")

    assert "jobs/abc/out/final.mp4.part-aa" in files_in(origin)


def test_push_ignores_heavy_files_git_would_not_stage(origin, job):
    # тяжёлое лежит в work/, корневой .gitignore его игнорирует — это не повод отказывать
    (job.root.parents[1] / ".gitignore").write_text("work/\n", encoding="utf-8")
    write_status(job)
    make_sparse(job.path("work/source.wav"), 200 * MB)
    push(job, "status")

    assert files_in(origin) == ["README.md", "jobs/abc/status.json"]


def test_push_refuses_a_big_file_that_is_already_staged(origin, job):
    write_status(job)
    make_sparse(job.path("out/final.mp4"), 96 * MB)
    git(job.root, "add", "out/final.mp4")  # кто-то добавил руками, а push() коммитит индекс по путям
    with pytest.raises(GitError, match=r"out/final\.mp4"):
        push(job, "doomed")

    assert git(job.root, "log", "--format=%s") == "seed"


# --- отказ пуша: remote ушёл вперёд -----------------------------------------------


def test_push_rebases_when_remote_moved(tmp_path, origin, job):
    other = clone(origin, tmp_path / "other")
    commit_and_push(other, "other.txt", "кто-то ещё\n", "chore: move outputs")  # job-клон теперь позади

    write_status(job)
    push(job, "status(abc): analyzing")

    assert commits(origin) == ["status(abc): analyzing", "chore: move outputs", "seed"]
    assert {"other.txt", "jobs/abc/status.json"} <= set(files_in(origin))


def test_push_rebases_with_unrelated_uncommitted_changes(tmp_path, origin, job):
    # words.json уже в истории и снова изменён, но в этот пуш не входит
    job.write("words.json", [{"t0": 0, "t1": 1, "text": "а"}])
    write_status(job, "one")
    push(job, "first")
    job.write("words.json", [{"t0": 0, "t1": 1, "text": "б"}])
    other = clone(origin, tmp_path / "other")
    commit_and_push(other, "other.txt", "x\n", "other")

    write_status(job, "two")
    push(job, "status only", paths=["status.json"])  # pull --rebase обязан пережить грязное дерево

    assert commits(origin)[:3] == ["status only", "other", "first"]
    assert job.read("words.json")[0]["text"] == "б"  # правка на месте, в коммит не попала
    assert json.loads(git(origin, "show", "main:jobs/abc/words.json"))[0]["text"] == "а"


def test_push_conflict_raises_and_leaves_repo_clean(tmp_path, origin, job):
    write_status(job, "one")
    push(job, "first")
    other = clone(origin, tmp_path / "other")
    commit_and_push(other, "jobs/abc/status.json", '{"чужой": true}\n', "other edits status")

    write_status(job, "two")  # тот же файл — конфликт при rebase
    with pytest.raises(GitError, match="conflict"):
        push(job, "ours edits status", sleep=lambda s: pytest.fail("конфликт не лечится ожиданием"))

    repo = job.root.parents[1]
    assert not (repo / ".git" / "rebase-merge").exists()
    assert not (repo / ".git" / "rebase-apply").exists()
    assert git(repo, "log", "-1", "--format=%s") == "ours edits status"  # наш коммит цел


def dirty_file_also_changed_upstream(tmp_path, origin, job):
    """words.json: у нас правка не закоммичена, а другой клон уже запушил своё изменение того же файла."""
    job.write("words.json", [{"t0": 0, "t1": 1, "text": "исходное"}])
    write_status(job, "one")
    push(job, "first")
    other = clone(origin, tmp_path / "other")
    commit_and_push(other, "jobs/abc/words.json", '[{"t0": 0, "t1": 1, "text": "чужое"}]\n', "other edits words")
    job.write("words.json", [{"t0": 0, "t1": 1, "text": "наше"}])
    write_status(job, "two")


def test_push_raises_when_autostash_cannot_be_reapplied(tmp_path, origin, job):
    # `pull --rebase --autostash` завершается с 0, даже если несохранённая правка не легла обратно
    dirty_file_also_changed_upstream(tmp_path, origin, job)

    with pytest.raises(GitError, match=r"stash@\{0\}"):
        push(job, "status only", paths=["status.json"], sleep=lambda s: pytest.fail("конфликт не лечится ожиданием"))

    repo = job.root.parents[1]
    assert "наше" in git(repo, "stash", "show", "-p", "stash@{0}")  # правка не потеряна: она в stash
    assert "status only" not in commits(origin)  # об успехе push() не соврал и ничего не отправил

    # и следующий push() не закоммитит маркеры конфликта
    with pytest.raises(GitError, match="unresolved"):
        push(job, "must not commit markers")
    assert "<<<<<<<" not in git(origin, "show", "main:jobs/abc/words.json")


def test_autostash_check_also_notices_unmerged_paths(tmp_path, origin, job, monkeypatch):
    # второй признак не зависит от stash: неразрешённые пути в индексе
    dirty_file_also_changed_upstream(tmp_path, origin, job)
    monkeypatch.setattr("vm.git._stash_top", lambda top: "")

    with pytest.raises(GitError, match=r"conflicts in jobs/abc/words\.json"):
        push(job, "status only", paths=["status.json"], sleep=lambda s: pytest.fail("конфликт не лечится ожиданием"))


# --- сетевые ошибки: повтор через 2/4/8/16 с --------------------------------------


def test_push_retries_network_errors_with_backoff(tmp_path, job):
    write_status(job)
    git(job.root, "remote", "set-url", "origin", str(tmp_path / "gone.git"))  # remote недоступен

    slept = []
    with pytest.raises(GitError):
        push(job, "msg", sleep=slept.append)

    assert slept == [2, 4, 8, 16]


def test_push_recovers_when_network_returns(tmp_path, origin, job):
    write_status(job)
    git(job.root, "remote", "set-url", "origin", str(tmp_path / "gone.git"))

    slept = []

    def sleep(seconds):
        slept.append(seconds)
        if len(slept) == 2:  # после второго ожидания сеть «вернулась»
            git(job.root, "remote", "set-url", "origin", str(origin))

    push(job, "after outage", sleep=sleep)

    assert slept == [2, 4]
    assert commits(origin)[0] == "after outage"
    assert commits(origin).count("after outage") == 1  # коммит один, не по разу на попытку


def test_push_sends_earlier_unpushed_commit_when_nothing_new(tmp_path, origin, job):
    # сеть моргнула: коммит остался локально; повторный запуск ничего нового не коммитит, но пушит
    write_status(job)
    good_url = git(job.root, "remote", "get-url", "origin")
    git(job.root, "remote", "set-url", "origin", str(tmp_path / "gone.git"))
    with pytest.raises(GitError):
        push(job, "first try", sleep=lambda s: None)
    git(job.root, "remote", "set-url", "origin", good_url)

    push(job, "again")

    assert commits(origin)[:2] == ["first try", "seed"]  # «again» не появился: коммитить было нечего


def test_push_gives_up_after_repeated_rejections(origin, job):
    hook = origin / "hooks" / "pre-receive"
    hook.write_text("#!/bin/sh\necho 'no pushes today' >&2\nexit 1\n", encoding="utf-8")
    hook.chmod(0o755)

    write_status(job)
    with pytest.raises(GitError, match="rejected"):
        push(job, "doomed", sleep=lambda s: pytest.fail("отказ не лечится ожиданием"))


def test_push_rejection_does_not_sleep(tmp_path, origin, job):
    other = clone(origin, tmp_path / "other")
    commit_and_push(other, "other.txt", "x\n", "other")

    write_status(job)
    push(job, "ours", sleep=lambda s: pytest.fail("при отказе пуша ждать не нужно — сразу rebase"))

    assert commits(origin)[:2] == ["ours", "other"]


# --- CLI --------------------------------------------------------------------------


def test_cli_status_with_push_commits_status(origin, job):
    rc = main(
        [
            "status", str(job.root),
            "--state", "analyzing",
            "--phase", "Расшифровываю",
            "--message", "Слушаю речь",
            "--push",
        ]
    )
    assert rc == 0
    assert commits(origin)[0] == "status(abc): Расшифровываю"
    assert "jobs/abc/status.json" in files_in(origin)


def test_cli_status_push_failure_exits_nonzero(tmp_path, job, capsys, monkeypatch):
    git(job.root.parent.parent, "remote", "set-url", "origin", str(tmp_path / "gone.git"))
    monkeypatch.setattr("vm.git.time.sleep", lambda s: None)  # не ждём настоящие 30 с

    rc = main(["status", str(job.root), "--state", "queued", "--phase", "p", "--message", "m", "--push"])

    assert rc == 1
    assert "git" in capsys.readouterr().err


def test_cli_status_push_stages_only_status_json(origin, job):
    job.write("words.json", [])  # другие файлы задачи не должны уехать вместе со статусом
    job.path("notes.txt").write_text("не для этого пуша\n", encoding="utf-8")
    rc = main(["status", str(job.root), "--state", "analyzing", "--phase", "Расшифровываю", "--message", "m", "--push"])

    assert rc == 0
    assert git(origin, "show", "--name-only", "--format=", "main") == "jobs/abc/status.json"
    assert not {"jobs/abc/words.json", "jobs/abc/notes.txt"} & set(files_in(origin))


def test_cli_status_push_leaves_big_outputs_alone(origin, job):
    # render уже записал out/final.mp4, а `push --outputs` его ещё не разрезал
    make_sparse(job.path("out/final.mp4"), 96 * MB)
    rc = main(["status", str(job.root), "--state", "rendering", "--phase", "Проверяю", "--message", "m", "--push"])

    assert rc == 0
    assert files_in(origin) == ["README.md", "jobs/abc/status.json"]


def test_a_git_command_that_hangs_is_stopped_and_reads_as_a_failure(monkeypatch, tmp_path):
    """git, который не отвечает (сеть прокси), не держит сессию: через потолок — отказ с причиной (push повторит его
    как сетевую ошибку), а не вечное ожидание."""
    from vm import git

    def hang(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    monkeypatch.setattr(git.subprocess, "run", hang)
    done = git._git(tmp_path, "push", "origin", "main", check=False)
    assert done.returncode != 0 and "не ответил" in done.stderr
    with pytest.raises(GitError, match="не ответил"):
        git._git(tmp_path, "push")
