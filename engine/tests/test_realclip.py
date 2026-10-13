"""Настоящий ролик (30 с говорящей головы с iPhone): каждая фича, настроенная Павлом до монтажа или в редакторе, видна в
смонтированном ролике — движок собирает его по-настоящему, проверки — по кадрам, звуку и раскладке слоя.

    REALCLIP_JOB=<папка задачи> [REALCLIP_OUT=<папка листов>] python -m pytest -m realclip tests/test_realclip.py

Папку задачи готовит tests/realclip_prepare.py; на GitHub — workflow realclip (на PR в master, ночью и вручную). Без
REALCLIP_JOB тесты пропускаются. Рендеров четыре (кодек ultrafast — к фичам он отношения не имеет; маска затемнения
общая): «как смонтировала сессия»; «стиль и места руками» (шрифт, цвета, субтитры, хук, шкала, вставка и акцент на
кадре); «картинка руками» (затемнение, зум, ч/б, переход — как правки редактора в timeline.json); «время» (скорость,
тизер, музыка, карточка, обложка). На каждую проверку — лист кадров в REALCLIP_OUT: его смотрят глазами.
"""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import pytest

from vm import edits
from vm.__main__ import main
from vm.job import Job
from vm.media import probe
from vm.render import timeline

SRC = Path(os.environ["REALCLIP_JOB"]) if os.environ.get("REALCLIP_JOB") else None
OUT = Path(os.environ.get("REALCLIP_OUT") or tempfile.mkdtemp(prefix="realclip-"))
pytestmark = [pytest.mark.realclip, pytest.mark.skipif(SRC is None, reason="нет REALCLIP_JOB — настоящего ролика")]

W, H = 270, 480  # кадры для проверок — вчетверо меньше: хватает и для цвета, и для формы
FLASH_AT = 7.9  # склейка на 7,9 с исходника — здесь у «как смонтировала сессия» переход со вспышкой
TEASER = {"t0": 20.3, "t1": 23.0, "sfx": None}
STICKER = {"kind": "text", "id": "s1", "text": "Проверка вставки", "t0": 11.0, "t1": 13.0, "x": 120, "y": 700, "w": 420}


# ---------- помощники ----------


def frame(video: Path, t: float) -> np.ndarray:
    """Кадр `video` в момент `t` (с), RGB float 270×480."""
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{max(0.0, t):.3f}", "-i", str(video),
                          "-frames:v", "1", "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(H, W, 3).astype(np.float32)


def luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ np.array([0.299, 0.587, 0.114], np.float32)


def saturation(rgb: np.ndarray) -> float:
    return float((rgb.max(axis=2) - rgb.min(axis=2)).mean())


def ncc(a: np.ndarray, b: np.ndarray) -> float:
    """Похожесть формы двух кадров (нормированная корреляция яркости): к общей яркости и контрасту нечувствительна."""
    x, y = luma(a).ravel(), luma(b).ravel()
    x, y = (x - x.mean()) / (x.std() + 1e-6), (y - y.mean()) / (y.std() + 1e-6)
    return float((x * y).mean())


def sheet(name: str, frames: list[tuple[str, np.ndarray]]) -> None:
    """Лист кадров с подписями → REALCLIP_OUT/<name>.png. Подписи — Rubik из шаблона: у шрифта Pillow по умолчанию
    кириллицы нет."""
    from PIL import Image, ImageDraw, ImageFont

    font = ImageFont.truetype(str(Path(__file__).resolve().parents[2] / "template/fonts/rubik/rubik.ttf"), 14)
    out = Image.new("RGB", (len(frames) * (W + 8), H + 28), "white")
    draw = ImageDraw.Draw(out)
    for i, (label, rgb) in enumerate(frames):
        out.paste(Image.fromarray(rgb.clip(0, 255).astype(np.uint8)), (i * (W + 8), 28))
        draw.text((i * (W + 8) + 4, 6), label[:44], fill="black", font=font)
    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / f"{name}.png")


def audio_rms(video: Path, t0: float, t1: float) -> float:
    """Громкость звука ролика на отрезке [t0, t1), RMS по отсчётам float."""
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", f"{t0:.3f}", "-t", f"{t1 - t0:.3f}", "-i", str(video),
                          "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], check=True, capture_output=True).stdout
    samples = np.frombuffer(raw, np.float32)
    return float(np.sqrt((samples ** 2).mean())) if samples.size else 0.0


class Rendered:
    """Сценарий: копия задачи с правками, смонтированная движком."""

    def __init__(self, job: Job, edit: dict, hand: dict | None):
        self.job = job
        self.final = job.path("out/final.mp4")
        self.result = job.read("result.json")
        self.boxes = json.loads(job.path("work/render/frames/boxes.json").read_text(encoding="utf-8"))
        self.spec = json.loads(job.path("work/render/spec.json").read_text(encoding="utf-8"))
        self.edit = edits.apply(edit, hand, probe(job.path("source.mp4")).duration)
        self.tl = timeline(self.edit)

    def at(self, source_t: float) -> float:
        """Момент ролика, где идёт `source_t` исходника (в отрезках, не в тизере)."""
        t = self.tl.to_final(source_t)
        assert t is not None, f"{source_t} с исходника вырезано"
        return t

    def box(self, what: str, t: float) -> dict | None:
        """Рамка элемента слоя (`sub`, `hook`, `accent`, `end`, `inserts`) в момент ролика `t`."""
        for b in self.boxes:
            if b["t0"] <= t < b["t1"]:
                return b["boxes"].get(what)
        return None


def render(name: str, change=None, hand: dict | None = None) -> Rendered:
    """Копия задачи (source.mp4 — ссылкой, маска затемнения — общая) с правкой edit.json (`change`) и правками
    редактора (`hand` → timeline.json), смонтированная `vm render --preset ultrafast`."""
    root = OUT / "jobs" / f"261013-000000-{name}"  # имя — как у задачи: id из папки
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for path in SRC.iterdir():
        if path.suffix == ".json":
            shutil.copy(path, root / path.name)
    (root / "source.mp4").symlink_to((SRC / "source.mp4").resolve())
    (OUT / "matte").mkdir(parents=True, exist_ok=True)
    (root / "work").mkdir()
    (root / "work" / "matte").symlink_to((OUT / "matte").resolve())
    job = Job(root)
    edit = job.read("edit.json")
    edit["transitions"] = [{"t": FLASH_AT, "kind": "flash"}]  # переход в ролике есть всегда — его убирает «картинка руками»
    edit["dim"] = 0.3
    edit["inserts"] = [*edit.get("inserts", []), dict(STICKER)]
    if change:
        change(edit)
    job.write("edit.json", edit)
    if hand:
        job.write("timeline.json", {"rev": 1, "at": "2026-10-13T00:00:00Z", "edits": [], **hand})
    assert main(["render", str(root), "--preset", "ultrafast"]) == 0, f"{name}: vm render не собрал ролик"
    return Rendered(job, edit, hand)


@pytest.fixture(scope="module")
def base() -> Rendered:
    return render("base")


@pytest.fixture(scope="module")
def styled() -> Rendered:
    def change(e: dict) -> None:
        s = e["style"]
        s["font"], s["hand"] = "rubik", "caveat"
        s["colors"] = {**s["colors"], "text": "#FFFFFF", "accent": "#FF2D55", "bar": "#FFD23F"}
        s["subtitles"] = {**s["subtitles"], "mode": "karaoke", "size": 80, "y": 1100}
        s["hook"] = {**s["hook"], "mode": "plate", "size": 96, "y": 600}
        s["bar"] = {"pos": "bottom", "height": 12}

    accent = None if SRC is None else Job(SRC).read("edit.json")["accents"][0]
    hand = {"text": {"inserts": [{"at": [STICKER["t0"], STICKER["t1"]], "x": 300, "y": 900, "w": 500}],
                     "accents": [{"at": [accent["t0"], accent["t1"]], "x": 540, "y": 400}] if accent else []}}
    return render("style", change, hand)


@pytest.fixture(scope="module")
def picture(base: Rendered) -> Rendered:
    looks = [{"at": [x["t0"], x["t1"]], "off": True} for x in base.edit.get("looks") or []]
    return render("pict", hand={"dim": 0.6, "zoom": 0, "looks": looks, "transitions": [{"at": FLASH_AT, "off": True}]})


@pytest.fixture(scope="module")
def timing() -> Rendered:
    def change(e: dict) -> None:
        e["speed"] = 1.0
        e["teaser"] = dict(TEASER)
        e["music"] = None
        e["hold"] = 0.0
        e["end"] = {**(e.get("end") or {"seconds": 2}), "lines": ["Проверка карточки"]}
        e["cover"] = {"t": 21.0, "text": "Обложка проверки"}

    return render("time", change)


# ---------- как смонтировала сессия ----------


def test_the_session_montage_comes_out_whole(base: Rendered):
    """Ролик целиком: длина — по шкале монтажа (+ стоп-кадр и карточка), есть звук, обложка 1080×1920."""
    info = probe(base.final)
    expected = base.tl.duration + float(base.edit.get("hold") or 0) + float((base.edit.get("end") or {}).get("seconds") or 0)
    assert abs(info.duration - expected) < 0.15, f"длина {info.duration:.2f} с вместо {expected:.2f}"
    assert (info.width, info.height) == (1080, 1920)
    cover = probe(base.job.path("out/final-cover.png"))
    assert (cover.width, cover.height) == (1080, 1920)
    assert audio_rms(base.final, 1.0, 3.0) > 0.01, "в ролике тишина"
    sheet("base", [(f"{t:.1f} с", frame(base.final, t)) for t in (0.5, 4.0, 8.0, 12.0, info.duration - 1.0)])


# ---------- стиль и места руками ----------


def test_font_and_colours_chosen_by_hand_reach_the_layer(base: Rendered, styled: Rendered):
    assert (styled.spec["font"], styled.spec["colors"]["accent"]) == ("rubik", "#FF2D55")
    assert base.spec["font"] != "rubik"
    t = next(b["t0"] + 0.05 for b in styled.boxes if b["boxes"].get("sub"))
    a, b = frame(base.final, t), frame(styled.final, t)
    red = (b[..., 0] > 200) & (b[..., 1] < 90) & (b[..., 2] < 120)  # подсветка слова #FF2D55 в караоке
    sheet("style-font-colours", [("сессия", a), ("Rubik, подсветка #FF2D55", b)])
    assert red.sum() > 20, "на кадре нет подсветки выбранного цвета"


def test_subtitles_and_hook_placed_and_sized_by_hand(base: Rendered, styled: Rendered):
    t = next(b["t0"] + 0.05 for b in styled.boxes if b["boxes"].get("sub"))
    sub = styled.box("sub", t)
    assert abs(sub["y"] + sub["h"] / 2 - 1100) < 120, f"субтитры не на 1100: {sub}"
    hook_t = next(b["t0"] + 0.05 for b in styled.boxes if b["boxes"].get("hook"))
    hook, was = styled.box("hook", hook_t), base.box("hook", hook_t)
    assert hook and was and abs(hook["y"] - was["y"]) > 60, f"хук не сдвинулся: {was} → {hook}"
    sheet("style-places", [("сессия", frame(base.final, t)), ("субтитры 1100, хук 600", frame(styled.final, t))])


def test_the_bar_moved_to_the_bottom_and_thickened(base: Rendered, styled: Rendered):
    t = styled.tl.duration * 0.5  # шкала дошла до середины кадра

    def yellow(rgb: np.ndarray) -> int:  # шкала #FFD23F в нижних строках кадра
        part = rgb[H - 6:]
        return int(((part[..., 0] > 200) & (part[..., 1] > 170) & (part[..., 2] < 120)).sum())

    a, b = frame(base.final, t), frame(styled.final, t)
    sheet("style-bar", [("сессия: шкала сверху", a), ("шкала снизу, 12 px", b)])
    assert yellow(b) > 60 and yellow(b) > 5 * yellow(a), f"внизу шкалы нет: {yellow(b)} точек (у сессии {yellow(a)})"


def test_the_insert_and_the_accent_stand_where_pavel_dragged_them(styled: Rendered):
    t = styled.at(STICKER["t0"] + 0.8)
    insert = (styled.box("inserts", t) or [None])[0]
    assert insert and abs(insert["x"] - 300) < 40 and abs(insert["y"] - 900) < 60 and abs(insert["w"] - 500) < 60, f"вставка: {insert}"
    accent0 = styled.edit["accents"][0]
    ta = styled.at((accent0["t0"] + accent0["t1"]) / 2)
    accent = styled.box("accent", ta)
    assert accent and abs(accent["x"] + accent["w"] / 2 - 540) < 60 and abs(accent["y"] + accent["h"] / 2 - 400) < 80, f"акцент: {accent}"
    sheet("style-insert-accent", [("вставка 300,900 ш.500", frame(styled.final, t)), ("акцент в 540,400", frame(styled.final, ta))])


# ---------- картинка руками ----------


def test_the_background_dim_follows_the_slider(base: Rendered, picture: Rendered):
    """Фон за человеком: 30 % у сессии, 60 % руками — стена темнее в (1 − 0,6) / (1 − 0,3) ≈ 0,57 раза."""
    t = base.at(10.0)  # между склейками, где и у сессии зума нет
    a, b = frame(base.final, t), frame(picture.final, t)
    wall = (slice(int(H * 0.25), int(H * 0.45)), slice(8, int(W * 0.18)))  # стена слева, далеко от человека
    ratio = luma(b)[wall].mean() / luma(a)[wall].mean()  # RGB кадра ≈ 1,164 (Y − 16): отношение — как у (Y − 16)
    sheet("picture-dim", [("фон −30 %", a), (f"фон −60 %: ×{ratio:.2f}", b)])
    assert 0.45 < ratio < 0.72, f"стена: ×{ratio:.2f} вместо ~0,57"


def test_the_bw_piece_turned_off_by_hand_is_in_colour(base: Rendered, picture: Rendered):
    look = (base.edit.get("looks") or [None])[0]
    if look is None:
        pytest.skip("в первых 30 с нет ч/б-куска")
    t = base.at((look["t0"] + look["t1"]) / 2)
    a, b = frame(base.final, t), frame(picture.final, t)
    sheet("picture-bw", [("ч/б у сессии", a), ("ч/б убран руками", b)])
    assert saturation(a) < 4 < saturation(b) - 4, f"насыщенность: {saturation(a):.1f} → {saturation(b):.1f}"


def test_zoom_at_zero_shows_the_frame_as_shot(base: Rendered, picture: Rendered):
    """Зум 0 — кадр как снят: ближе к исходнику, чем у сессии с приближением (форма, а не яркость)."""
    zoomed = max(base.edit["zooms"], key=lambda z: z["level"])
    assert zoomed["level"] > 1.05, "у сессии нет приближений"
    src_t = zoomed["t"] + 0.5
    t = base.at(src_t)
    shot = frame(base.job.path("source.mp4"), src_t)
    a, b = frame(base.final, t), frame(picture.final, t)
    sheet("picture-zoom", [("исходник", shot), (f"зум ×{zoomed['level']}", a), ("зум 0", b)])
    assert ncc(b, shot) > ncc(a, shot) + 0.03, f"похожесть на исходник: зум {ncc(a, shot):.3f}, без зума {ncc(b, shot):.3f}"


def test_the_transition_turned_off_by_hand_is_gone(base: Rendered, picture: Rendered):
    t = base.at(FLASH_AT)
    near = [base.at(FLASH_AT + 0.6), base.at(FLASH_AT + 1.0)]
    flash = luma(frame(base.final, t + 0.02)).mean()
    plain = luma(frame(picture.final, t + 0.02)).mean()
    calm = np.mean([luma(frame(base.final, x)).mean() for x in near])
    sheet("picture-transition", [("вспышка у сессии", frame(base.final, t + 0.02)), ("переход убран", frame(picture.final, t + 0.02))])
    assert flash > calm + 15, f"вспышки нет: {flash:.0f} при {calm:.0f} рядом"
    assert plain < flash - 15, f"переход не убрался: {plain:.0f} против {flash:.0f}"


# ---------- время, музыка, карточка, обложка ----------


def test_speed_and_teaser_set_the_length_and_the_start(base: Rendered, timing: Rendered):
    """×1,0 вместо ×1,2 — куски ролика длиннее в 1,2 раза, и первым — тизер (20,3–23,0 с исходника)."""
    teaser = TEASER["t1"] - TEASER["t0"]
    assert abs(timing.tl.duration - (base.tl.duration * 1.2 + teaser)) < 0.2, f"шкала {timing.tl.duration:.2f} с"
    info = probe(timing.final)
    card = float((timing.edit.get("end") or {}).get("seconds") or 0)
    assert abs(info.duration - (timing.tl.duration + card)) < 0.15, f"длина {info.duration:.2f} с"
    # начало ролика — фраза тизера: субтитры слоя на 0,4 с — слова, что звучат на 20,7 с исходника (кадр — для глаз:
    # зум у тизера свой, сравнивать пиксели с монтажом сессии нельзя)
    events = json.loads(timing.job.path("work/render/events.json").read_text(encoding="utf-8"))
    shown = next(e["state"] for e in events if e["t0"] <= 0.4 < e["t1"]).get("sub") or {}
    plain = lambda text: "".join(ch for ch in text.lower() if ch.isalnum())
    spoken = {plain(w["text"]) for w in timing.edit["words"] if w["t0"] < TEASER["t0"] + 0.9 and w["t1"] > TEASER["t0"]}
    sheet("time-teaser", [("начало ролика: тизер", frame(timing.final, 0.4)), ("у сессии 20,7 с", frame(base.final, base.at(TEASER["t0"] + 0.4))),
                          ("у сессии начало", frame(base.final, 0.4))])
    assert spoken & {plain(w) for w in shown.get("words", [])}, f"на 0,4 с субтитры {shown.get('words')}, а в тизере звучит {spoken}"


def test_music_off_by_hand_leaves_the_card_silent(base: Rendered, timing: Rendered):
    """Под карточкой речи нет: у сессии там музыка, без музыки — тишина."""
    end_a, end_b = probe(base.final).duration, probe(timing.final).duration
    with_music, without = audio_rms(base.final, end_a - 1.5, end_a - 0.3), audio_rms(timing.final, end_b - 1.5, end_b - 0.3)
    assert with_music > 0.005 and without < with_music / 4, f"под карточкой: с музыкой {with_music:.4f}, без {without:.4f}"


def test_the_end_card_shows_the_call_pavel_typed(timing: Rendered):
    end = probe(timing.final).duration
    events = json.loads(timing.job.path("work/render/events.json").read_text(encoding="utf-8"))
    cards = [e["state"]["end"] for e in events if e["state"].get("end")]
    assert cards and cards[-1]["lines"] == ["Проверка карточки"], cards[-1:] or "карточки нет"
    assert timing.box("end", end - 0.5), "на последних кадрах нет карточки"
    sheet("time-card", [("карточка", frame(timing.final, end - 0.5))])


def picture_of(path: Path) -> np.ndarray:
    from PIL import Image

    return np.asarray(Image.open(path).convert("RGB").resize((W, H)), np.float32)


def test_the_cover_follows_the_frame_and_text_pavel_chose(base: Rendered, timing: Rendered):
    a, b = picture_of(base.job.path("out/final-cover.png")), picture_of(timing.job.path("out/final-cover.png"))
    sheet("time-cover", [("обложка сессии", a), ("кадр 21 с, свой текст", b)])
    assert np.abs(a - b).mean() > 5, "обложка не изменилась"


def test_nothing_hangs_or_is_left_running():
    """После всех рендеров ни ffmpeg, ни браузера шаблона не осталось: монтаж не оставляет процессов, которые пришлось бы
    убивать."""
    alive = subprocess.run(["pgrep", "-af", "ffmpeg|headless_shell|chrome"], capture_output=True, text=True, check=False).stdout
    assert not [line for line in alive.splitlines() if "pgrep" not in line], alive

