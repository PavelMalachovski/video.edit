"""Тестовая задача на настоящем ролике: первые N секунд задачи рутины (её source.mp4 и файлы) — для tests/test_realclip.py.

    cd engine && python -m tests.realclip_prepare <папка задачи с source.mp4> <папка тестовой задачи> [--seconds 30]

Исходник режется без перекодирования (`-c copy`: у нормализованного source.mp4 нет B-кадров — `-t` режет ровно по
кадру); черновик (`edit.json`), слова, речь и нарезка — до той же секунды: что выходит за неё, убирается, обложка —
на 10-й секунде. Ответы, стили и вопросы — как были. Видео Павла в git не кладём: на GitHub папку собирает workflow
realclip и хранит архивом в черновике релиза `realclip-30s` (репозиторий закрытый).
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

KEEP = ("language.json", "job.json", "answers.json", "styles.json", "questions.json")


def trim(src: Path, dst: Path, seconds: float = 30.0) -> dict:
    """Задача `src` → тестовая задача `dst` на первых `seconds` с. → что в ней осталось (для сводки)."""
    dst.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(src / "source.mp4"),
                    "-t", f"{seconds:.3f}", "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", str(dst / "source.mp4")], check=True)
    read = lambda name: json.loads((src / name).read_text(encoding="utf-8"))
    write = lambda name, value: (dst / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    inside = lambda a, b: a < seconds and b <= seconds

    e = read("edit.json")
    e["keep"] = [[a, round(min(b, seconds), 3)] for a, b in e["keep"] if a < seconds and min(b, seconds) - a > 0.2]
    e["words"] = [w for w in e["words"] if w["t1"] <= seconds]
    e["cuts"] = [c for c in e.get("cuts") or [] if inside(c[0], c[1])]
    for key in ("accents", "looks", "inserts"):
        e[key] = [x for x in e.get(key) or [] if inside(x["t0"], x["t1"])]
    e["zooms"] = [z for z in e.get("zooms") or [] if z["t"] < seconds]
    e["transitions"] = [x for x in e.get("transitions") or [] if x["t"] < seconds]
    for key in ("cta", "teaser"):
        if e.get(key) and not inside(e[key]["t0"], e[key]["t1"]):
            e[key] = None
    if e.get("cover") and e["cover"]["t"] >= seconds:
        e["cover"] = {**e["cover"], "t": 10.0}
    e["ab"] = None
    e.pop("ad", None)
    write("edit.json", e)
    write("words.json", [w for w in read("words.json") if w["t1"] <= seconds])
    write("speech.json", [[a, min(b, seconds)] for a, b in read("speech.json") if a < seconds])
    cuts = read("cuts.json")
    cuts["duration"] = seconds
    cuts["keep"] = [[a, min(b, seconds)] for a, b in cuts["keep"] if a < seconds and min(b, seconds) - a > 0.2]
    cuts["joins"] = [t for t in cuts.get("joins") or [] if t < seconds]
    cuts["cut_seconds"] = round(seconds - sum(b - a for a, b in cuts["keep"]), 3)
    write("cuts.json", cuts)
    for name in KEEP:
        if (src / name).is_file():
            shutil.copy(src / name, dst / name)
    return {key: len(e.get(key) or []) for key in ("keep", "words", "accents", "looks", "zooms", "inserts")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("src", type=Path)
    parser.add_argument("dst", type=Path)
    parser.add_argument("--seconds", type=float, default=30.0)
    args = parser.parse_args()
    print(json.dumps(trim(args.src, args.dst, args.seconds), ensure_ascii=False))


if __name__ == "__main__":
    main()
