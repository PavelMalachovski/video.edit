"""Прогрев файлов окружения, которые шаг прочтёт позже (модели, Chromium), — пока `vm fetch` качает видео.

Диск сессии — снимок облачного окружения: файл, которого эта сессия ещё не читала, приходит по сети при первом чтении,
у моделей в ~/.cache/vm — ~11 МБ/с (Parakeet, 670 МБ, — 60 с; распознавание на холодную 161 с против 28 с на
тёплую). Whisper и GigaAM (1,2 ГБ) так читались бы почти 2 минуты прямо во время распознавания, Chromium слоя — в
начале рендера. `vm fetch` (первая команда любого шага) запускает `start`: отдельный процесс читает файлы шага по
порядку надобности — пока качается видео и готовится исходник — и кончается сам (не дольше `LIMIT`).

`python -m vm.warm [--analyze]` — сам прогрев: анализу (`--analyze`) — модели распознавания и Chromium для
`vm preview`, рендеру и правкам — Chromium и модель маски.
"""
import argparse
import importlib.util
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import asr, matte

CHUNK = 8 * 1024 * 1024
LIMIT = 15 * 60  # с — дольше не читаем: шаг уже давно читает сам


def _package(name: str) -> Path | None:
    """Папка пакета Python без импорта (импорт onnxruntime сам читал бы библиотеки — в этом процессе зря)."""
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError):
        return None
    places = list(spec.submodule_search_locations or []) if spec else []
    return Path(places[0]) if places else None


def _browser() -> list[Path]:
    """Chromium, которым Playwright рисует слой (headless shell; без него — полный)."""
    root = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH") or "/opt/pw-browsers")
    return sorted(root.glob("chromium_headless_shell-*")) or sorted(root.glob("chromium-*"))


def paths(analyze: bool) -> list[Path]:
    """Файлы шага по порядку надобности (папки — всеми файлами): анализу — Whisper (слушает первым), модель слов для
    русского (GigaAM), VAD, библиотеки распознавания, Chromium (`vm preview` в конце) и Parakeet (не русский ролик —
    последним); рендеру — Chromium, модель маски и onnxruntime."""
    wanted: list[Path | None] = []
    if analyze:
        wanted += [asr._model("ASR_REF_MODEL", asr.WHISPER), asr._model("ASR_MODEL", asr.GIGAAM),
                   asr._model("VAD_MODEL", asr.SILERO), _package("sherpa_onnx"), *_browser(),
                   asr._model("PARAKEET_MODEL", asr.PARAKEET)]
    else:
        wanted += [*_browser(), matte.model_path(), _package("onnxruntime")]
    if node := shutil.which("node"):
        wanted.append(Path(node).resolve())
    files: list[Path] = []
    for place in wanted:
        if place is None:
            continue
        if place.is_dir():
            files += sorted(p for p in place.rglob("*") if p.is_file() and not p.is_symlink())
        elif place.is_file():
            files.append(place)
    seen: set[Path] = set()
    return [p for p in files if not (p in seen or seen.add(p))]


def warm(files: list[Path], until: float | None = None) -> int:
    """Прочесть файлы целиком (в никуда) → сколько байт; нет файла или не читается — дальше. `until` — по `monotonic`."""
    total = 0
    for path in files:
        if until is not None and time.monotonic() > until:
            break
        try:
            with open(path, "rb", buffering=0) as f:
                while block := f.read(CHUNK):
                    total += len(block)
        except OSError:
            continue
    return total


def start(analyze: bool) -> None:
    """Прогрев своим процессом в своей сессии ОС (переживает конец `vm fetch`), вывод — в никуда; VM_WARM=0 — нет."""
    if os.environ.get("VM_WARM", "1") == "0":
        return
    cmd = [sys.executable, "-m", "vm.warm", *(["--analyze"] if analyze else [])]
    try:
        subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError:  # прогрев — только скорость
        pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m vm.warm", description="прочесть файлы шага заранее")
    parser.add_argument("--analyze", action="store_true", help="шаг analyze: модели распознавания")
    args = parser.parse_args(argv)
    warm(paths(args.analyze), until=time.monotonic() + LIMIT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
