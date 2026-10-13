"""Файлы для проверки редактора на настоящем ролике: прокси, голос до/после очистки, волна, лента кадров, данные.

python3 prep_media.py <папка тестовой задачи> <папка задачи рутины> <папка сайта> <dpdfnet.onnx> <музыка>
"""
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf

job, src_job, site, model, music = (Path(a) for a in sys.argv[1:6])
site.mkdir(parents=True, exist_ok=True)
work = site.parent / "work"
work.mkdir(exist_ok=True)
L = 30.0
SR = 48000


def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


source = job / "source.mp4"
# прокси: 540×960, ключевой кадр каждые 0,5 с — быстрые переходы по кускам; звук отдельно
ff("-i", str(source), "-an", "-vf", "scale=540:960", "-c:v", "libx264", "-preset", "medium", "-crf", "27",
   "-g", "15", "-keyint_min", "15", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
   str(site / "proxy.mp4"))
# голос: моно 48 кГц без потерь — для модели; и тот же голос AAC — для страницы
raw_wav = work / "voice.wav"
ff("-i", str(source), "-vn", "-ac", "1", "-ar", str(SR), "-c:a", "pcm_f32le", str(raw_wav))
x, sr = sf.read(raw_wav, dtype="float32")
assert sr == SR
cfg = sherpa_onnx.OfflineSpeechDenoiserConfig(model=sherpa_onnx.OfflineSpeechDenoiserModelConfig(
    dpdfnet=sherpa_onnx.OfflineSpeechDenoiserDpdfNetModelConfig(model=str(model)), num_threads=4, provider="cpu"))
den = sherpa_onnx.OfflineSpeechDenoiser(cfg)
t = time.time()
y = den(np.ascontiguousarray(x), SR)
spent = time.time() - t
c = np.asarray(y.samples, dtype="float32")
assert y.sample_rate == SR, y.sample_rate
# длина ровно как у исходного голоса — отсчёт в отсчёт с видео
c = c[: len(x)] if len(c) >= len(x) else np.pad(c, (0, len(x) - len(c)))
sf.write(work / "clean.wav", c, SR, subtype="FLOAT")
for name, wav in (("voice", raw_wav), ("clean", work / "clean.wav")):
    ff("-i", str(wav), "-c:a", "aac", "-b:a", "128k", str(site / f"{name}.m4a"))
# музыка рутины: с начала трека, с запасом на ×1 скорость
ff("-i", str(music), "-t", "40", "-vn", "-ac", "2", "-ar", str(SR), "-c:a", "aac", "-b:a", "128k", str(site / "music.m4a"))


def peaks(sig, per_s=100):
    n = len(sig) // (SR // per_s)
    a = np.abs(sig[: n * (SR // per_s)]).reshape(n, -1).max(axis=1)
    top = float(np.percentile(np.abs(x), 99.9)) or 1.0
    return [int(v) for v in np.clip(a / top * 255, 0, 255)]


def level(sig):
    """Грубо: уровень тишины (10-й процентиль окон по 50 мс) и речи (90-й), дБFS."""
    w = SR // 20
    n = len(sig) // w
    rms = np.sqrt((sig[: n * w].reshape(n, w) ** 2).mean(axis=1) + 1e-12)
    return round(float(20 * np.log10(np.percentile(rms, 10))), 1), round(float(20 * np.log10(np.percentile(rms, 90))), 1)


# лента кадров: кадр каждые 0,5 с, 54×96, одной картинкой
film = work / "film"
film.mkdir(exist_ok=True)
for p in film.glob("*.jpg"):
    p.unlink()
ff("-i", str(source), "-vf", "fps=2,scale=54:96", "-q:v", "5", str(film / "f%03d.jpg"))
frames = sorted(film.glob("*.jpg"))
ff("-pattern_type", "glob", "-i", str(film / "*.jpg"), "-vf", f"tile={len(frames)}x1", "-q:v", "5", "-frames:v", "1",
   str(site / "film.jpg"))

edit = json.loads((src_job / "edit.json").read_text())
words = [w for w in edit["words"] if w["t1"] <= L]
data = {
    "source": {"name": "IMG_8524 (2).MOV", "dur": round(len(x) / SR, 3), "film": {"step": 0.5, "w": 54, "h": 96, "n": len(frames)}},
    "keep": [[a, min(b, L)] for a, b in edit["keep"] if a < L],
    "speed": edit["speed"],
    "words": words,
    "asr": [w for w in json.loads((job / "words.json").read_text())],
    "hook": edit.get("hook"),
    "accents": [a for a in edit.get("accents", []) if a["t0"] < L],
    "zooms": [z for z in edit.get("zooms", []) if z["t"] < L],
    "looks": [k for k in edit.get("looks", []) if k["t0"] < L],
    "music": {"name": Path(edit["music"]["file"]).stem, "gainDb": edit["music"]["gainDb"], "dur": 40},
    "style": edit.get("style"),
    "peaks": {"voice": peaks(x), "clean": peaks(c), "perS": 100},
    "levels": {"voice": level(x), "clean": level(c)},
    "denoise": {"model": "DPDFNet2-48k", "seconds": round(spent, 2), "rtf": round(spent / (len(x) / SR), 3)},
}
(site / "data.json").write_text(json.dumps(data, ensure_ascii=False))
print(json.dumps({k: data[k] for k in ("keep", "speed", "levels", "denoise")}, ensure_ascii=False))
for p in sorted(site.iterdir()):
    print(p.name, p.stat().st_size)
