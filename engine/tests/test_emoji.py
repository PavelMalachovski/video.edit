"""Эмодзи картинками: куски «текст / эмодзи» (общая с шаблоном фикстура) и сборка картинок из шрифта Noto."""
import json
import shutil
import struct
from pathlib import Path

import pytest

from vm import emoji

FIXTURES = Path(__file__).parent / "fixtures"
NOTO = Path("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf")


def png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    return struct.unpack(">II", data[16:24])


@pytest.mark.slow
@pytest.mark.skipif(not (NOTO.is_file() and shutil.which("node")), reason="нужны шрифт Noto Color Emoji и node")
def test_build_takes_every_emoji_of_the_font(tmp_path):
    index = emoji.build(NOTO, tmp_path)
    assert index == json.loads((tmp_path / "index.json").read_text(encoding="utf-8"))
    keys = set(index["emoji"])
    # одиночные, ZWJ (семья, огненное сердце), флаги (в том числе Англия — теги; у США глиф общий с Внешними
    # малыми островами США — картинки у обоих свои), кейкап, оттенок кожи
    for key in ("1f525", "2764", "1f468-200d-1f469-200d-1f467", "2764-200d-1f525", "1f1fa-1f1f8", "1f1fa-1f1f2",
                "1f3f4-e0067-e0062-e0065-e006e-e0067-e007f", "23-20e3", "1f44d-1f3fd"):
        assert key in keys, key
        assert png_size(tmp_path / f"{key}.png") == (136, 128)
    assert len(keys) > 3500 and len(list(tmp_path.glob("*.png"))) == len(keys)
    # обратный порядок (так шрифт понимает письмо справа налево) — не стандартная запись, её нет вовсе
    assert "1f642-200d-2194" in keys and "2194-200d-1f642" not in keys
    # что по умолчанию текст: эмодзи только с FE0F; что по умолчанию эмодзи — нет в списке
    assert {"a9", "ae", "2122", "2764", "23", "30"} <= set(index["text"])
    assert "1f525" not in index["text"]
    # не эмодзи и служебные знаки последовательностей — не картинки
    assert not keys & {"20", "200d", "20e3", "e0067", "fe0f"}
    assert index["size"] == [136, 128] and index["ppem"] == 109 and index["baseline"] == 101
    assert index["font"] == "Noto Color Emoji 2.047"


CASES = json.loads((FIXTURES / "emoji-runs.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["why"] for c in CASES])
def test_runs_split_text_like_the_template(case):
    assert [list(r[:2]) for r in emoji.runs(case["text"])] == case["runs"]


def test_every_emoji_of_the_list_has_its_picture():
    index = json.loads((emoji.FOLDER / "index.json").read_text(encoding="utf-8"))
    files = {p.stem for p in emoji.FOLDER.glob("*.png")}
    assert files == set(index["emoji"])
    assert set(index["text"]) <= files


def test_strip_found_and_emoji_only():
    assert emoji.text_only("Огонь 🔥 рядом") == "Огонь  рядом"
    assert emoji.found("❤\ufe0f и 👍🏽") == ["❤\ufe0f", "👍🏽"]
    assert emoji.text_default("❤") and not emoji.text_default("🔥") and not emoji.text_default("a")
    assert emoji.emoji_only(" 🔥👍🏽 ") and not emoji.emoji_only("🔥 да") and not emoji.emoji_only("  ")
