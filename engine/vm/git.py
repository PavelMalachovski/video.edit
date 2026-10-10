"""Коммит и пуш папки задачи в ветку задачи (с повторами при отказе и сбоях сети)."""
import logging
import os
import re
import subprocess
import time
from pathlib import Path

from .job import Job

log = logging.getLogger(__name__)

MB = 1024 * 1024
BACKOFF = (2, 4, 8, 16)  # паузы перед повторами при сетевой ошибке, с
MAX_REBASES = 5  # сколько раз подряд лечим отказ пуша через pull --rebase
MAX_FILE_BYTES = 95 * MB  # файл больше в git не кладём: GitHub не принимает > 100 МБ; части `split -b 95M` ровно такие
_REJECTED = re.compile(r"non-fast-forward|fetch first|rejected", re.IGNORECASE)


class GitError(RuntimeError):
    """Команда git не удалась (после всех повторов) или push() отказался что-то коммитить."""


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


def _toplevel(root: Path) -> Path:
    return Path(_git(root, "rev-parse", "--show-toplevel").stdout.strip())


def _names(top: Path, command: list[str], targets: list[str]) -> set[str]:
    """Пути, которые печатает команда git (-z) для targets, от корня репозитория: запускается из top."""
    out = _git(top, *command, "-z", "--", *targets).stdout
    return {name for name in out.split("\0") if name}


def _unmerged(top: Path, targets: list[str] | None = None) -> list[str]:
    """Пути с неразрешёнными конфликтами (в targets или во всём репозитории)."""
    where = ["--", *targets] if targets else []
    records = _git(top, "ls-files", "--unmerged", "-z", *where).stdout.split("\0")
    return sorted({record.split("\t", 1)[1] for record in records if "\t" in record})


def _oversized(top: Path, targets: list[str]) -> list[str]:
    """Файлы больше MAX_FILE_BYTES среди тех, что попадут в коммит: `git add -A` возьмёт новые и изменённые
    (игнорируемые — нет), плюс уже лежащие в индексе."""
    names = _names(top, ["ls-files", "--modified", "--others", "--exclude-standard"], targets)
    names |= _names(top, ["diff", "--cached", "--name-only"], targets)
    big = []
    for name in sorted(names):
        try:
            size = (top / name).lstat().st_size
        except OSError:  # файл удалён — в коммит уйдёт удаление
            continue
        if size > MAX_FILE_BYTES:
            big.append(f"{name} ({size / MB:.1f} MB)")
    return big


def _stage_and_commit(root: Path, message: str, targets: list[str]) -> None:
    top = _toplevel(root)
    unmerged = _unmerged(top, targets)
    if unmerged:  # git add «разрешил» бы конфликт, закоммитив маркеры <<<<<<<
        raise GitError("refusing to commit unresolved merge conflicts in: " + ", ".join(unmerged))
    big = _oversized(top, targets)
    if big:
        raise GitError(
            f"refusing to commit files over {MAX_FILE_BYTES // MB} MB (GitHub rejects files over 100 MB): "
            + ", ".join(big)
            + ". Split them (split -b 95M) or keep them in the ignored work/ folder"
        )
    _git(root, "add", "-A", "--", *targets)
    staged = _git(root, "diff", "--cached", "--quiet", "--", *targets, check=False)
    if staged.returncode == 1:  # в индексе есть изменения; коммитим только наши пути, чужое в индексе не трогаем
        _git(root, "commit", "-m", message, "--", *targets)
    elif staged.returncode != 0:
        raise GitError(f"git diff failed: {staged.stderr.strip()}")


def _rebase_in_progress(root: Path) -> bool:
    for name in ("rebase-merge", "rebase-apply"):
        if (root / _git(root, "rev-parse", "--git-path", name).stdout.strip()).exists():
            return True
    return False


def _stash_top(top: Path) -> str:
    """Хэш верхней записи stash; пусто, если stash пуст."""
    return _git(top, "rev-parse", "-q", "--verify", "refs/stash", check=False).stdout.strip()


def _check_autostash_applied(top: Path, stash_before: str) -> None:
    """`pull --rebase --autostash` завершается с 0 и тогда, когда правки не легли обратно (конфликт с тем, что
    подтянули): в файлах остаются маркеры, а сами правки — в stash. Молча идти дальше нельзя."""
    unmerged = _unmerged(top)
    new_stash = _stash_top(top) != stash_before
    if not unmerged and not new_stash:
        return
    detail = "conflicts in " + ", ".join(unmerged) if unmerged else "re-applying failed"
    if new_stash:
        entry = _git(top, "stash", "list", "-1").stdout.strip()  # «stash@{0}: autostash»
        detail += (
            f"; your uncommitted changes are kept in {entry} "
            "(see `git stash show -p`; once the conflicts are resolved, `git stash drop`)"
        )
    raise GitError(f"autostash could not be re-applied after rebase: {detail}")


def _pull_rebase(root: Path) -> str | None:
    """pull --rebase текущей ветки с origin. None — получилось; строка — сбой без конфликта (сеть).
    Конфликт не лечится повторами: rebase откатывается, GitError."""
    branch = _git(root, "symbolic-ref", "--short", "HEAD").stdout.strip()
    top = _toplevel(root)
    stash_before = _stash_top(top)
    # --autostash: в папке могут лежать несохранённые правки других файлов, без него pull --rebase откажется
    done = _git(root, "pull", "--rebase", "--autostash", "origin", branch, check=False)
    if done.returncode == 0:
        _check_autostash_applied(top, stash_before)
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

    paths=None — вся папка задачи; paths=[] — ничего не добавлять и не коммитить, только запушить.
    Перед add отказывается (GitError, ничего не добавлено): файл больше 95 МБ (MAX_FILE_BYTES) или
    неразрешённый конфликт среди добавляемого.
    Нет изменений — коммит пропускается, пуш всё равно идёт (мог остаться непушнутый коммит).
    Отказ пуша -> `git pull --rebase` и повтор; сетевая ошибка -> повтор через 2/4/8/16 с, потом GitError.
    `sleep` подменяется в тестах (по умолчанию time.sleep)."""
    sleep = sleep or time.sleep
    targets = [str(job.root)] if paths is None else [str(job.path(p)) for p in paths]
    if targets:
        _stage_and_commit(job.root, message, targets)
    _push_with_retries(job.root, sleep)
