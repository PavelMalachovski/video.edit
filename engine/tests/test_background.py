"""Долгие команды в фоне (`--detach`) и `vm wait`: команда идёт в своём процессе, wait ждёт её конца и отдаёт её вывод
и код — без циклов с pgrep, которые находят сами себя."""
import json
import sys
import time

from vm import background
from vm.__main__ import main
from vm.job import Job


def job_at(tmp_path) -> Job:
    root = tmp_path / "jobs" / "261015-000000-abcd"
    root.mkdir(parents=True)
    return Job(root)


def child(job: Job, body: str, name: str = "render") -> list[str]:
    """Команда-образец `name`: отмечает себя, как команды движка (`background.mark`), и делает `body`."""
    return [sys.executable, "-c", "\n".join([
        "import sys, time", "from vm import background", "from vm.job import Job",
        f"with background.mark(Job({str(job.root)!r}), {name!r}) as m:",
        *[f"    {line}" for line in body.splitlines()],
        "    m.code = 0",
    ])]


def test_wait_returns_the_output_and_code_of_the_finished_command(tmp_path):
    job = job_at(tmp_path)
    background.detach(job, "render", child(job, "time.sleep(0.6)\nprint('проверка: всё в порядке', flush=True)"))
    said = []
    assert background.wait(job, 20, said.append, poll=0.05) == 0
    assert "проверка: всё в порядке" in said[0] and said[-1] == "vm render: готово"
    assert not job.path(background.RUNNING).exists() and json.loads(job.path(background.DONE).read_text())["code"] == 0


def test_wait_gives_up_after_its_limit_and_says_the_command_is_still_running(tmp_path):
    job = job_at(tmp_path)
    background.detach(job, "render", child(job, "print('Монтирую', flush=True)\ntime.sleep(3)"))
    said = []
    start = time.monotonic()
    assert background.wait(job, 0.5, said.append, poll=0.05) == background.STILL
    assert time.monotonic() - start < 2, "не дольше своего предела"
    assert said[0].startswith("ещё идёт: vm render") and said[0].endswith("снова vm wait")
    assert background.wait(job, 20, said.append, poll=0.05) == 0, "снова — дождался"


def test_a_failed_or_killed_command_is_an_error(tmp_path):
    job = job_at(tmp_path)
    background.detach(job, "render", child(job, "print('error: нет source.mp4', flush=True)\nm.code = 1\nsys.exit(1)"))
    said = []
    assert background.wait(job, 20, said.append, poll=0.05) == 1
    assert "error: нет source.mp4" in said[0] and said[-1] == "vm render: ошибка (код 1)"
    background.detach(job, "render", child(job, "import os\nos._exit(9)"))
    said.clear()
    assert background.wait(job, 20, said.append, poll=0.05) == 1
    assert "без отметки о конце" in said[-1]


def test_nothing_in_the_background_is_nothing_to_wait_for(tmp_path):
    said = []
    assert background.wait(job_at(tmp_path), 1, said.append) == 0
    assert said == ["в фоне ничего не идёт"]


def test_cli_detach_lets_the_session_go_and_wait_waits(tmp_path, capsys):
    """`vm validate … --detach` нельзя (только долгие команды); `vm render --detach` — сразу назад, `vm wait` — её конец
    (здесь рендер падает сразу: в задаче нет edit.json — и wait отдаёт эту ошибку с её кодом)."""
    job = job_at(tmp_path)
    assert main(["render", str(job.root), "--detach"]) == 0
    assert "идёт в фоне" in capsys.readouterr().out
    assert main(["wait", str(job.root), "--max", "60"]) == 1
    out = capsys.readouterr().out
    assert "error:" in out and "vm render: ошибка (код 1)" in out


def test_a_command_run_in_the_session_meanwhile_does_not_take_the_place_of_the_one_in_the_background(tmp_path, capsys):
    """`vm matte --detach` идёт, а сессия тем временем запускает `vm prepare` (долгая команда, но не в фоне): её отметки не
    занимают место фоновой — `vm wait` ждёт маску и отдаёт её вывод и код, а не код prepare."""
    job = job_at(tmp_path)
    background.detach(job, "matte", child(job, "time.sleep(1.5)\nprint('маска готова', flush=True)", "matte"))
    assert main(["prepare", str(job.root)]) == 1, "prepare падает сразу: видео нет"
    capsys.readouterr()
    said = []
    assert background.wait(job, 20, said.append, poll=0.05) == 0
    assert "маска готова" in said[0] and said[-1] == "vm matte: готово"


def test_a_second_detach_while_one_runs_is_refused(tmp_path, capsys):
    """Вторая фоновая команда, пока первая жива, — отказ: два рендера писали бы одни файлы."""
    job = job_at(tmp_path)
    background.detach(job, "render", child(job, "time.sleep(2)"))
    assert main(["render", str(job.root), "--detach"]) == 1
    assert "уже идёт vm render" in capsys.readouterr().err
    assert background.wait(job, 20, lambda _: None, poll=0.05) == 0


def test_the_output_is_in_the_log_before_the_command_counts_as_done(tmp_path, monkeypatch):
    """Вывод без flush (PYTHONUNBUFFERED нет) — в логе раньше, чем отметка о конце: `vm wait` не отдаёт сводку без конца."""
    job = job_at(tmp_path)
    monkeypatch.delenv("PYTHONUNBUFFERED", raising=False)
    body = "\n".join([
        "import time", "from vm import background", "from vm.job import Job",
        f"with background.mark(Job({str(job.root)!r}), 'render') as m:",
        "    print('итог: всё в порядке')", "    m.code = 0",
        "time.sleep(1)",  # процесс ещё жив, сводка — в буфере
    ])
    background.detach(job, "render", [sys.executable, "-c", body])
    said = []
    assert background.wait(job, 20, said.append, poll=0.02) == 0
    assert "итог: всё в порядке" in said[0]
