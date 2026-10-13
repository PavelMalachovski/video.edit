"""Медиа-слой: probe, нормализация исходника, звук, кадры. Настоящий ffmpeg на коротких клипах из conftest.py.

Ожидаемое берётся из построения клипов (цвета, тоны, размеры, маркер в углу), а результат читается
мимо vm.media: напрямую ffprobe/ffmpeg и numpy. Так тест не сверяет проверяемый код с ним самим.
"""
import json
import struct
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile

from vm import media
from vm.media import (
    MediaError,
    contact_sheet,
    extract_frame,
    extract_wav,
    grid_frames,
    normalize,
    probe,
)

RED, GREEN, BLUE, BLACK = (255, 0, 0), (0, 255, 0), (0, 0, 255), (0, 0, 0)
# кодек и перевод yuv → rgb сдвигают цвет на единицы (красный выходит 254,0,0), а путаница матриц BT.601/709 — на 20–40:
# допуск такой, чтобы её было видно
COLOR_TOLERANCE = 10
FRAME = 1 / 30


# ---------- чтение результата мимо vm.media ----------


def ff(*args) -> bytes:
    done = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", *map(str, args)],
        check=True,
        capture_output=True,
    )
    return done.stdout


def ffprobe_json(path) -> dict:
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(done.stdout)


def stream_of(path, kind: str) -> dict:
    return next(s for s in ffprobe_json(path)["streams"] if s["codec_type"] == kind)


def region_pixels(path, *, t=0.0, x=0, y=0, w=None, h=None) -> np.ndarray:
    """Пиксели прямоугольника кадра в момент t (или всего кадра) как массив h×w×3 (RGB), цвета — как покажет плеер."""
    crop = f",crop={w}:{h}:{x}:{y}" if w else ""  # в RGB обрезать можно по любым координатам, в yuv420p — только по чётным
    raw = ff("-ss", t, "-i", path, "-frames:v", "1", "-vf", "format=rgb24" + crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "-")
    width = w or stream_of(path, "video")["width"]
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, width, 3)


def region_rgb(path, *, t=0.0, x=0, y=0, w=None, h=None) -> np.ndarray:
    """Средний цвет прямоугольника кадра: среднее считает numpy по точным пикселям (масштабирование ffmpeg до 1×1 врёт)."""
    return region_pixels(path, t=t, x=x, y=y, w=w, h=h).reshape(-1, 3).mean(axis=0)


def frame_colors(path) -> np.ndarray:
    """Цвет каждого кадра видео, как они лежат в файле: среднее по 16×16 пикселям в центре кадра 1080×1920 → массив n×3."""
    raw = ff(
        "-i", path, "-an", "-vf", "format=rgb24,crop=16:16:532:952", "-fps_mode", "passthrough",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
    )  # fmt: skip
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, 16 * 16, 3).mean(axis=1)


def audio_mono(path, rate: int = 48000) -> np.ndarray:
    raw = ff("-i", path, "-map", "0:a:0", "-ac", "1", "-ar", rate, "-f", "f32le", "-")
    return np.frombuffer(raw, dtype="<f4")


def dominant_hz(samples: np.ndarray, rate: int) -> float:
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    return float(np.argmax(spectrum) * rate / len(samples))


def tone_switch_time(samples: np.ndarray, rate: int = 48000, threshold_hz: float = 660) -> float:
    """Когда звук переходит с низкого тона (440) на высокий (880): окна 10 мс с шагом 5 мс, время — центр окна."""
    window, hop = rate // 100, rate // 200
    for start in range(0, len(samples) - window, hop):
        if dominant_hz(samples[start : start + window], rate) > threshold_hz:
            return (start + window / 2) / rate
    raise AssertionError("audio never switches to the higher tone")


def png_size(path) -> tuple[int, int]:
    head = Path(path).read_bytes()[:24]
    assert head[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    return struct.unpack(">II", head[16:24])


# ---------- probe ----------


def test_probe_applies_rotation(vertical_rot90):
    p = probe(vertical_rot90)
    assert (p.width, p.height) == (1080, 1920)
    assert abs(p.rotation) == 90


@pytest.mark.parametrize(
    "degrees, size, turn",
    [
        (90, (1080, 1920), 90),
        (-90, (1080, 1920), 90),  # так iPhone пишет вертикальное видео
        (270, (1080, 1920), 90),
        (180, (1920, 1080), 180),  # перевёрнуто, но не боком: ширина и высота не меняются
    ],
)
def test_probe_swaps_size_only_for_quarter_turns(rotated, degrees, size, turn):
    p = probe(rotated(degrees))
    assert (p.width, p.height) == size
    assert abs(p.rotation) == turn


def test_probe_leaves_an_unrotated_clip_alone(landscape):
    p = probe(landscape)
    assert (p.width, p.height, p.rotation) == (1920, 1080, 0)


def test_probe_reports_fps_and_duration(part_a, part_b, silent):
    assert [probe(p).fps for p in (part_a, part_b, silent)] == pytest.approx([30, 60, 25])
    assert [probe(p).duration for p in (part_a, part_b, silent)] == pytest.approx([2.5, 2.0, 1.2], abs=0.05)


def test_probe_reports_audio_presence(part_a, silent):
    assert probe(part_a).has_audio is True
    assert probe(silent).has_audio is False


def test_probe_detects_hdr(hlg, part_a):
    p = probe(hlg)
    assert p.hdr is True
    assert p.color_transfer == "arib-std-b67"
    assert probe(part_a).hdr is False


def test_probe_detects_pq_as_hdr(pq):
    p = probe(pq)
    assert p.hdr is True
    assert p.color_transfer == "smpte2084"


def iphone_json(*, transfer, dolby_vision):
    """ffprobe -show_streams -show_format для вертикального 4K60 с iPhone: кадр лежит боком, поворот в Display Matrix."""
    side_data = [
        {
            "side_data_type": "Display Matrix",
            "displaymatrix": "\n00000000:            0       65536           0\n"
            "00000001:       -65536           0           0\n00000002:            0           0  1073741824\n",
            "rotation": -90,
        }
    ]
    if dolby_vision:
        side_data.append(
            {
                "side_data_type": "DOVI configuration record",
                "dv_version_major": 1,
                "dv_version_minor": 0,
                "dv_profile": 8,
                "dv_level": 12,
                "rpu_present_flag": 1,
                "el_present_flag": 0,
                "bl_present_flag": 1,
                "dv_bl_signal_compatibility_id": 4,
            }
        )
    video = {
        "index": 0,
        "codec_name": "hevc",
        "codec_type": "video",
        "width": 3840,
        "height": 2160,
        "pix_fmt": "yuv420p10le",
        "color_range": "tv",
        "color_space": "bt2020nc",
        "color_primaries": "bt2020",
        "r_frame_rate": "60/1",
        "avg_frame_rate": "60/1",
        "duration": "12.500000",
        "disposition": {"default": 1, "attached_pic": 0},
        "side_data_list": side_data,
    }
    if transfer:
        video["color_transfer"] = transfer
    audio = {
        "index": 1,
        "codec_name": "aac",
        "codec_type": "audio",
        "sample_rate": "48000",
        "channels": 2,
        "r_frame_rate": "0/0",
        "avg_frame_rate": "0/0",
        "duration": "12.480000",
        "disposition": {"default": 1, "attached_pic": 0},
    }
    return {"streams": [video, audio], "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "12.500000"}}


def test_probe_reads_an_iphone_style_clip(monkeypatch):
    monkeypatch.setattr(media, "_ffprobe", lambda path: iphone_json(transfer="arib-std-b67", dolby_vision=True))
    p = probe("IMG_0001.MOV")
    assert (p.width, p.height) == (2160, 3840)  # лежит 3840×2160, показывается вертикально
    assert p.rotation == -90
    assert p.fps == 60
    assert p.duration == 12.5
    assert (p.hdr, p.has_audio, p.color_transfer) == (True, True, "arib-std-b67")


@pytest.mark.parametrize(
    "transfer, dolby_vision, hdr",
    [
        (None, True, True),  # кривая в потоке не помечена, но есть Dolby Vision — всё равно HDR
        (None, False, False),  # ни кривой, ни Dolby Vision — SDR
    ],
)
def test_probe_detects_dolby_vision_by_side_data(monkeypatch, transfer, dolby_vision, hdr):
    monkeypatch.setattr(media, "_ffprobe", lambda path: iphone_json(transfer=transfer, dolby_vision=dolby_vision))
    assert probe("IMG_0001.MOV").hdr is hdr


def test_probe_video_stream_without_a_frame_size_raises_media_error(monkeypatch):
    data = iphone_json(transfer="arib-std-b67", dolby_vision=False)
    del data["streams"][0]["width"]  # так выглядит дорожка, которую ffprobe открыл, но не расшифровал
    monkeypatch.setattr(media, "_ffprobe", lambda path: data)
    with pytest.raises(MediaError, match="frame size"):
        probe("IMG_0001.MOV")


def test_missing_ffmpeg_raises_media_error_that_says_so(tmp_path, monkeypatch, part_a):
    monkeypatch.setenv("PATH", str(tmp_path))  # в PATH пусто: ffprobe не найти
    with pytest.raises(MediaError, match="ffprobe not found"):
        probe(part_a)


def test_probe_missing_file_raises_media_error(tmp_path):
    with pytest.raises(MediaError, match="No such file"):
        probe(tmp_path / "nope.mp4")


def test_probe_unreadable_file_raises_media_error_with_the_reason(tmp_path):
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"this is not a video")
    with pytest.raises(MediaError, match="Invalid data"):
        probe(broken)


def test_probe_does_not_take_cover_art_for_video(tmp_path, part_a):
    cover = tmp_path / "cover.png"
    ff("-f", "lavfi", "-i", "color=c=green:s=64x64", "-frames:v", "1", cover)
    song = tmp_path / "song.m4a"
    ff("-i", part_a, "-i", cover, "-map", "0:a", "-map", "1", "-c", "copy", "-disposition:v:0", "attached_pic", song)
    assert any(s["codec_type"] == "video" for s in ffprobe_json(song)["streams"])  # ffprobe обложку видит как видеодорожку
    with pytest.raises(MediaError, match="no video stream"):
        probe(song)


def test_probe_file_without_video_raises_media_error(tmp_path, part_a):
    wav = tmp_path / "audio.wav"
    ff("-i", part_a, "-vn", wav)
    with pytest.raises(MediaError, match="no video stream"):
        probe(wav)


# ---------- normalize ----------


@pytest.fixture(scope="module")
def mixed(tmp_path_factory, part_a, part_b):
    """Две части с разным размером, частотой кадров и звуком, склеенные в папку, которой ещё нет."""
    out = tmp_path_factory.mktemp("mixed") / "work" / "source.mp4"
    return out, normalize([part_a, part_b], out)


def test_normalize_concat_mixed_parts(mixed):
    out, result = mixed
    assert result.duration == pytest.approx(2.5 + 2.0, abs=0.1)
    assert (result.width, result.height) == (1080, 1920)
    assert result.fps == pytest.approx(30)
    video, audio = stream_of(out, "video"), stream_of(out, "audio")
    assert (video["r_frame_rate"], video["avg_frame_rate"]) == ("30/1", "30/1")  # постоянная частота, не «в среднем»
    assert int(video["nb_frames"]) == 75 + 60  # 2,5 с × 30 + 2 с × 60 → 30
    assert abs(float(video["duration"]) - float(audio["duration"])) <= FRAME  # рассинхрон не больше кадра
    assert (audio["sample_rate"], audio["channels"]) == ("48000", 2)


def test_normalize_encodes_the_intermediate_fast(mixed):
    # промежуточный файл пересобирается в каждой сессии (в git его нет): ultrafast — на 30 % быстрее veryfast на 4K
    # с iPhone (половина времени — декодирование HEVC), а качество держит crf 16
    out, _ = mixed
    head = out.read_bytes()[: 1 << 20]
    assert b"cabac=0" in head and b"crf=16.0" in head, "x264 options of the intermediate"


def test_normalize_keeps_parts_in_order_and_in_sync(mixed):
    out, _ = mixed
    frames = frame_colors(out)
    assert frames[10] == pytest.approx(RED, abs=COLOR_TOLERANCE)  # часть 1 — первой
    assert frames[100] == pytest.approx(BLUE, abs=COLOR_TOLERANCE)  # часть 2 — второй
    samples = audio_mono(out)
    assert dominant_hz(samples[48000 : 48000 + 4800], 48000) == pytest.approx(440, abs=15)  # звук 1,0–1,1 с — часть 1
    assert dominant_hz(samples[3 * 48000 : 3 * 48000 + 4800], 48000) == pytest.approx(880, abs=15)  # 3,0–3,1 с — часть 2
    # на стыке (2,5 с) картинка и звук переключаются вместе; точность замера звука — десятки миллисекунд (кадр AAC 21 мс)
    video_switch = int(np.argmax(frames[:, 2] > frames[:, 0])) / 30
    assert video_switch == pytest.approx(2.5, abs=FRAME)
    assert tone_switch_time(samples) == pytest.approx(video_switch, abs=2 * FRAME)


def test_normalize_leaves_only_the_result_in_its_folder(mixed):
    out, _ = mixed
    assert [p.name for p in out.parent.iterdir()] == ["source.mp4"]


def test_normalize_drops_global_metadata(mixed, part_a):
    out, _ = mixed
    assert "location" in ffprobe_json(part_a)["format"]["tags"]  # в исходнике место съёмки есть
    tags = ffprobe_json(out)["format"].get("tags", {})
    assert not {"location", "title"} & set(tags)  # в исходник для рендера оно не переходит


@pytest.fixture(scope="module")
def hdr_out(tmp_path_factory, hlg):
    out = tmp_path_factory.mktemp("hdr") / "source.mp4"
    return out, normalize([hlg], out)


def test_normalize_hdr_to_sdr(hdr_out):
    out, result = hdr_out
    assert result.color_transfer == "bt709"
    assert result.hdr is False
    video = stream_of(out, "video")
    assert (video["color_primaries"], video["color_space"], video["pix_fmt"]) == ("bt709", "bt709", "yuv420p")


def test_normalize_hdr_converts_colors_instead_of_relabeling(hdr_out, hlg_sdr_source):
    out, _ = hdr_out
    reference = region_rgb(hlg_sdr_source, t=1.0).mean()  # картинка, из которой сделан HLG
    # просто сменить метку нельзя: HLG, показанный как BT.709, темнее оригинала примерно на пятую часть
    assert region_rgb(out, t=1.0).mean() == pytest.approx(reference, rel=0.05)


def test_normalize_tags_sdr_without_color_tags_as_bt709(tmp_path, silent):
    out = tmp_path / "source.mp4"
    assert "color_space" not in stream_of(silent, "video")  # в исходнике меток цвета нет, а у результата они обязаны быть
    normalize([silent], out)
    video = stream_of(out, "video")
    assert (video["color_primaries"], video["color_transfer"], video["color_space"]) == ("bt709", "bt709", "bt709")


def test_normalize_converts_only_the_hdr_part_of_mixed_parts(tmp_path, part_a, hlg, hlg_sdr_source):
    out = tmp_path / "source.mp4"
    normalize([part_a, hlg], out)  # SDR первой, HDR второй: решает каждая часть сама за себя
    assert region_rgb(out, t=1.0) == pytest.approx(RED, abs=COLOR_TOLERANCE)  # SDR-часть не тронута
    reference = region_rgb(hlg_sdr_source, t=1.0).mean()
    assert region_rgb(out, t=2.5 + 1.0).mean() == pytest.approx(reference, rel=0.05)  # HDR-часть переведена


def test_normalize_applies_display_rotation(tmp_path, vertical_rot90):
    out = tmp_path / "source.mp4"
    result = normalize([vertical_rot90], out)
    assert (result.width, result.height, result.rotation) == (1080, 1920, 0)  # метки поворота в результате нет
    # красный квадрат лежал в левом верхнем углу кадра; поворот показа на 90° против часовой уводит его в левый нижний
    assert region_rgb(out, t=1.0, x=20, y=1640, w=260, h=260) == pytest.approx(RED, abs=COLOR_TOLERANCE)
    assert region_rgb(out, t=1.0, x=20, y=20, w=260, h=260) == pytest.approx(BLACK, abs=COLOR_TOLERANCE)
    assert region_rgb(out, t=1.0, x=800, y=20, w=260, h=260) == pytest.approx(BLACK, abs=COLOR_TOLERANCE)


def test_normalize_rotates_a_later_part_too(tmp_path, part_a, vertical_rot90):
    out = tmp_path / "source.mp4"
    result = normalize([part_a, vertical_rot90], out)
    assert (result.width, result.height) == (1080, 1920)
    t = 2.5 + 1.0  # вторая часть лежит боком: если бы её приняли за горизонтальную, квадрат вышел бы мельче и не в углу
    assert region_rgb(out, t=t, x=20, y=1640, w=260, h=260) == pytest.approx(RED, abs=COLOR_TOLERANCE)
    assert region_rgb(out, t=t, x=20, y=20, w=260, h=260) == pytest.approx(BLACK, abs=COLOR_TOLERANCE)


def test_normalize_keeps_the_aspect_of_a_non_vertical_clip(tmp_path, landscape):
    out = tmp_path / "source.mp4"
    result = normalize([landscape], out)
    assert result.width == 1080
    assert result.height % 2 == 0
    assert result.height / result.width == pytest.approx(1080 / 1920, abs=0.005)  # без растяжения
    # и без чёрной каёмки от округления высоты (1080×607,5): красный квадрат начинается с самой первой строки
    assert region_rgb(out, t=1.0, x=10, y=0, w=100, h=1) == pytest.approx(RED, abs=COLOR_TOLERANCE)


def test_normalize_keeps_the_aspect_of_a_vertical_clip_that_is_not_9_by_16(tmp_path, portrait_4x3):
    result = normalize([portrait_4x3], tmp_path / "source.mp4")
    assert (result.width, result.height) == (1080, 1440)  # не растянуто до 1920: поля заливает render, а не растяжение


def test_normalize_fits_a_differently_shaped_part_into_the_first_parts_frame(tmp_path, part_a, landscape):
    out = tmp_path / "source.mp4"
    result = normalize([part_a, landscape], out)
    assert (result.width, result.height) == (1080, 1920)
    t = 2.5 + 1.0  # вторая часть, 1920×1080, вписана по ширине: полоса 1080×608 по центру (y 656–1264)
    assert region_rgb(out, t=t, x=10, y=670, w=140, h=140) == pytest.approx(RED, abs=COLOR_TOLERANCE)  # квадрат 300 → 169 px
    assert region_rgb(out, t=t, x=0, y=0, w=1080, h=600) == pytest.approx(BLACK, abs=COLOR_TOLERANCE)  # поля чёрные,
    assert region_rgb(out, t=t, x=0, y=1300, w=1080, h=600) == pytest.approx(BLACK, abs=COLOR_TOLERANCE)  # не растяжение


def test_normalize_gives_a_part_without_audio_silence(tmp_path, part_a, silent):
    out = tmp_path / "source.mp4"
    result = normalize([part_a, silent], out)
    video, audio = stream_of(out, "video"), stream_of(out, "audio")
    assert result.has_audio is True
    assert result.duration == pytest.approx(2.5 + 1.2, abs=0.1)
    assert int(video["nb_frames"]) == 75 + 36  # 1,2 с при 25 к/с → 36 кадров при 30
    assert abs(float(video["duration"]) - float(audio["duration"])) <= FRAME
    samples = audio_mono(out)
    assert np.abs(samples[: int(2.4 * 48000)]).max() > 0.05  # звук части 1 на месте (синус ffmpeg — амплитуда 0,125)
    assert np.abs(samples[int(2.6 * 48000) :]).max() < 1e-3  # на месте части без звука — тишина


def test_normalize_trims_audio_that_outlasts_its_video(tmp_path, long_audio, part_b):
    out = tmp_path / "source.mp4"
    result = normalize([long_audio, part_b], out)  # у первой части звук на 0,4 с длиннее картинки
    video, audio = stream_of(out, "video"), stream_of(out, "audio")
    assert result.duration == pytest.approx(2.0 + 2.0, abs=0.1)  # лишний звук не сдвигает вторую часть
    assert abs(float(video["duration"]) - float(audio["duration"])) <= FRAME
    frames = frame_colors(out)
    assert int(np.argmax(frames[:, 2] > frames[:, 0])) == pytest.approx(60, abs=1)  # синий — с 2,0 с (кадр 60)
    assert tone_switch_time(audio_mono(out)) == pytest.approx(2.0, abs=2 * FRAME)  # и звук второй части — тоже


def test_normalize_pads_audio_that_ends_before_its_video(tmp_path, part_b, short_audio):
    out = tmp_path / "source.mp4"
    result = normalize([part_b, short_audio], out)  # у последней части звук кончается на 0,5 с раньше картинки
    video, audio = stream_of(out, "video"), stream_of(out, "audio")
    assert result.duration == pytest.approx(2.0 + 2.0, abs=0.1)
    assert abs(float(video["duration"]) - float(audio["duration"])) <= FRAME  # звук дотянут тишиной до конца картинки
    samples = audio_mono(out)
    assert np.abs(samples[int(2.1 * 48000) : int(3.4 * 48000)]).max() > 0.05  # звук части на месте
    assert np.abs(samples[int(3.6 * 48000) :]).max() < 1e-3  # а после него — тишина


@pytest.fixture(scope="module")
def voice_long(tmp_path_factory) -> Path:
    """Озвучка 3,5 с: 700 Гц моно 44,1 кГц, M4A — длиннее части 1 (2,5 с)."""
    path = tmp_path_factory.mktemp("voice") / "voice.m4a"
    ff("-f", "lavfi", "-i", "sine=frequency=700:sample_rate=44100:duration=3.5", "-c:a", "aac", "-ac", "1", path)
    return path


def test_normalize_puts_the_voiceover_instead_of_the_video_sound_and_holds_the_last_frame(tmp_path, part_a, voice_long):
    out = tmp_path / "source.mp4"
    result = normalize([part_a], out, voice=voice_long)
    video, audio = stream_of(out, "video"), stream_of(out, "audio")
    assert result.duration == pytest.approx(3.5, abs=0.1)
    assert abs(float(video["duration"]) - float(audio["duration"])) <= FRAME
    assert audio["channels"] == 2 and int(audio["sample_rate"]) == 48000
    samples = audio_mono(out)
    assert dominant_hz(samples[48000 : 48000 + 4800], 48000) == pytest.approx(700, abs=15), "звук — озвучка, а не 440 Гц видео"
    assert dominant_hz(samples[3 * 48000 : 3 * 48000 + 4800], 48000) == pytest.approx(700, abs=15), "и после конца видео"
    frames = frame_colors(out)
    assert len(frames) == pytest.approx(105, abs=1) and frames[-1] == pytest.approx(RED, abs=COLOR_TOLERANCE), "последний кадр держится"


def test_normalize_cuts_the_video_to_a_shorter_voiceover(tmp_path, colors):
    voice = tmp_path / "short.wav"
    ff("-f", "lavfi", "-i", "sine=frequency=700:sample_rate=48000:duration=1.5", "-c:a", "pcm_s16le", voice)
    result = normalize([colors], tmp_path / "source.mp4", voice=voice)
    assert result.duration == pytest.approx(1.5, abs=0.1)
    frames = frame_colors(tmp_path / "source.mp4")
    assert len(frames) == pytest.approx(45, abs=1) and frames[-1] == pytest.approx(GREEN, abs=COLOR_TOLERANCE)


def test_a_raw_aac_voiceover_is_measured_by_its_sound_not_by_a_guess(tmp_path):
    """У сырого AAC (ADTS) длину ffprobe угадывает по битрейту — на 20 с ошибается на четверть секунды: конец записи
    обрезался бы. Длина озвучки — по самому звуку."""
    voice = tmp_path / "voice.aac"
    ff("-f", "lavfi", "-i", "anoisesrc=d=20:c=pink:a=0.5", "-f", "lavfi", "-i", "sine=f=300:d=20", "-filter_complex",
       "[0][1]amix=inputs=2,volume='if(lt(mod(t,4),2),1,0.05)':eval=frame", "-c:a", "aac", "-b:a", "96k", voice)
    assert media.voice_seconds(voice) == pytest.approx(20.0, abs=0.05)  # +21 мс приминга кодера — тоже звук файла


def test_normalize_rejects_a_voiceover_without_sound(tmp_path, part_a, silent):
    with pytest.raises(MediaError, match="в записи нет звука"):
        normalize([part_a], tmp_path / "source.mp4", voice=silent)
    assert not (tmp_path / "source.mp4").exists()


def test_normalize_rejects_no_parts(tmp_path):
    with pytest.raises(ValueError, match="no parts"):
        normalize([], tmp_path / "source.mp4")


def test_normalize_rejects_a_part_without_duration(tmp_path):
    still = tmp_path / "still.png"
    ff("-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", still)
    with pytest.raises(MediaError, match="duration"):
        normalize([still], tmp_path / "source.mp4")
    assert not (tmp_path / "source.mp4").exists()


def test_normalize_failure_carries_the_ffmpeg_reason_and_leaves_nothing(tmp_path, part_a):
    out = tmp_path / "result" / "source.unknown"  # ffprobe части прочтёт, а ffmpeg выходной формат не выберет
    with pytest.raises(MediaError, match="output format"):
        normalize([part_a], out)
    assert [p for p in tmp_path.rglob("*") if p.is_file()] == []  # ни результата, ни временных обломков


def test_a_run_that_dies_midway_keeps_the_previous_result_and_leaves_no_partial_file(tmp_path, monkeypatch, part_a):
    out = tmp_path / "source.wav"
    out.write_bytes(b"result of the previous run")

    def dies_midway(*args):  # ffmpeg пишет в последний аргумент и падает, не закончив
        Path(args[-1]).write_bytes(b"half a file")
        raise MediaError("ffmpeg failed (exit 1): killed")

    monkeypatch.setattr(media, "_ffmpeg", dies_midway)
    with pytest.raises(MediaError, match="killed"):
        extract_wav(part_a, out)
    assert out.read_bytes() == b"result of the previous run"
    assert [p.name for p in tmp_path.iterdir()] == ["source.wav"]


# ---------- extract_frame ----------


@pytest.mark.parametrize("t, color", [(0.5, RED), (1.5, GREEN), (2.5, BLUE)])
def test_extract_frame_returns_the_frame_at_t(tmp_path, colors, t, color):
    path = extract_frame(colors, t, tmp_path / "frame.png")
    assert path == tmp_path / "frame.png"
    assert png_size(path) == (1080, 1920)
    assert region_rgb(path) == pytest.approx(color, abs=COLOR_TOLERANCE)


@pytest.mark.parametrize("t", [2.99, 3.0])  # последний кадр начинается в 2,967 с, клип кончается в 3,0
def test_extract_frame_in_the_last_frame_interval_returns_the_last_frame(tmp_path, colors, t):
    path = extract_frame(colors, t, tmp_path / "frame.png")
    assert region_rgb(path) == pytest.approx(BLUE, abs=COLOR_TOLERANCE)


def test_extract_frame_past_the_end_raises_and_writes_nothing(tmp_path, colors):
    with pytest.raises(MediaError, match=r"3\.5"):
        extract_frame(colors, 3.5, tmp_path / "frame.png")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("bad", [-1, float("nan"), float("inf")])
def test_extract_frame_rejects_a_time_that_is_not_a_position_in_the_clip(tmp_path, colors, bad):
    with pytest.raises(ValueError, match="time"):
        extract_frame(colors, bad, tmp_path / "frame.png")


# ---------- extract_wav ----------


def test_extract_wav_is_mono_pcm_at_16k_by_default(tmp_path, part_a):
    path = extract_wav(part_a, tmp_path / "source.wav")
    info = soundfile.info(path)
    assert (info.samplerate, info.channels, info.subtype) == (16000, 1, "PCM_16")
    assert info.duration == pytest.approx(2.5, abs=0.05)
    data, rate = soundfile.read(path)
    assert dominant_hz(data, rate) == pytest.approx(440, abs=5)  # звук не испорчен


def test_extract_wav_resamples_to_the_given_rate(tmp_path, part_b):
    path = extract_wav(part_b, tmp_path / "source.wav", rate=8000)  # в части 44,1 кГц моно
    info = soundfile.info(path)
    assert (info.samplerate, info.channels) == (8000, 1)
    data, rate = soundfile.read(path)
    assert dominant_hz(data, rate) == pytest.approx(880, abs=5)


def test_extract_wav_of_a_clip_without_audio_raises_and_writes_nothing(tmp_path, silent):
    with pytest.raises(MediaError):
        extract_wav(silent, tmp_path / "source.wav")
    assert list(tmp_path.iterdir()) == []


# ---------- смены сцены ----------


def test_scene_cuts_are_the_hard_cuts_of_the_clip(colors, hlg_sdr_source):
    assert media.scene_cuts(colors) == [pytest.approx(1.0, abs=FRAME), pytest.approx(2.0, abs=FRAME)]
    assert media.scene_cuts(hlg_sdr_source) == [], "движение в одном плане — не смена сцены"


def test_a_flash_is_one_scene_change_not_two(tmp_path):
    clip = tmp_path / "flash.mp4"  # красный, кадр белого на 1 с (вспышка), снова красный, на 2 с — синий
    ff("-f", "lavfi", "-i", "color=c=0xFF0000:s=270x480:r=30:d=3,format=rgb24", "-vf",
       "drawbox=c=white:t=fill:enable='between(n,30,30)',drawbox=c=blue:t=fill:enable='gte(n,60)',format=yuv420p",
       "-c:v", "libx264", "-preset", "ultrafast", clip)
    assert media.scene_cuts(clip) == [pytest.approx(1.0, abs=FRAME), pytest.approx(2.0, abs=FRAME)]


# ---------- contact_sheet ----------


def test_contact_sheet_tiles_thumbnails_in_time_order(tmp_path, colors):
    out = contact_sheet(colors, tmp_path / "sheet.png", fps=2, cols=3)
    assert out == tmp_path / "sheet.png"
    # 6 кадров (0; 0,5; … 2,5 с) по 180×320: 3 колонки и ровно 2 ряда, лишнего пустого ряда нет
    assert png_size(out) == (540, 640)
    expected = [[RED, RED, GREEN], [GREEN, BLUE, BLUE]]
    for row in range(2):
        for col in range(3):
            cell = region_rgb(out, x=col * 180 + 60, y=row * 320 + 120, w=60, h=100)  # середина ячейки, мимо подписи
            assert cell == pytest.approx(expected[row][col], abs=COLOR_TOLERANCE), (row, col)


def test_contact_sheet_thumbnails_carry_a_time_label(tmp_path, colors):
    out = contact_sheet(colors, tmp_path / "sheet.png", fps=2, cols=3)
    label_0 = region_pixels(out, x=0, y=0, w=70, h=34)  # ячейка с t = 0,0 с
    label_1 = region_pixels(out, x=180, y=0, w=70, h=34)  # ячейка с t = 0,5 с: тот же красный кадр, другое время
    assert np.abs(label_0.astype(int) - RED).max() > 100  # подпись нарисована поверх красного
    assert not np.array_equal(label_0, label_1)  # и зависит от времени


def test_contact_sheet_keeps_a_frame_for_a_short_clip_at_low_fps(tmp_path, silent):
    out = contact_sheet(silent, tmp_path / "sheet.png", fps=0.2)  # клип 1,2 с, снимок раз в 5 с: один кадр, а не пусто
    assert png_size(out) == (1080, 320)


@pytest.mark.parametrize("fps, cols", [(0, 6), (-1, 6), (1, 0)])
def test_contact_sheet_rejects_nonpositive_fps_and_cols(tmp_path, colors, fps, cols):
    with pytest.raises(ValueError):
        contact_sheet(colors, tmp_path / "sheet.png", fps=fps, cols=cols)


# ---------- grid_frames ----------


def test_grid_frames_count_and_size(tmp_path, colors):
    out_dir = tmp_path / "look"
    paths = grid_frames(colors, [0.5, 1.5, 2.5], out_dir)
    assert len(paths) == 3 and len(set(paths)) == 3
    assert all(p.parent == out_dir and p.exists() for p in paths)
    assert [png_size(p) for p in paths] == [(1080, 1920)] * 3
    # кадры — те, что просили, в том же порядке (середина ячейки сетки, вдали от линий и подписи)
    for path, color in zip(paths, [RED, GREEN, BLUE]):
        assert region_rgb(path, x=340, y=600, w=60, h=100) == pytest.approx(color, abs=COLOR_TOLERANCE)


def test_grid_frames_draw_a_108_by_192_grid(tmp_path, colors):
    [path] = grid_frames(colors, [0.5], tmp_path)  # красная секунда: линии видны на однотонном фоне
    frame = region_pixels(path).astype(float)  # 1920×1080×3, считаем срезами
    red = np.array(RED)

    def mean(rows, cols):
        return frame[rows, cols].reshape(-1, 3).mean(axis=0)

    for k in range(1, 10):
        # вертикальная линия на x = 108·k, ниже подписи; середина ячейки шириной 108 — чистый красный
        assert mean(slice(300, 310), slice(108 * k - 3, 108 * k + 3))[1] > 40, f"column line {k}"
        assert mean(slice(300, 310), slice(108 * k - 74, 108 * k - 34)) == pytest.approx(red, abs=COLOR_TOLERANCE)
        # горизонтальная — на y = 192·k, правее подписи; середина ячейки высотой 192 — чистый красный
        assert mean(slice(192 * k - 3, 192 * k + 3), slice(500, 510))[1] > 40, f"row line {k}"
        assert mean(slice(192 * k - 116, 192 * k - 76), slice(500, 510)) == pytest.approx(red, abs=COLOR_TOLERANCE)


def test_grid_frames_label_shows_the_requested_time(tmp_path, colors):
    first, second = grid_frames(colors, [0.5, 0.6], tmp_path)  # оба в красной секунде: различаться могут только подписью
    label_1 = region_pixels(first, x=0, y=0, w=300, h=100)
    label_2 = region_pixels(second, x=0, y=0, w=300, h=100)
    assert np.abs(label_1.astype(int) - RED).max() > 100  # подпись нарисована
    assert not np.array_equal(label_1, label_2)  # и зависит от времени


def test_grid_frames_at_the_very_end_still_get_grid_and_label(tmp_path, colors):
    [path] = grid_frames(colors, [3.0], tmp_path)  # последний кадр — другой путь извлечения, чем у прочих
    assert region_rgb(path, x=340, y=600, w=60, h=100) == pytest.approx(BLUE, abs=COLOR_TOLERANCE)
    assert region_rgb(path, x=108 - 3, y=300, w=6, h=10)[0] > 40  # линия сетки: на синем у неё красная составляющая
    assert np.abs(region_pixels(path, x=0, y=0, w=300, h=100).astype(int) - BLUE).max() > 100  # подпись


# ---------- громкость исходника (тихая запись → шумоподавление) ----------


def test_loudness_reads_integrated_lufs_and_none_without_sound(tmp_path):
    loud, quiet, mute = tmp_path / "loud.wav", tmp_path / "quiet.wav", tmp_path / "mute.mp4"
    ff("-f", "lavfi", "-i", "sine=f=1000:r=48000", "-t", "4", "-ac", "1", loud)
    ff("-f", "lavfi", "-i", "sine=f=1000:r=48000,volume=-20dB", "-t", "4", "-ac", "1", quiet)
    ff("-f", "lavfi", "-i", "color=c=gray:s=64x64:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", mute)
    a, b = media.loudness(loud), media.loudness(quiet)
    assert a == pytest.approx(-21.0, abs=1.5), a  # синус lavfi — амплитуда 1/8
    assert a - b == pytest.approx(20.0, abs=0.5)
    assert media.loudness(mute) is None


# ---------- коробки MP4 ----------


def test_mp4_boxes_lists_nested_boxes_like_edit_lists(tmp_path):
    # ffmpeg по умолчанию пишет edit list (edts/elst) под приминг AAC; с -use_editlist 0 — нет
    for name, extra in (("with.mp4", []), ("without.mp4", ["-use_editlist", "0"])):
        ff("-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=0.5", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=0.5",
           "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", *extra, tmp_path / name)
    boxes = media.mp4_boxes(tmp_path / "with.mp4")
    assert "moov/trak/edts/elst" in boxes
    assert "moov/trak/mdia/minf/stbl/stsd" in boxes
    assert "mdat" in boxes
    assert not any(b.endswith(("edts", "elst")) for b in media.mp4_boxes(tmp_path / "without.mp4"))


def test_mp4_boxes_reads_only_the_headers_of_a_big_file(tmp_path, monkeypatch):
    # ролик на сотни мегабайт: читаются заголовки коробок, mdat пропускается, а не грузится в память
    import struct

    big = tmp_path / "big.mp4"
    with big.open("wb") as f:
        f.write(struct.pack(">I4s", 16, b"ftyp") + b"isom\x00\x00\x02\x00")
        f.write(struct.pack(">I4s", 1, b"mdat") + struct.pack(">Q", 16 + 300 * 1024 * 1024))
        f.seek(300 * 1024 * 1024, 1)  # разреженный файл: место на диске не тратится
        moov = struct.pack(">I4s", 8, b"mvhd")
        f.write(struct.pack(">I4s", 8 + len(moov), b"moov") + moov)
    monkeypatch.setattr(Path, "read_bytes", lambda self: (_ for _ in ()).throw(AssertionError("весь файл в память")))
    assert media.mp4_boxes(big) == ["ftyp", "mdat", "moov", "moov/mvhd"]


def test_mp4_boxes_of_a_broken_file_is_an_error(tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"\x00\x00\x00\x08ftyp" + b"\x00\x00\x10\x00moov")  # коробка moov заявлена длиннее файла
    with pytest.raises(MediaError, match="MP4"):
        media.mp4_boxes(bad)


def test_a_hung_ffmpeg_is_stopped_with_a_clear_error():
    """Зависший ffmpeg (битый файл, сеть) не держит сессию монтажа: потолок времени, процесс остановлен, ошибка — словами."""
    import time

    from vm import media

    start = time.monotonic()
    with pytest.raises(media.MediaError, match="не уложился в 0 с — остановлен"):
        media._run(["sleep", "30"], timeout=0.3)
    assert time.monotonic() - start < 5


def test_normalizing_a_long_video_gets_time_by_its_length(monkeypatch, tmp_path):
    """Нормализация длинного 4K — минуты: её потолок — по длине видео, не меньше общего."""
    from vm import media

    seen = []
    monkeypatch.setattr(media, "_run", lambda cmd, timeout=media.FFMPEG_TIMEOUT: seen.append(timeout) or None)
    info = media.Probe(1080, 1920, 0, 30.0, 1200.0, False, True, None)
    monkeypatch.setattr(media, "_inspect", lambda part: (info, media._Streams(0, 1, 1200.0)))
    monkeypatch.setattr(media, "probe", lambda out: "probe")
    out = tmp_path / "source.mp4"
    with pytest.raises(media.MediaError):  # _run подменён — файла нет, _atomic об этом скажет
        media.normalize([tmp_path / "a.mov"], out)
    assert seen and seen[0] >= 4 * 1200 and seen[0] >= media.FFMPEG_TIMEOUT
