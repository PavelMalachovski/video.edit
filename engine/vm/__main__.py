"""CLI движка: python -m vm <команда>. Новые команды добавляются вместе с модулями."""
import argparse
import sys
from pathlib import Path

from .git import GitError, push
from .job import Job, set_status, states


def _status(args: argparse.Namespace) -> None:
    job = Job(Path(args.jobdir))
    status = set_status(
        job,
        state=args.state,
        phase=args.phase,
        message=args.message,
        needs=args.needs,
        progress=args.progress,
        error=args.error,
    )
    if args.push:
        push(job, f"status({job.id}): {args.phase}")
    print(f"{job.id}: {status['state']} / {status['phase']}" + (" (pushed)" if args.push else ""))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m vm", description="Движок монтажа video.edit")
    commands = parser.add_subparsers(dest="command", required=True)

    status = commands.add_parser("status", help="записать status.json задачи (и при --push отправить в ветку)")
    status.add_argument("jobdir", help="папка задачи, например jobs/<id>")
    status.add_argument("--state", required=True, metavar="STATE", help="одно из: " + ", ".join(states()))
    status.add_argument("--phase", required=True, help="название фазы, например «Расшифровываю»")
    status.add_argument("--message", required=True, help="текст под фазой")
    status.add_argument("--needs", choices=["answers"], help="что ждём от Павла")
    status.add_argument("--progress", type=float, help="готовность фазы, 0..1")
    status.add_argument("--error", help="понятный текст ошибки")
    status.add_argument("--push", action="store_true", help="закоммитить папку задачи и запушить")
    status.set_defaults(run=_status)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        args.run(args)
    except (ValueError, GitError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
