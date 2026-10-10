#!/usr/bin/env python3
"""Minimal whisper-cli stand-in (installed by setup.sh when huggingface.co is unreachable) backed by sherpa-onnx (whisper turbo ONNX).
Supports: -m MODEL(ignored) -l LANG -t THREADS -np -otxt file...  -> writes file.txt"""
import sys, os, numpy as np, soundfile as sf, sherpa_onnx
a = sys.argv[1:]; lang = 'en'; threads = 4; files = []
i = 0
while i < len(a):
    x = a[i]
    if x in ('-m', '-t', '-l'):
        if x == '-l': lang = a[i + 1]
        if x == '-t': threads = int(a[i + 1])
        i += 2; continue
    if x.startswith('-'): i += 1; continue
    files.append(x); i += 1
if not files: print('usage: whisper-cli [options] file0 file1 ...'); sys.exit(0)
M = os.path.expanduser('~/.cache/sherpa/sherpa-onnx-whisper-turbo/')
rec = sherpa_onnx.OfflineRecognizer.from_whisper(
    encoder=M + 'turbo-encoder.int8.onnx', decoder=M + 'turbo-decoder.int8.onnx',
    tokens=M + 'turbo-tokens.txt', language='' if lang == 'auto' else lang,
    task='transcribe', num_threads=threads, tail_paddings=1000)
for f in files:
    s, sr = sf.read(f, dtype='float32', always_2d=True)
    s = s.mean(axis=1)
    if sr != 16000:
        import math
        n = int(len(s) * 16000 / sr); s = np.interp(np.linspace(0, len(s) - 1, n), np.arange(len(s)), s).astype('float32'); sr = 16000
    st = rec.create_stream(); st.accept_waveform(sr, s); rec.decode_stream(st)
    r = st.result
    open(f + '.txt', 'w', encoding='utf-8').write(r.text.strip() + '\n')
    print(f'{os.path.basename(f)} [{getattr(r, "lang", "")}]: {r.text.strip()}', file=sys.stderr)
