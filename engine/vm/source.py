"""Исходник задачи `source.mp4` — нормализация один раз на задачу, а не в каждой сессии.

`vm prepare` делает исходник из видео Павла (`media.normalize`): на 4K HEVC с iPhone это ~1 с на секунду видео, и раньше —
в каждой сессии (render и каждая правка: 4,4 минуты видео — 5–8 минут). Action job-source делает его же, как только
у задачи появился job.json (параллельно анализу), и кладёт в черновик релиза: `source-<ключ>.mp4` кусками
`.part-NNNNN` и последним — `source-<ключ>.json` (`describe`: размер, sha256, кусков; есть описание — всё загружено).
`vm fetch` берёт готовый исходник вместо видео Павла, если ключ совпал. Ключ (`key`) — видео задачи (ассет и размер),
её озвучка (повтор без озвучки — другой ключ) и версия нормализации `NORMALIZE`: поменяли `media.normalize` (фильтры,
кодек) — подними её, и старые исходники не возьмутся.

`python -m vm.source <папка задачи>` — что делает Action: исходник из in/ (после `vm fetch --originals`), на stdout — имя
ассета; `--name` — только имя (у задачи-сценария видео нет — пустая строка); `--describe N` — описание готового
`source.mp4`, порезанного на N кусков.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

from .job import Job
from .media import Probe, normalize, source_parts

NORMALIZE = 1


def _job_json(job: Job) -> dict:
    path = job.path("job.json")
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


def _voice_ref(meta: dict) -> dict | None:
    return next((u for u in meta.get("uploads") or [] if isinstance(u, dict) and u.get("kind") == "audio"), None)


def voice(job: Job) -> tuple[Path, str] | None:
    """Озвучка Павла — upload `kind: "audio"` в job.json: (файл, как он назывался у Павла); нет — None. В job.json есть,
    а файла нет — ValueError: без неё ролик собрался бы со звуком видео."""
    up = _voice_ref(_job_json(job))
    if up is None:
        return None
    file = job.path(str(up.get("file") or ""))
    if not (file.is_file() and file.is_relative_to(job.path("in"))):
        raise ValueError(f"озвучки {up.get('name')} нет ({up.get('file')}) — сначала vm fetch {job.root}")
    return file, str(up.get("name") or file.name)


def key(job: Job) -> str:
    """Ключ входов исходника по job.json: видео задачи по порядку (ассет, размер), озвучка (ассет, размер), `NORMALIZE`."""
    meta = _job_json(job)
    videos = meta.get("videos") or [{"asset": "source", "size": meta.get("size")}]
    up = _voice_ref(meta)
    inputs = {
        "videos": [[v.get("asset"), v.get("size")] for v in videos if isinstance(v, dict)],
        "voice": [up.get("asset"), up.get("size")] if up else None,
        "normalize": NORMALIZE,
    }
    return hashlib.sha1(json.dumps(inputs, sort_keys=True).encode()).hexdigest()[:12]


def asset(job: Job) -> str | None:
    """Имя готового исходника в черновике; у задачи-сценария (видео нет) — None."""
    return None if _job_json(job).get("kind") == "script" else f"source-{key(job)}.mp4"


def make(job: Job) -> Probe:
    """Исходник из видео задачи в in/ (по порядку) и её озвучки → `source.mp4`; что вышло — probe."""
    parts = source_parts(job.path("in"))
    if not parts:
        raise ValueError(f"{job.path('in')}: нет видео — сначала python -m vm fetch {job.root} --originals")
    meta = _job_json(job)
    present = {p.name for p in parts}
    if lost := [v.get("name") or v.get("file") for v in meta.get("videos") or []
                if isinstance(v, dict) and Path(str(v.get("file", ""))).name not in present]:
        raise ValueError(f"нет видео задачи: {', '.join(map(str, lost))} — сначала python -m vm fetch {job.root} --originals")
    found = voice(job)
    return normalize(parts, job.path("source.mp4"), voice=found[0] if found else None)


def describe(path: Path, parts: int) -> dict:
    """Описание готового исходника для черновика: по нему fetch проверяет, что скачал (размер, sha256, кусков)."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(8 * 1024 * 1024):
            digest.update(chunk)
    return {"size": path.stat().st_size, "sha256": digest.hexdigest(), "parts": parts, "normalize": NORMALIZE}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m vm.source", description="Готовый исходник задачи для черновика релиза")
    parser.add_argument("job", help="папка задачи jobs/<id>")
    parser.add_argument("--name", action="store_true", help="только имя ассета готового исходника")
    parser.add_argument("--describe", type=int, metavar="N", help="описание source.mp4, порезанного на N кусков")
    args = parser.parse_args(argv)
    job = Job(args.job)
    name = asset(job)
    if args.name:
        print(name or "")
        return 0
    if name is None:
        print("задача-сценарий: видео нет", file=sys.stderr)
        return 1
    if args.describe is not None:
        print(json.dumps(describe(job.path("source.mp4"), parts=args.describe)))
        return 0
    try:
        make(job)
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    print(name)
    return 0


if __name__ == "__main__":
    sys.exit(main())
