"""CLI движка для Claude: python -m vm <команда> <папка задачи> …

    fetch    входные файлы из черновика job-<id> → in/
    prepare  in/ → source.mp4, work/source.wav, words.json, reference.txt, cuts.json, sheet.png; сводка
    frames   кадры исходника в моменты --at (с --grid — с сеткой) → look/
    preview  кадр исходника для превью → frame.png
    render   финал по edit.json → out/final[-vN].mp4|.srt, qa/qa.png, result.json
    push     коммит и пуш папки задачи (с --outputs — большие файлы out/ режутся на части)
    status   записать status.json (и при --push отправить)

С `--status` долгие команды пишут фазы в status.json и пушат его — страница показывает их Павлу.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from .fetch import fetch
from .git import MAX_FILE_BYTES, GitError, push
from .job import Job, set_status, states
from .media import extract_frame, grid_frames
from .prepare import prepare
from .qa import check_layout, check_render, control_frames, face_box
from .render import render

PART_SIZE = 95 * 1024 * 1024  # как `split -b 95M`: столько же, сколько MAX_FILE_BYTES


def _job(args: argparse.Namespace) -> Job:
    return Job(Path(args.jobdir))


def _stepper(job: Job, state: str, enabled: bool):
    """Колбэк фаз: с --status — status.json и пуш только его, иначе ничего."""

    def step(phase: str, message: str) -> None:
        if enabled:
            set_status(job, state=state, phase=phase, message=message)
            push(job, f"status({job.id}): {phase}", paths=["status.json"])

    return step


def _status(args: argparse.Namespace) -> None:
    job = _job(args)
    status = set_status(
        job,
        state=args.state,
        phase=args.phase,
        message=args.message,
        needs=args.needs,
        progress=args.progress,
        error=args.error,
    )
    if args.push:  # только status.json: остальные файлы задачи уходят своим push (тяжёлое режется перед этим)
        push(job, f"status({job.id}): {args.phase}", paths=["status.json"])
    print(f"{job.id}: {status['state']} / {status['phase']}" + (" (pushed)" if args.push else ""))


def _fetch(args: argparse.Namespace) -> None:
    job = _job(args)
    _stepper(job, "analyzing", args.status)("Скачиваю видео", "Забираю загруженные файлы")
    files = fetch(job)
    for name, path in files.items():
        print(f"{name}: {path.relative_to(job.root)} ({path.stat().st_size / 1024 / 1024:.1f} МБ)")


def _prepare(args: argparse.Namespace) -> None:
    job = _job(args)
    print(prepare(job, _stepper(job, "analyzing", args.status)))


def _frames(args: argparse.Namespace) -> None:
    job = _job(args)
    source = job.path("source.mp4")
    look = job.path("look")
    if args.grid:
        paths = grid_frames(source, args.at, look)
    else:
        paths = [extract_frame(source, t, look / f"frame_{t:08.3f}.png") for t in args.at]
    for p in paths:
        print(p.relative_to(job.root))


def _preview(args: argparse.Namespace) -> None:
    job = _job(args)
    path = extract_frame(job.path("source.mp4"), args.at, job.path("frame.png"))
    print(f"{path.relative_to(job.root)} — кадр {args.at:g} с для превью (styles.json: frameTime)")


def _qa_times(boxes: list[dict]) -> dict[str, float]:
    """Моменты контрольных кадров: середина первого промежутка, где виден хук, субтитры, вставка (уже появившаяся),
    титр."""
    times: dict[str, float] = {}
    for e in boxes:
        b = e.get("boxes") or {}
        middle = (e["t0"] + e["t1"]) / 2
        for key, name in (("hook", "hook"), ("sub", "subs"), ("cta", "cta")):
            if b.get(key) and name not in times:
                times[name] = middle
        if b.get("inserts") and "insert" not in times and e["t1"] - e["t0"] >= 0.1:
            times["insert"] = middle
    return times


def _render(args: argparse.Namespace) -> None:
    job = _job(args)
    step = _stepper(job, "rendering", args.status)
    name = "final" if args.version in (None, 1) else f"final-v{args.version}"
    step("Монтирую", "Собираю ролик: нарезка, текст, вставки, звук")
    result = render(job, job.path("out"), name=name, preset=args.preset)
    step("Проверяю", "Смотрю контрольные кадры и геометрию")
    edit = job.read("edit.json")
    final = job.path(f"out/{name}.mp4")
    boxes = json.loads(job.path("work/render/frames/boxes.json").read_text(encoding="utf-8"))
    problems = check_layout(boxes, face_box(edit.get("face"))) + check_render(final, edit, boxes)
    frames = control_frames(final, _qa_times(boxes), job.path("qa"))
    previous = job.read("result.json") if job.path("result.json").is_file() else {}
    job.write(
        "result.json",
        {
            "durations": result["durations"],
            "done": previous.get("done", []),
            "unsure": previous.get("unsure", []),
            "missing": result["missing"],
            "qa": {"ok": not problems, "problems": problems},
        },
    )
    print(f"{final.relative_to(job.root)}: {result['durations']['final']:.1f} с (исходник {result['durations']['source']:.1f} с)")
    print(f"контрольный лист: {frames['sheet'].relative_to(job.root)}")
    for line in result["missing"]:
        print(f"нет: {line}")
    for line in result["warnings"]:
        print(f"внимание: {line}")
    print("проверка: " + ("всё в порядке" if not problems else "проблемы:"))
    for line in problems:
        print(f"  - {line}")


def split_outputs(job: Job) -> list[Path]:
    """Файлы out/ больше 95 МБ → `<имя>.part-aa`, `-ab`, … по 95 МБ и `<имя>.sha256` (как `split -b 95M -a 2` и
    `sha256sum`); целый файл уходит в work/out/ (в git его нет). Их склеит Action job-outputs. → новые части."""
    out = job.path("out")
    made: list[Path] = []
    if not out.is_dir():
        return made
    for path in sorted(out.iterdir()):
        if not path.is_file() or path.stat().st_size <= MAX_FILE_BYTES or ".part-" in path.name or path.suffix == ".sha256":
            continue
        for stale in out.glob(f"{path.name}.part-*"):
            stale.unlink()
        digest = hashlib.sha256()
        letters = "abcdefghijklmnopqrstuvwxyz"
        with open(path, "rb") as src:
            for k in range(26 * 26):
                chunk_path = out / f"{path.name}.part-{letters[k // 26]}{letters[k % 26]}"
                written = 0
                with open(chunk_path, "wb") as dst:
                    while written < PART_SIZE:
                        block = src.read(min(8 * 1024 * 1024, PART_SIZE - written))
                        if not block:
                            break
                        digest.update(block)
                        dst.write(block)
                        written += len(block)
                if written == 0:
                    chunk_path.unlink()
                    break
                made.append(chunk_path)
        (out / f"{path.name}.sha256").write_text(f"{digest.hexdigest()}  {path.name}\n", encoding="utf-8")
        keep = job.path(f"work/out/{path.name}")
        keep.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), keep)
    return made


def _push(args: argparse.Namespace) -> None:
    job = _job(args)
    parts = split_outputs(job) if args.outputs else []
    push(job, args.message)
    note = f", частей: {len(parts)}" if parts else ""
    print(f"{job.id}: pushed{note}")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m vm", description="Движок монтажа video.edit")
    commands = parser.add_subparsers(dest="command", required=True)

    def command(name: str, run, help: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help)
        sub.add_argument("jobdir", help="папка задачи, например jobs/<id>")
        sub.set_defaults(run=run)
        return sub

    status = command("status", _status, "записать status.json задачи (и при --push отправить в ветку)")
    status.add_argument("--state", required=True, metavar="STATE", help="одно из: " + ", ".join(states()))
    status.add_argument("--phase", required=True, help="название фазы, например «Расшифровываю»")
    status.add_argument("--message", required=True, help="текст под фазой")
    status.add_argument("--needs", choices=["answers"], help="что ждём от Павла")
    status.add_argument("--progress", type=float, help="готовность фазы, 0..1")
    status.add_argument("--error", help="понятный текст ошибки")
    status.add_argument("--push", action="store_true", help="закоммитить status.json и запушить")

    for name, run, help in (
        ("fetch", _fetch, "скачать входные файлы из черновика job-<id> в in/"),
        ("prepare", _prepare, "исходник, слова, план резки, контактный лист — и сводка"),
    ):
        command(name, run, help).add_argument("--status", action="store_true", help="писать фазы в status.json и пушить")

    frames = command("frames", _frames, "кадры исходника в моменты --at → look/")
    frames.add_argument("--at", type=float, nargs="+", required=True, help="секунды исходника")
    frames.add_argument("--grid", action="store_true", help="с сеткой 10×10 и подписью времени")

    preview = command("preview", _preview, "кадр исходника для превью → frame.png")
    preview.add_argument("--at", type=float, required=True, help="секунда исходника")

    render_ = command("render", _render, "финал по edit.json → out/, qa/, result.json")
    render_.add_argument("--version", type=int, help="номер версии: 2 и дальше → final-vN (правки)")
    render_.add_argument("--preset", default="medium", help="пресет x264 (для проверок — ultrafast)")
    render_.add_argument("--status", action="store_true", help="писать фазы в status.json и пушить")

    push_ = command("push", _push, "коммит и пуш папки задачи")
    push_.add_argument("-m", "--message", required=True, help="сообщение коммита")
    push_.add_argument("--outputs", action="store_true", help="файлы out/ больше 95 МБ — частями (их склеит Action)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        args.run(args)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as err:
        # RuntimeError — это и GitError, MediaError, RenderError, FetchError, ошибки soundfile
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())


__all__ = ["GitError", "main", "split_outputs"]
