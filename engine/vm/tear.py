"""Рваная бумага — переход `tear` формата «Разбор персонажа» (эталон 30.10.2026): за 0,3 с до входа в перебивку кадр
рвётся сверху донизу, щель расходится, в ней — перебивка в ч/б с газетным растром, края — белая рваная бумага.

Геометрия одна для ролика и для плеера редактора, поэтому она — картинки в `template/tear/` (шаблон копируется в
страницу при сборке): `slit-NN.png` — щель кадра NN (белое, непрозрачное — щель: так маску читают и CSS mask-image, и
ffmpeg alphaextract), `edge-NN.png` — края бумаги и тень
(RGBA, прозрачно вокруг), `dots.png` — растр (тёмные точки с прозрачностью поверх серого кадра перебивки). Рендер
накладывает их ffmpeg (`render._tears`), редактор — теми же файлами (маска CSS и картинки поверх).
Собрать заново после правки геометрии: `python3 -m vm.tear` (тест сверяет файлы с тем, что собирает `build`).
"""
from pathlib import Path

import numpy as np
from PIL import Image

from .transitions import TEAR

W, H = 1080, 1920
FRAMES = TEAR  # кадров перехода перед стыком (0,3 с при 30 к/с)
DIR = Path(__file__).resolve().parents[2] / "template" / "tear"
SLIT = "slit-{k:02d}.png"
EDGE = "edge-{k:02d}.png"
DOTS = "dots.png"

SEED = 30102026  # одна и та же бумага во всех роликах
CRACK, OPEN = 3, 430  # px — полуширина щели в первом и последнем кадре (в эталоне к концу — ~85 % кадра)
TILT = 0.02  # щель чуть наискось
PAPER = (246, 244, 240)  # белая бумага, чуть тёплая
BAND = (10, 20)  # px — ширина полосы бумаги у края щели: от и до
SHADOW = (6, 70)  # px и альфа тени за бумагой
DOT = {"step": 10, "r": 3.0, "rgb": (18, 18, 18), "alpha": 110}


def _noise(rng: np.random.RandomState, every: int, amp: float) -> np.ndarray:
    """Плавный шум по высоте кадра: случайные точки через `every` px, между ними — по прямой."""
    knots = rng.uniform(-amp, amp, H // every + 2)
    return np.interp(np.arange(H), np.arange(len(knots)) * every, knots)


def _edges() -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Линия разрыва и рваные края — одни на все кадры: центр, зубцы левого и правого края, ширина бумаги слева и справа."""
    rng = np.random.RandomState(SEED)
    y = np.arange(H)
    centre = W / 2 + TILT * (y - H / 2) + _noise(rng, 160, 8)
    left = _noise(rng, 9, 4) + _noise(rng, 2, 1.5)
    right = _noise(rng, 9, 4) + _noise(rng, 2, 1.5)
    band_l = BAND[0] + (BAND[1] - BAND[0]) * (0.5 + _noise(rng, 14, 0.5))
    band_r = BAND[0] + (BAND[1] - BAND[0]) * (0.5 + _noise(rng, 14, 0.5))
    return centre, left, right, band_l, band_r


def half_width(k: int) -> float:
    """Полуширина щели на кадре k: сначала трещина, потом всё быстрее расходится."""
    p = k / (FRAMES - 1)
    return CRACK + (OPEN - CRACK) * p**2.2


def frame(k: int) -> tuple[np.ndarray, np.ndarray]:
    """Кадр k: маска щели (H×W, 0/255) и края бумаги с тенью (H×W×4)."""
    centre, jag_l, jag_r, band_l, band_r = _edges()
    hw = half_width(k)
    x0 = (centre - hw - np.abs(jag_l))[:, None]
    x1 = (centre + hw + np.abs(jag_r))[:, None]
    x = np.arange(W)[None, :]
    slit = (x >= x0) & (x <= x1)
    paper = ((x >= x0 - band_l[:, None]) & (x < x0)) | ((x > x1) & (x <= x1 + band_r[:, None]))
    shadow = (((x >= x0 - band_l[:, None] - SHADOW[0]) & (x < x0 - band_l[:, None]))
              | ((x > x1 + band_r[:, None]) & (x <= x1 + band_r[:, None] + SHADOW[0])))
    edge = np.zeros((H, W, 4), np.uint8)
    edge[shadow] = (0, 0, 0, SHADOW[1])
    edge[paper] = (*PAPER, 255)
    return np.where(slit, 255, 0).astype(np.uint8), edge


def dots() -> np.ndarray:
    """Газетный растр: тёмные точки в шахматном порядке, прозрачно между ними."""
    step, r = DOT["step"], DOT["r"]
    y, x = np.mgrid[0:H, 0:W]
    shift = (y // step % 2) * (step / 2)  # ряды через один сдвинуты на полшага
    dy = (y % step) - step / 2 + 0.5
    dx = ((x + shift) % step) - step / 2 + 0.5
    inside = dx * dx + dy * dy <= r * r
    out = np.zeros((H, W, 4), np.uint8)
    out[inside] = (*DOT["rgb"], DOT["alpha"])
    return out


def build(out: Path = DIR) -> None:
    """Картинки перехода в `out` (по умолчанию — template/tear/)."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    for k in range(FRAMES):
        slit, edge = frame(k)
        mask = np.zeros((H, W, 4), np.uint8)
        mask[..., :3] = 255
        mask[..., 3] = slit
        Image.fromarray(mask, "RGBA").save(out / SLIT.format(k=k), optimize=True)
        Image.fromarray(edge, "RGBA").save(out / EDGE.format(k=k), optimize=True)
    Image.fromarray(dots(), "RGBA").save(out / DOTS, optimize=True)


if __name__ == "__main__":
    build()
    print(f"{DIR}: {FRAMES} кадров щели и краёв, растр")
