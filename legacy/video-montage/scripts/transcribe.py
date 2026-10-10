#!/usr/bin/env python3
"""Субтитры для ГОТОВОГО монтажа: делит звук на островки речи (между паузами),
распознаёт каждый островок отдельно и пишет subs.json — [{start, end, text}]
во времени именно этого видео. Плюс печатает сплошной текст окнами по ~25 с:
он грамотнее (whisper видит контекст), по нему правят текст островков.

    python3 transcribe.py edited.mp4 -o subs.json --lang ru --model <MODEL из setup.sh>

После запуска ОБЯЗАТЕЛЬНО прочитать subs.json и исправить текст руками
(имена, бренды, оборванные слова), времена не трогать.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

ap = argparse.ArgumentParser()
ap.add_argument('video')
ap.add_argument('-o', '--out', default='subs.json')
ap.add_argument('--lang', default='ru')
ap.add_argument('--model', default='large-v3-turbo', help='путь к модели или имя ggml-модели')
ap.add_argument('--noise', type=float, default=None, help='порог тишины, дБ (по умолчанию: от громкости записи)')
ap.add_argument('--min-sil', type=float, default=0.12, help='минимальная пауза между островками, с')
args = ap.parse_args()

whisper = shutil.which('whisper-cli') or shutil.which('whisper-cpp')
if not whisper:
    sys.exit('whisper-cli не найден: запустите scripts/setup.sh')
model = args.model
if not os.path.exists(model):
    model = os.path.join(os.path.expanduser('~'), '.cache', 'whisper-cpp', f'ggml-{model}.bin')

work = tempfile.mkdtemp(prefix='subs_')
wav = os.path.join(work, 'all.wav')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', args.video, '-vn', '-ac', '1', '-ar', '16000', wav], check=True)
dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav],
                           capture_output=True, text=True).stdout)

noise = args.noise
if noise is None:                          # тихая запись (телефон издалека) -> порог ниже
    vd = subprocess.run(['ffmpeg', '-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'],
                        capture_output=True, text=True).stderr
    mx = float(re.search(r'max_volume: (-?[\d.]+)', vd).group(1))
    noise = min(-30.0, mx - 20.0)
sd = subprocess.run(['ffmpeg', '-hide_banner', '-i', wav, '-af', f'silencedetect=noise={noise}dB:d={args.min_sil}',
                     '-f', 'null', '-'], capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r'silence_start: (-?[\d.]+)', sd)]
ends = [float(x) for x in re.findall(r'silence_end: ([\d.]+)', sd)]
sil = list(zip(starts, ends + [dur] * (len(starts) - len(ends))))
isl, cur = [], 0.0
for a, b in sil:
    if a - cur >= 0.08:
        isl.append((max(0.0, cur), a))
    cur = b
if dur - cur >= 0.08:
    isl.append((cur, dur))


def run_whisper(files):
    subprocess.run([whisper, '-m', model, '-l', args.lang, '-t', str(min(8, os.cpu_count() or 4)), '-np', '-otxt'] + files,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return [' '.join(open(f + '.txt', encoding='utf-8').read().split()) if os.path.exists(f + '.txt') else '' for f in files]


files = []
for k, (a, b) in enumerate(isl):
    f = os.path.join(work, f'i{k:03d}.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-ss', f'{max(0, a - 0.08):.3f}', '-to', f'{b + 0.08:.3f}', f])
    files.append(f)
texts = run_whisper(files) if files else []
subs = [{'start': round(a, 3), 'end': round(b, 3), 'text': t} for (a, b), t in zip(isl, texts) if t.strip()]

wins = []
for k in range(0, int(dur // 25) + 1):
    a = k * 25.0
    if a >= dur - 0.2:
        break
    f = os.path.join(work, f'w{k:03d}.wav')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-ss', str(a), '-t', '25', f])
    wins.append(f)
full = run_whisper(wins)

json.dump(subs, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'длительность {dur:.1f} c, порог тишины {noise:.0f} дБ, островков с речью: {len(subs)} -> {args.out}')
for s in subs:
    print(f"  {s['start']:6.2f}–{s['end']:6.2f}  {s['text']}")
print('\nСплошной текст (для правки островков):')
for k, t in enumerate(full):
    print(f'  [{k * 25}–{k * 25 + 25} c] {t}')
shutil.rmtree(work, ignore_errors=True)
