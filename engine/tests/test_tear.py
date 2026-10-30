"""Рваная бумага (переход `tear`): кадры щели и краёв бумаги в template/tear/ — их берут и рендер, и плеер редактора."""
from itertools import pairwise

import numpy as np
from PIL import Image

from vm import tear


def test_the_slit_opens_frame_by_frame_down_the_whole_frame(tmp_path):
    tear.build(tmp_path)
    widths = []
    for k in range(tear.FRAMES):
        with Image.open(tmp_path / tear.SLIT.format(k=k)) as im:
            assert im.size == (1080, 1920) and im.mode == "RGBA"
            a = np.asarray(im)[..., 3] > 127  # щель — непрозрачное: маску по прозрачности читают CSS и ffmpeg
        rows = a.sum(axis=1)
        assert rows.min() > 0, f"кадр {k}: щель — через весь кадр сверху донизу"
        widths.append(rows.mean())
    assert all(b > a for a, b in pairwise(widths)), widths
    assert widths[0] < 30 and widths[-1] > 300, "сначала трещина, в конце — широкая щель"


def test_the_paper_edges_are_white_and_hug_the_slit_from_outside(tmp_path):
    tear.build(tmp_path)
    k = tear.FRAMES - 1
    with Image.open(tmp_path / tear.EDGE.format(k=k)) as im:
        assert im.mode == "RGBA"
        edge = np.asarray(im)
    with Image.open(tmp_path / tear.SLIT.format(k=k)) as im:
        slit = np.asarray(im)[..., 3] > 127
    paper = edge[..., 3] > 200
    assert not (paper & slit).any(), "бумага — снаружи щели, в щели видна перебивка"
    assert edge[paper][:, :3].min() > 200, "края — белые, как у порванной бумаги"
    for y in (100, 960, 1800):  # у каждой стороны щели — полоса бумаги
        xs = np.nonzero(slit[y])[0]
        assert paper[y, xs.min() - 6] and paper[y, xs.max() + 6], y
    with Image.open(tmp_path / tear.EDGE.format(k=0)) as im:
        assert np.asarray(im)[..., 3][:, :400].max() == 0, "вдали от трещины — прозрачно"


def test_the_dots_screen_is_a_light_print_texture(tmp_path):
    tear.build(tmp_path)
    with Image.open(tmp_path / tear.DOTS) as im:
        dots = np.asarray(im)
    assert dots.shape == (1920, 1080, 4)
    alpha = dots[..., 3]
    assert 0.1 < (alpha > 0).mean() < 0.6 and dots[..., :3].max() < 60, "тёмные точки поверх серого кадра"


def test_the_files_in_the_template_are_what_build_makes(tmp_path):
    # картинки в template/tear/ собраны этим кодом: поменял геометрию — пересобери (python3 -m vm.tear)
    tear.build(tmp_path)
    for name in [*(tear.SLIT.format(k=k) for k in range(tear.FRAMES)), *(tear.EDGE.format(k=k) for k in range(tear.FRAMES)), tear.DOTS]:
        with Image.open(tmp_path / name) as a, Image.open(tear.DIR / name) as b:
            assert np.array_equal(np.asarray(a), np.asarray(b)), name
