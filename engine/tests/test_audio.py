"""Звук финала: голос к −14 LUFS, музыка с приглушением под речью, звуки появления вставок.

Сигналы для проверок синтезирует сам ffmpeg (синусы), граф из `audio_graph` прогоняется настоящим ffmpeg,
результат читается как отсчёты float32.
"""
import re
import shutil
import subprocess

import numpy as np
import pytest

from vm.audio import audio_graph

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="нужен ffmpeg")
RATE = 48000


def synth(path, expr: str, seconds: float):
    """WAV из источника lavfi `expr` длиной `seconds` (моно, 48 кГц)."""
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", expr, "-t", str(seconds),
         "-ac", "1", "-ar", str(RATE), str(path)],
        check=True,
    )
    return path


def bursts(path, freq: int, seconds: float, on: str):
    """Синус `freq` Гц, слышный там, где выражение `on` от t истинно (остальное — тишина)."""
    return synth(path, f"sine=f={freq}:r={RATE},volume='if({on},1,0)':eval=frame", seconds)


def mix(tmp_path, voice, **kw):
    """Прогон графа: голос — вход 0, остальное — входы из audio_graph. → отсчёты (каналы × время), предупреждения."""
    extra, graph, warnings = audio_graph("[0:a]", inputs_offset=1, **kw)
    out = tmp_path / "out.wav"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(voice), *extra, "-filter_complex", graph,
         "-map", "[aout]", "-c:a", "pcm_f32le", str(out)],
        check=True, timeout=60,
    )
    raw = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(out), "-f", "f32le", "-acodec", "pcm_f32le", "-"],
        check=True, capture_output=True,
    ).stdout
    info = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=channels,sample_rate", "-of", "default=nw=1", str(out)],
        check=True, capture_output=True, text=True,
    ).stdout
    fields = dict(line.split("=", 1) for line in info.split())
    channels, rate = int(fields["channels"]), int(fields["sample_rate"])
    samples = np.frombuffer(raw, np.float32).reshape(-1, channels).T
    return out, samples, rate, warnings


def loudness(path) -> float:
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
        check=True, capture_output=True, text=True,
    ).stderr
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", err)[-1])


def rms_db(x: np.ndarray) -> float:
    return 20 * np.log10(np.sqrt(np.mean(np.square(x, dtype=np.float64))) + 1e-12)


def lowpass(x: np.ndarray, rate: int, cutoff: float) -> np.ndarray:
    spectrum = np.fft.rfft(x)
    spectrum[np.fft.rfftfreq(len(x), 1 / rate) > cutoff] = 0
    return np.fft.irfft(spectrum, len(x))


def test_voice_loudness_minus_14(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 440, 10, "lt(mod(t,1),0.5)")
    out, samples, rate, warnings = mix(tmp_path, voice, speed=1.0, final_dur=10.0, music=None, sfx=[])
    assert warnings == []
    assert loudness(out) == pytest.approx(-14, abs=1)
    assert samples.shape[1] / rate == pytest.approx(10.0, abs=0.05)
    assert np.max(np.abs(samples)) < 0.841, "true peak stays under -1.5 dBTP"


def test_voice_is_sped_up_and_padded_to_the_final(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 440, 11, "lt(mod(t,1),0.5)")
    _, samples, rate, _ = mix(tmp_path, voice, speed=1.1, final_dur=10.5, music=None, sfx=[])
    assert samples.shape[1] / rate == pytest.approx(10.5, abs=0.05)
    tail = samples[:, int(10.05 * rate) :]
    assert np.max(np.abs(tail)) < 1e-3, "after the voice ends there is silence up to the end (hold)"


def test_music_starts_at_zero_and_ducks(tmp_path):
    # голос — 3 кГц на 4–8 с, музыка — 100 Гц все 12 с; музыку меряем отдельно, отрезав всё выше 500 Гц
    voice = bursts(tmp_path / "voice.wav", 3000, 12, "between(t,4,8)")
    music = synth(tmp_path / "music.wav", f"sine=f=100:r={RATE},volume=8", 20)  # полная шкала
    _, samples, rate, warnings = mix(
        tmp_path, voice, speed=1.0, final_dur=12.0, music={"file": str(music), "gainDb": -18}, sfx=[]
    )
    assert warnings == []
    low = lowpass(samples[0], rate, 500)

    def part(a, b):
        return low[int(a * rate) : int(b * rate)]

    assert rms_db(part(0.15, 0.6)) > -40, "music is there from the start"
    quiet, under = rms_db(part(1.5, 3.5)), rms_db(part(5.0, 7.5))
    assert 2.0 <= quiet - under <= 4.0, (quiet, under)
    assert rms_db(part(9.5, 10.5)) == pytest.approx(quiet, abs=0.5), "music comes back after the voice"
    assert rms_db(part(11.75, 12.0)) < quiet - 6, "music fades out at the very end"


def test_music_loops_to_the_end(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 3000, 8, "lt(t,0)")  # тишина
    music = synth(tmp_path / "music.wav", f"sine=f=100:r={RATE},volume=8", 2)  # короче ролика
    _, samples, rate, _ = mix(tmp_path, voice, speed=1.0, final_dur=8.0, music={"file": str(music), "gainDb": -18}, sfx=[])
    assert samples.shape[1] / rate == pytest.approx(8.0, abs=0.05)
    assert rms_db(samples[0][int(5 * rate) : int(6 * rate)]) > -45, "short music is looped"


def test_sfx_lands_on_time(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 440, 6, "lt(t,0)")  # тишина
    click = synth(tmp_path / "pop.wav", f"sine=f=1000:r={RATE},volume=8", 0.05)  # пик ≈ 0 дБ
    _, samples, rate, warnings = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music=None, sfx=[(3.0, click)])
    assert warnings == []
    loud = np.nonzero(np.abs(samples[0]) > 0.01)[0]
    assert loud[0] / rate == pytest.approx(3.0, abs=0.033)
    for channel in samples:  # моно-звук — в оба канала и без потери 3 дБ на раскладке
        assert 20 * np.log10(float(np.max(np.abs(channel)))) == pytest.approx(-13, abs=1.0), "sfx at about -13 dB"


def test_unreadable_sfx_file_warns_not_fails(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 440, 3, "lt(t,0)")
    broken = tmp_path / "broken.wav"
    broken.write_bytes(b"not a sound")
    _, samples, rate, warnings = mix(tmp_path, voice, speed=1.0, final_dur=3.0, music=None, sfx=[(1.0, broken)])
    assert any("broken.wav" in w for w in warnings)
    assert samples.shape[1] / rate == pytest.approx(3.0, abs=0.05)


def band(x: np.ndarray, rate: int, low: float, high: float) -> np.ndarray:
    spectrum = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1 / rate)
    spectrum[(freqs < low) | (freqs > high)] = 0
    return np.fft.irfft(spectrum, len(x))


@pytest.mark.parametrize("speed, voice_len, final", [(1.0, 10.03, 10.03), (1.0, 10.07, 10.57), (1.1, 11.033, 10.03)])
@pytest.mark.parametrize("with_music", [False, True])
def test_output_is_exactly_final_dur_long(tmp_path, speed, voice_len, final, with_music):
    # длина, не кратная 0,1 с: loudnorm на последнем куске сдвигает метку времени, а длина должна быть точной
    voice = bursts(tmp_path / "voice.wav", 440, voice_len, "lt(mod(t,1),0.5)")
    music = {"file": str(synth(tmp_path / "music.wav", f"sine=f=100:r={RATE},volume=8", 30)), "gainDb": -18} if with_music else None
    _, samples, rate, _ = mix(tmp_path, voice, speed=speed, final_dur=final, music=music, sfx=[])
    assert samples.shape[1] / rate == pytest.approx(final, abs=0.002)


def test_empty_music_file_is_skipped_not_hung(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 440, 3, "lt(mod(t,1),0.5)")
    empty = tmp_path / "empty.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                    "-t", "0", str(empty)], check=True)
    _, samples, rate, warnings = mix(tmp_path, voice, speed=1.0, final_dur=3.0, music={"file": str(empty), "gainDb": -18}, sfx=[])
    assert any("empty.wav" in w for w in warnings)
    assert samples.shape[1] / rate == pytest.approx(3.0, abs=0.002)


def test_music_fades_in(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 3000, 6, "lt(t,0)")  # тишина
    music = synth(tmp_path / "music.wav", f"sine=f=100:r={RATE},volume=8", 10)
    _, samples, rate, _ = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music), "gainDb": -18}, sfx=[])
    low = samples[0]
    assert rms_db(low[: int(0.03 * rate)]) < rms_db(low[int(0.2 * rate) : int(0.6 * rate)]) - 6, "fade-in over 0.1 s"


def loudness_of(path, start: float, seconds: float) -> float:
    err = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-ss", str(start), "-t", str(seconds), "-i", str(path), "-af", "ebur128",
         "-f", "null", "-"],
        check=True, capture_output=True, text=True,
    ).stderr
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", err)[-1])


def test_music_is_brought_to_the_voice_level_before_its_gain(tmp_path):
    """Громкий и тихий трек (разница 10 дБ, как у треков Павла) под голосом звучат одинаково: трек сначала выравнивается
    к громкости голоса (−14 LUFS), потом `gainDb` (−18 — на 18 дБ тише голоса, как музыка в эталоне)."""
    voice = bursts(tmp_path / "voice.wav", 3000, 6, "lt(t,0)")  # тишина: музыка без приглушения
    levels = []
    for name, volume in (("loud", 8), ("quiet", 2.5)):
        music = synth(tmp_path / f"{name}.wav", f"sine=f=440:r={RATE},volume={volume}", 10)
        out, _, _, warnings = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music), "gainDb": -18}, sfx=[])
        assert warnings == []
        levels.append(loudness_of(out, 1.0, 4.0))
    assert levels[0] == pytest.approx(levels[1], abs=0.5), levels
    assert levels[0] == pytest.approx(-14 - 18, abs=1.0), levels


def test_gain_moves_the_music_from_the_voice_level(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 3000, 6, "lt(t,0)")
    music = synth(tmp_path / "music.wav", f"sine=f=440:r={RATE},volume=8", 10)
    out, _, _, _ = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music), "gainDb": -24}, sfx=[])
    assert loudness_of(out, 1.0, 4.0) == pytest.approx(-14 - 24, abs=1.0)


def test_music_without_a_gain_sits_14_db_under_the_voice(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 3000, 6, "lt(t,0)")
    music = synth(tmp_path / "music.wav", f"sine=f=440:r={RATE},volume=8", 10)
    out, _, _, _ = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music)}, sfx=[])
    assert loudness_of(out, 1.0, 4.0) == pytest.approx(-14 - 14, abs=1.0)


def test_only_the_part_of_the_track_in_the_video_is_measured(tmp_path):
    """Тихое начало трека и громкий конец: ролик на 6 с — выравнивается по тихому началу, которое в нём и звучит."""
    voice = bursts(tmp_path / "voice.wav", 3000, 6, "lt(t,0)")
    music = synth(tmp_path / "music.wav", f"sine=f=440:r={RATE},volume='if(lt(t,8),0.5,8)':eval=frame", 20)
    out, _, _, _ = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music), "gainDb": -18}, sfx=[])
    assert loudness_of(out, 1.0, 4.0) == pytest.approx(-14 - 18, abs=1.0)


def test_an_mp3_with_cover_art_is_leveled_too(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 3000, 6, "lt(t,0)")
    art = tmp_path / "art.png"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1",
                    "-frames:v", "1", str(art)], check=True)
    music = tmp_path / "music.mp3"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"sine=f=440:r={RATE},volume=8",
         "-i", str(art), "-t", "10", "-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-c:v", "png",
         "-disposition:v", "attached_pic", str(music)],
        check=True,
    )
    out, _, _, warnings = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music), "gainDb": -18}, sfx=[])
    assert warnings == []
    assert loudness_of(out, 1.0, 4.0) == pytest.approx(-14 - 18, abs=1.0)


def test_music_that_cannot_be_measured_is_a_warning(tmp_path, monkeypatch):
    monkeypatch.setattr("vm.audio._loudness", lambda *args: None)
    voice = bursts(tmp_path / "voice.wav", 3000, 4, "lt(t,0)")
    music = synth(tmp_path / "music.wav", f"sine=f=440:r={RATE},volume=8", 10)
    _, _, _, warnings = mix(tmp_path, voice, speed=1.0, final_dur=4.0, music={"file": str(music), "gainDb": -18}, sfx=[])
    assert any("не измерилась" in w for w in warnings), warnings


def test_a_near_silent_track_is_not_pumped_up(tmp_path):
    """Почти тишина (−60 LUFS) не поднимается до голоса: подъём не больше 12 дБ — иначе поднялся бы и шум."""
    voice = bursts(tmp_path / "voice.wav", 3000, 6, "lt(t,0)")
    music = synth(tmp_path / "music.wav", f"sine=f=440:r={RATE},volume=0.008", 10)  # ≈ −60 LUFS
    out, _, _, _ = mix(tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music), "gainDb": -18}, sfx=[])
    assert loudness_of(out, 1.0, 4.0) < -60 + 12 - 18 + 2


def test_sfx_lands_on_time_in_both_channels_with_music(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 440, 6, "lt(t,0)")  # тишина
    music = synth(tmp_path / "music.wav", f"sine=f=100:r={RATE},volume=8", 10)
    click = synth(tmp_path / "pop.wav", f"sine=f=1000:r={RATE},volume=8", 0.05)
    _, samples, rate, warnings = mix(
        tmp_path, voice, speed=1.0, final_dur=6.0, music={"file": str(music), "gainDb": -18}, sfx=[(3.0, click)]
    )
    assert warnings == []
    for channel in samples:
        high = band(channel, rate, 800, 1200)
        loud = np.nonzero(np.abs(high) > 0.02)[0]
        assert loud[0] / rate == pytest.approx(3.0, abs=0.033)


def test_mix_peaks_stay_under_minus_1_5_db(tmp_path):
    # громкий звук вставки на громком месте речи: сумма не должна уходить за −1,5 дБ
    voice = synth(tmp_path / "voice.wav", f"sine=f=440:r={RATE},volume=8", 4)
    click = synth(tmp_path / "pop.wav", f"sine=f=440:r={RATE},volume=8", 0.5)
    _, samples, _, _ = mix(tmp_path, voice, speed=1.0, final_dur=4.0, music=None, sfx=[(2.0, click)])
    assert float(np.max(np.abs(samples))) <= 0.85


@pytest.mark.parametrize("kw", [{"final_dur": 0.0}, {"speed": 0.3}, {"speed": 200.0}])
def test_bad_numbers_are_refused(tmp_path, kw):
    args = {"speed": 1.0, "final_dur": 3.0, "music": None, "sfx": []} | kw
    with pytest.raises(ValueError):
        audio_graph("[0:a]", inputs_offset=1, **args)


def test_labels_do_not_clash_with_the_picture_graph():
    _, graph, _ = audio_graph("[0:a]", 1.1, 5.0, None, [], inputs_offset=1)
    labels = set(re.findall(r"\[([^\]:]+)\]", graph)) - {"aout"}
    assert labels and all(label.startswith("a_") for label in labels), labels


def test_short_final_still_fades_music_to_silence(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 3000, 1, "lt(t,0)")
    music = synth(tmp_path / "music.wav", f"sine=f=100:r={RATE},volume=8", 3)
    _, samples, rate, _ = mix(tmp_path, voice, speed=1.0, final_dur=0.6, music={"file": str(music), "gainDb": -18}, sfx=[])
    assert rms_db(samples[0][-int(0.02 * rate) :]) < rms_db(samples[0][int(0.1 * rate) : int(0.3 * rate)]) - 10


def test_missing_music_file_warns_not_fails(tmp_path):
    voice = bursts(tmp_path / "voice.wav", 440, 4, "lt(mod(t,1),0.5)")
    gone = tmp_path / "nope.mp3"
    _, samples, rate, warnings = mix(
        tmp_path, voice, speed=1.0, final_dur=4.0, music={"file": str(gone), "gainDb": -18}, sfx=[(1.0, tmp_path / "no-pop.wav")]
    )
    assert any("nope.mp3" in w for w in warnings)
    assert any("no-pop.wav" in w for w in warnings)
    assert not any(str(tmp_path) in w for w in warnings), "пути контейнера Павлу ни к чему: только имя файла"
    assert samples.shape[1] / rate == pytest.approx(4.0, abs=0.05)


# ---------- тихая запись: шумоподавление до loudnorm ----------


def test_quiet_voice_is_denoised_before_loudnorm():
    _, graph, _ = audio_graph("[0:a]", 1.0, 3.0, None, [], inputs_offset=1, denoise=True)
    voice = graph.split(";")[0]
    assert "afftdn" in voice and voice.index("afftdn") < voice.index("loudnorm"), voice
    _, plain, _ = audio_graph("[0:a]", 1.0, 3.0, None, [], inputs_offset=1)
    assert "afftdn" not in plain


def test_denoise_lowers_the_hiss_between_phrases(tmp_path):
    # тихий «голос» (полсекунды звука через полсекунды) и ровное шипение под ним всё время
    voice = tmp_path / "quiet.wav"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
         f"sine=f=440:r={RATE},volume='if(lt(mod(t,1),0.5),0.02,0)':eval=frame", "-f", "lavfi", "-i",
         f"anoisesrc=color=white:amplitude=0.002:r={RATE}:seed=7", "-filter_complex", "[0:a][1:a]amix=inputs=2:normalize=0",
         "-t", "8", "-ac", "1", "-ar", str(RATE), str(voice)],
        check=True,
    )
    gaps = lambda x, rate: np.concatenate([x[int((k + 0.65) * rate) : int((k + 0.9) * rate)] for k in range(2, 7)])
    _, plain, rate, _ = mix(tmp_path, voice, speed=1.0, final_dur=8.0, music=None, sfx=[])
    plain_gap = rms_db(gaps(plain[0], rate))
    clean_out, clean, rate, _ = mix(tmp_path, voice, speed=1.0, final_dur=8.0, music=None, sfx=[], denoise=True)
    assert rms_db(gaps(clean[0], rate)) <= plain_gap - 6, (rms_db(gaps(clean[0], rate)), plain_gap)
    assert loudness(clean_out) == pytest.approx(-14, abs=2)
