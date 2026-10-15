"""Долгие команды в фоне и честное ожидание их конца (`vm … --detach`, `vm wait`).

`vm prepare` на шаге analyze и `vm render` идут дольше, чем сессия может ждать одной командой (10 мин). Раньше сессия
запускала их в фоне и ждала циклом `until ! pgrep -f "vm render"` — а pgrep находит сам этот цикл (в его строке есть
«vm render»): цикл не кончался, ролик приходил позже на минуты, а сессия висела до часа. Теперь:
- `--detach` — команда уходит в свой процесс (своя сессия ОС: переживает конец команды сессии), её вывод — в
  `work/<команда>.log`, а сама команда сразу отпускает сессию;
- работающая команда отмечена в `work/running.json` (кто и с какого pid), законченная — в `work/done.json` (код);
- `vm wait` ждёт её конца не дольше `--max` секунд и печатает её вывод; код — её код, ещё идёт — 3 (подожди снова).
"""
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

from .job import Job

RUNNING = "work/running.json"
DONE = "work/done.json"
STILL = 3  # код `vm wait`: команда ещё идёт
POLL = 1.0  # с — как часто `vm wait` смотрит, жива ли команда


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def _read(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def log_of(job: Job, name: str) -> Path:
    return job.path(f"work/{name}.log")


class Mark:
    """Код команды для `work/done.json` (что вернула `main`); исключение мимо — 1."""

    code = 1


def busy(job: Job) -> str | None:
    """Какая команда идёт в фоне (её pid жив) или None."""
    running = _read(job.path(RUNNING))
    if running is None or not _alive(int(running.get("pid", 0))):
        return None
    return str(running.get("command"))


@contextmanager
def mark(job: Job, name: str) -> Iterator[Mark]:
    """Команда `name` идёт: `work/running.json` с её pid; кончилась — `work/done.json` с кодом (`Mark.code`). В фоне
    уже идёт другая (`vm matte --detach`, а сессия тем временем зовёт `vm prepare`) — место её: эта не отмечается."""
    m = Mark()
    running = _read(job.path(RUNNING))
    if running is not None and int(running.get("pid", 0)) != os.getpid() and _alive(int(running.get("pid", 0))):
        yield m
        return
    job.path(DONE).unlink(missing_ok=True)
    _write(job.path(RUNNING), {"command": name, "pid": os.getpid(), "started": _now()})
    try:
        yield m
    finally:
        for stream in (sys.stdout, sys.stderr):  # вывод — в лог раньше отметки о конце: vm wait читает его сразу
            try:
                stream.flush()
            except (OSError, ValueError):
                pass
        _write(job.path(DONE), {"command": name, "code": m.code, "ended": _now()})
        job.path(RUNNING).unlink(missing_ok=True)


def detach(job: Job, name: str, cmd: list[str]) -> int:
    """Запустить `cmd` (команду `name`) отдельным процессом в своей сессии ОС, вывод — в `work/<name>.log`; pid."""
    log = log_of(job, name)
    log.parent.mkdir(parents=True, exist_ok=True)
    job.path(DONE).unlink(missing_ok=True)
    with log.open("wb") as out:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    # до того как сама команда отметит себя: `vm wait` сразу после `--detach` её уже видит
    _write(job.path(RUNNING), {"command": name, "pid": proc.pid, "started": _now()})
    return proc.pid


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:  # процесс-зомби (кончился, а родитель не забрал код) — уже не идёт
        return Path(f"/proc/{pid}/stat").read_text().split(")")[-1].split()[0] != "Z"
    except OSError:
        return True


def wait(job: Job, most: float, out: Callable[[str], None] = print, poll: float = POLL) -> int:
    """Ждать команду в фоне не дольше `most` с: кончилась — её вывод и её код; ещё идёт — последние строки и `STILL`;
    в фоне ничего не шло — 0."""
    end = time.monotonic() + most
    while True:
        running = _read(job.path(RUNNING))
        if running is None or not _alive(int(running.get("pid", 0))):
            break
        if time.monotonic() >= end:
            started = datetime.fromisoformat(running["started"])
            minutes = (datetime.now(UTC) - started).total_seconds() / 60
            tail = _tail(log_of(job, running["command"]), 5)
            last = f" — последнее в выводе:\n{tail}" if tail else ""
            out(f"ещё идёт: vm {running['command']}, {minutes:.0f} мин{last}\nснова vm wait")
            return STILL
        time.sleep(poll)
    done = _read(job.path(DONE))
    name = (running or done or {}).get("command")
    if name is None:
        out("в фоне ничего не идёт")
        return 0
    text = _tail(log_of(job, name), 400)
    if text:
        out(text)
    if done is None or done.get("command") != name:
        job.path(RUNNING).unlink(missing_ok=True)
        out(f"vm {name} кончилась без отметки о конце (её остановили или она упала) — запусти её снова")
        return 1
    code = int(done.get("code", 1))
    out(f"vm {name}: {'готово' if code == 0 else f'ошибка (код {code})'}")
    return code


def _tail(path: Path, lines: int) -> str:
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").rstrip().splitlines()[-lines:])
    except OSError:
        return ""
