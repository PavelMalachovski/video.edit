"""Затемнение фона (`edit.dim`): фильтр ffmpeg по маске человека, маска по кадрам отрезков финала, кадр к вопросу.

Модель маски в большинстве тестов подменена: «маска» кадра — его средняя яркость, так по маске видно, какой кадр
исходника в неё попал. С настоящей моделью (RobustVideoMatting, ставит setup/cloud-setup.sh) — отдельный тест.
"""
import os
import shutil
import subprocess
import threading

import numpy as np
import pytest
from PIL import Image

from vm import matte
from vm.media import dim_filter
from vm.render import _cut, segment_frames
from vm.timeline import Timeline

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")


def yuv_frame(cmd_inputs: list[str], graph: str, w: int, h: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", *cmd_inputs, "-filter_complex", graph, "-map", "[v]",
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"],
        check=True, capture_output=True,
    ).stdout
    y = np.frombuffer(raw[: w * h], np.uint8).reshape(h, w).astype(int)
    u = np.frombuffer(raw[w * h : w * h + w * h // 4], np.uint8).reshape(h // 2, w // 2).astype(int)
    v = np.frombuffer(raw[w * h + w * h // 4 :], np.uint8).reshape(h // 2, w // 2).astype(int)
    return y, u, v


@needs_ffmpeg
def test_the_background_gets_darker_and_the_person_stays():
    """Маска 255 — человек: как был; 0 — фон: яркость и цвет × (1 − dim) в YUV исходника, без перевода цвета."""
    source = ["-f", "lavfi", "-i", "color=c=0xC8783C:s=64x64:r=30:d=0.2,format=yuv420p"]
    mask = ["-f", "lavfi", "-i", "nullsrc=s=32x32:r=30:d=0.2,geq=lum='if(lt(X,16),255,0)',format=gray"]  # слева — человек
    before = yuv_frame(source, "[0:v]null[v]", 64, 64)
    after = yuv_frame(source + mask, dim_filter("[0:v]", "[1:v]", 0.3, 64, 64, "[v]"), 64, 64)
    for plane, (b, a) in enumerate(zip(before, after, strict=True)):
        side = b.shape[1]
        person, background = slice(0, side * 3 // 8), slice(side * 5 // 8, side)  # без размытой маской границы
        assert np.abs(a[:, person] - b[:, person]).max() <= 1, plane
        mid = 16 if plane == 0 else 128
        expect = mid + (b[:, background] - mid) * 0.7
        assert np.abs(a[:, background] - expect).max() <= 2, plane


def test_matte_frames_are_the_frames_the_cut_takes():
    """Маска идёт кадр в кадр со склейкой: те же отрезки исходника в том же порядке (тизер — первым)."""
    tl = Timeline([(0.0, 1.0), (1.5, 2.2)], 1.1, teaser=(1.6, 2.0))
    frames = segment_frames(tl)
    assert frames == [(48, 60), (0, 30), (45, 66)]
    trims = [chain for chain in _cut(tl, False, [0, 2]) if "trim=start_frame" in chain]
    assert [chain.split("trim=start_frame=")[1].split(",")[0] for chain in trims] == [
        f"{a}:end_frame={b}" for a, b in frames
    ]


def test_the_teaser_is_read_by_its_own_decoder():
    """Тизер идёт первым, а лежит в исходнике дальше: из общего декодера его кадры пришлось бы ждать, держа в памяти
    все кадры до него. У тизера и у отрезков по порядку — разные входы (тот же файл ещё раз), каждый читает свои
    отрезки по возрастанию исходника."""
    tl = Timeline([(0.0, 1.0), (1.5, 2.2)], 1.1, teaser=(1.6, 2.0))
    chains = _cut(tl, True, [0, 2])
    assert chains[:4] == ["[0:v]split=1[sv0]", "[0:a]asplit=1[sa0]", "[2:v]split=2[sv1][sv2]", "[2:a]asplit=2[sa1][sa2]"]
    assert "[sv0]trim=start_frame=48:end_frame=60,setpts=PTS-STARTPTS[v0]" in chains
    assert any(c.startswith("[sa0]atrim=start_sample=76800:end_sample=96000,") for c in chains)
    plain = _cut(Timeline([(0.0, 1.0)], 1.0), True)  # без тизера — один вход, как всегда
    assert not any(c.startswith("[2:") for c in plain) and plain[0] == "[0:v]split=1[sv0]"
    only = _cut(Timeline([], 1.0, teaser=(1.0, 2.0)), True)  # отрезки keep выпали — ролик из тизера
    assert not any("split=0" in c for c in only), only


def count_video(path, seconds: float = 3.0):
    """Кадр n исходника — серый 2n в RGB без потерь (до 127 кадров): по маске видно, какой кадр в неё попал. Со звуком
    AAC, как source.mp4 после `vm prepare`: с ним ffmpeg при перемотке повторял первый кадр."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"color=c=black:s=64x112:r=30:d={seconds}", "-f", "lavfi", "-i", f"sine=f=440:r=48000:d={seconds}",
         "-vf", "format=rgb24,geq=r='2*N':g='2*N':b='2*N'", "-c:v", "libx264rgb", "-qp", "0", "-pix_fmt", "rgb24",
         "-c:a", "aac", "-shortest", "-video_track_timescale", "15360", str(path)],
        check=True,
    )
    return path


class Mean:
    """Подмена модели: маска — средняя яркость кадра; `resets` — сколько раз память модели начиналась заново.
    Счётчики — под замком: рендер зовёт модель из нескольких потоков."""

    def __init__(self):
        self.resets = 0
        self.frames = 0
        self.lock = threading.Lock()

    def __call__(self, rgb: np.ndarray, state):
        with self.lock:
            if state is None:
                self.resets += 1
            self.frames += 1
        return np.full(rgb.shape[:2], round(float(rgb.mean())), np.uint8), "state"


def read_gray(path, w: int, h: int) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w)


@needs_ffmpeg
def test_mattes_follow_the_cut_order_with_a_warm_up_before_each_piece(tmp_path):
    source = count_video(tmp_path / "count.mp4")
    plan = [(48, 60), (0, 30), (45, 66)]  # тизер 48–60, затем отрезки 0–30 и 45–66
    model = Mean()
    out = matte.write_mattes(source, plan, tmp_path / "matte.mkv", predict=model)
    shown = [round(v / 2) for v in read_gray(out, 32, 56).mean(axis=(1, 2))]
    assert shown == [*range(48, 60), *range(30), *range(45, 66)], "кадр маски = кадр склейки"
    assert model.resets == 3, "у каждого отрезка память модели с нуля — стыки бывают между разными планами"
    seen = sum(len(range(0, b - a, matte.STRIDE)) + ((b - a - 1) % matte.STRIDE != 0) for a, b in plan)
    assert model.frames == seen + 2 * matte.WARMUP, "разгон — кадры до отрезка (у начала файла их нет); модель видит каждый второй"


@needs_ffmpeg
def test_the_model_sees_every_other_frame_and_the_ones_between_are_blended(tmp_path):
    """Модель смотрит каждый второй кадр отрезка и его последний: маска между ними — среднее соседних (на настоящем
    ролике так отличается от полной у 0,8 % точек больше чем на 16 уровней из 255 — края на движении; при затемнении
    на 30 % это меньше 2 % яркости), а маска вдвое быстрее."""
    source = count_video(tmp_path / "count.mp4")
    calls = []

    def model(rgb, state):
        calls.append(round(float(rgb.mean()) / 2))
        return np.full(rgb.shape[:2], 10 * len(calls) % 250, np.uint8), "state"

    out = matte.write_mattes(source, [(20, 26)], tmp_path / "m.mkv", predict=model)
    assert calls == [*range(12, 20), 20, 22, 24, 25], "разгон — подряд; дальше 20, 22, 24 и последний 25"
    masks = [round(v) for v in read_gray(out, 32, 56).mean(axis=(1, 2))]
    assert masks == [90, 95, 100, 105, 110, 120], "кадры 21 и 23 — среднее соседних, 25 — посчитан"


@needs_ffmpeg
def test_the_frame_matte_is_for_the_very_frame_of_the_picture(tmp_path):
    """Картинка к вопросу берёт кадр по `-ss` с точностью до мс (`media.extract_frame`): 50/30 с → 1,667 → кадр 51.
    Маска — того же кадра, иначе на движении — кайма."""
    from vm.media import extract_frame

    source = count_video(tmp_path / "count.mp4")
    picture = np.asarray(Image.open(extract_frame(source, 50 / 30, tmp_path / "f.png")).convert("L")).mean()
    mask = np.asarray(Image.open(matte.frame_matte(source, 50 / 30, tmp_path / "m.png", predict=Mean())).convert("L")).mean()
    assert round(picture / 2) == round(mask / 2) == 51


@needs_ffmpeg
def test_a_frame_matte_for_the_question_picture_warms_up_on_the_frames_before(tmp_path):
    source = count_video(tmp_path / "count.mp4")
    model = Mean()
    out = matte.frame_matte(source, 2.0, tmp_path / "m.png", predict=model)
    value = float(np.asarray(Image.open(out).convert("L")).mean())
    assert round(value / 2) == 60, "маска кадра 2,0 с"
    assert model.frames == matte.WARMUP + 1


@needs_ffmpeg
def test_pieces_already_matted_are_not_matted_again(tmp_path, monkeypatch):
    """Маска хранится по отрезкам: версия B (без тизера) и правка без смены этих отрезков берут готовые куски."""
    from vm.job import Job
    from vm.render import _matte

    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    count_video(job.path("source.mp4"))
    model = Mean()
    monkeypatch.setattr(matte, "unavailable", lambda: None)
    monkeypatch.setattr(matte, "_rvm", lambda threads=None: model)
    with_teaser = Timeline([(0.0, 1.0), (1.5, 2.2)], 1.0, teaser=(1.6, 2.0))
    path_a, note = _matte(job, with_teaser)
    assert note is None
    done = model.frames
    path_b, _ = _matte(job, Timeline([(0.0, 1.0), (1.5, 2.2)], 1.0))
    assert model.frames == done, "все куски версии B уже посчитаны"
    assert path_a != path_b
    assert [round(v / 2) for v in read_gray(path_b, 32, 56).mean(axis=(1, 2))] == [*range(30), *range(45, 66)]
    assert [round(v / 2) for v in read_gray(path_a, 32, 56).mean(axis=(1, 2))] == [*range(48, 60), *range(30), *range(45, 66)]


@needs_ffmpeg
def test_pieces_are_matted_by_several_workers_each_with_its_own_model(tmp_path):
    """Отрезки считаются параллельно: у каждого потока — своя модель (своя сессия onnxruntime на свои ядра), а файл
    каждого отрезка — тот же, что посчитал бы один поток."""
    source = count_video(tmp_path / "count.mp4")
    units = [(0, 20), (20, 41), (45, 66), (70, 85)]
    made = []

    def models(threads):
        made.append(threads)
        return Mean()

    parts = [tmp_path / f"p{i}.mkv" for i in range(len(units))]
    matte.write_parts(source, list(zip(units, parts, strict=True)), workers=2, models=models)
    workers = min(2, os.cpu_count() or 1)
    assert made == [max(1, (os.cpu_count() or 1) // workers)] * workers, "по модели на поток, ядра — поровну"
    for (a, b), part in zip(units, parts, strict=True):
        alone = matte.write_mattes(source, [(a, b)], tmp_path / f"alone-{a}.mkv", predict=Mean())
        assert np.array_equal(read_gray(part, 32, 56), read_gray(alone, 32, 56)), f"кусок {a}–{b}"


def test_the_model_path_comes_from_matte_model_or_the_cache(monkeypatch, tmp_path):
    monkeypatch.delenv("MATTE_MODEL", raising=False)
    monkeypatch.setenv("VM_CACHE", str(tmp_path))
    assert matte.model_path() == tmp_path / matte.MODEL
    monkeypatch.setenv("MATTE_MODEL", str(tmp_path / "other.onnx"))
    assert matte.model_path() == tmp_path / "other.onnx"


def test_a_missing_or_broken_model_is_named_not_thrown(monkeypatch, tmp_path):
    monkeypatch.setenv("MATTE_MODEL", str(tmp_path / "nope.onnx"))
    assert "нет модели" in matte.unavailable()
    broken = tmp_path / "broken.onnx"
    broken.write_bytes(b"not a model")
    monkeypatch.setenv("MATTE_MODEL", str(broken))
    assert "не открывается" in matte.unavailable()


class Boom(Exception):
    """Как InvalidProtobuf onnxruntime: не RuntimeError."""


@needs_ffmpeg
def test_a_failing_matte_leaves_the_video_undimmed_with_a_note(tmp_path, monkeypatch):
    from vm.job import Job
    from vm.render import _matte

    job = Job(tmp_path / "jobs" / "abc")
    job.root.mkdir(parents=True)
    count_video(job.path("source.mp4"))
    monkeypatch.setattr(matte, "unavailable", lambda: None)

    def fail(*args, **kwargs):
        raise Boom("модель сломалась")

    monkeypatch.setattr(matte, "write_mattes", fail)
    path, note = _matte(job, Timeline([(0.0, 1.0)], 1.0))
    assert path is None and note.startswith("затемнение фона: не получилось") and "модель сломалась" in note


needs_model = pytest.mark.skipif(not matte.model_path().is_file(), reason="нет модели RobustVideoMatting (setup/cloud-setup.sh)")


@needs_ffmpeg
@needs_model
def test_the_real_model_gives_a_half_size_matte_per_frame(tmp_path):
    """Настоящая модель (onnxruntime): маска на каждый кадр плана, вдвое меньше кадра."""
    source = tmp_path / "pattern.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=1",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source)],
        check=True,
    )
    out = matte.write_mattes(source, [(0, 12)], tmp_path / "matte.mkv")
    assert read_gray(out, 540, 960).shape == (12, 960, 540)
