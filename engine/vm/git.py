"""Коммит и пуш папки задачи в ветку задачи (с повторами при отказе и сбоях сети)."""
import logging
import os
import re
import subprocess
import time
from pathlib import Path

from .job import Job

log = logging.getLogger(__name__)

BACKOFF = (2, 4, 8, 16)  # паузы перед повторами при сетевой ошибке, с
MAX_REBASES = 5  # сколько раз подряд лечим отказ пуша через pull --rebase
_REJECTED = re.compile(r"non-fast-forward|fetch first|rejected", re.IGNORECASE)


class GitError(RuntimeError):
    """Команда git не удалась (после всех повторов)."""


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    # LC_ALL=C — сообщения git по-английски (по ним узнаём отказ); без запроса пароля — сессия не интерактивна
    env = {**os.environ, "LC_ALL": "C", "GIT_TERMINAL_PROMPT": "0"}
    done = subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if check and done.returncode != 0:
        raise GitError(f"git {args[0]} failed: {(done.stderr or done.stdout).strip()}")
    return done


def _rebase_in_progress(root: Path) -> bool:
    for name in ("rebase-merge", "rebase-apply"):
        if (root / _git(root, "rev-parse", "--git-path", name).stdout.strip()).exists():
            return True
    return False


def _pull_rebase(root: Path) -> str | None:
    """pull --rebase текущей ветки с origin. None — получилось; строка — сбой без конфликта (сеть).
    Конфликт не лечится повторами: rebase откатывается, GitError."""
    branch = _git(root, "symbolic-ref", "--short", "HEAD").stdout.strip()
    # --autostash: в папке могут лежать несохранённые правки других файлов, без него pull --rebase откажется
    done = _git(root, "pull", "--rebase", "--autostash", "origin", branch, check=False)
    if done.returncode == 0:
        return None
    if _rebase_in_progress(root):
        _git(root, "rebase", "--abort", check=False)
        raise GitError(f"rebase conflict with origin/{branch}, rebase aborted: {done.stderr.strip()}")
    return done.stderr.strip()


def _push_with_retries(root: Path, sleep) -> None:
    delays = list(BACKOFF)
    rebases = 0
    while True:
        done = _git(root, "push", "-u", "origin", "HEAD", check=False)
        if done.returncode == 0:
            return
        error = done.stderr.strip()
        if _REJECTED.search(error):  # в ветку успел кто-то закоммитить (Action) — подтягиваем и сразу повторяем
            if rebases == MAX_REBASES:
                raise GitError(f"push rejected {rebases} times in a row: {error}")
            rebases += 1
            log.warning("git push rejected, pull --rebase (%d/%d)", rebases, MAX_REBASES)
            error = _pull_rebase(root)
            if error is None:
                continue
        # сеть (или иной сбой): ждём 2/4/8/16 с и пробуем снова
        if not delays:
            raise GitError(f"git push failed after {len(BACKOFF)} retries: {error}")
        wait = delays.pop(0)
        log.warning("git push failed (%s), retry in %d s", (error.splitlines() or [""])[0], wait)
        sleep(wait)


def push(job: Job, message: str, paths: list[str] | None = None, *, sleep=None) -> None:
    """git add папки задачи (или paths — пути от папки задачи), commit и `git push -u origin HEAD`.

    Нет изменений — коммит пропускается, пуш всё равно идёт (мог остаться непушнутый коммит).
    Отказ пуша -> `git pull --rebase` и повтор; сетевая ошибка -> повтор через 2/4/8/16 с, потом GitError.
    `sleep` подменяется в тестах (по умолчанию time.sleep)."""
    sleep = sleep or time.sleep
    root = job.root
    targets = [str(job.path(p)) for p in paths] if paths else [str(root)]
    _git(root, "add", "-A", "--", *targets)
    staged = _git(root, "diff", "--cached", "--quiet", "--", *targets, check=False)
    if staged.returncode == 1:  # в индексе есть изменения; коммитим только наши пути, чужое в индексе не трогаем
        _git(root, "commit", "-m", message, "--", *targets)
    elif staged.returncode != 0:
        raise GitError(f"git diff failed: {staged.stderr.strip()}")
    _push_with_retries(root, sleep)
