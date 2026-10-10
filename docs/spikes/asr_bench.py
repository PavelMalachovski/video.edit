#!/usr/bin/env python3
"""Спайк: точность времени слов у распознавания в облачной сессии.

Речь синтезируется espeak-ng по одному слову (известны точные начала слов),
слова склеиваются с паузами 0.12 с внутри фразы и 0.8 с между фразами.
Сравниваются: sherpa-onnx Whisper turbo, GigaAM v2 CTC, GigaAM v2 transducer,
и запасной вариант «время фразы + распределение по буквам».

    python3 -I docs/spikes/asr_bench.py [--models ~/.cache/vm] [--out /tmp/asr]
"""
import argparse, difflib, json, os, re, subprocess, sys, tempfile, time
import numpy as np, soundfile as sf, sherpa_onnx

PHRASES = [["сегодня", "я", "расскажу"],
           ["как", "я", "учу", "чешский", "каждый", "день"],
           ["добавь", "сюда", "логотип"]]
SR = 16000

def synth_word(word, d):
    p = os.path.join(d, 'w.wav')
    subprocess.run(['espeak-ng', '-v', 'ru', '-s', '150', '-w', p, word], check=True)
    s, sr = sf.read(p, dtype='float32')
    if s.ndim > 1: s = s.mean(axis=1)
    n = int(len(s) * SR / sr)
    s = np.interp(np.linspace(0, len(s) - 1, n), np.arange(len(s)), s).astype('float32')
    nz = np.where(np.abs(s) > 0.02)[0]
    return s[nz[0]:nz[-1] + 1]

def build(d):
    out, truth, t = [np.zeros(int(0.5 * SR), 'float32')], [], 0.5
    for pi, ph in enumerate(PHRASES):
        for wi, w in enumerate(ph):
            a = synth_word(w, d)
            truth.append((w, t, t + len(a) / SR)); out.append(a); t += len(a) / SR
            gap = 0.12 if wi < len(ph) - 1 else (0.8 if pi < len(PHRASES) - 1 else 0.5)
            out.append(np.zeros(int(gap * SR), 'float32')); t += gap
    return np.concatenate(out), truth

def norm(w): return re.sub(r'[^а-яёa-z0-9]', '', w.lower()).replace('ё', 'е')

def words_from_tokens(tokens, stamps, end):
    """Символьные/BPE токены с временем → слова (граница — пробел или '▁')."""
    words, cur, t0 = [], '', None
    for tok, ts in zip(tokens, stamps):
        if tok.strip() == '' or tok.startswith('▁'):
            if cur: words.append([cur, t0]); cur, t0 = '', None
            tok = tok.replace('▁', '').strip()
            if not tok: continue
        if t0 is None: t0 = ts
        cur += tok
    if cur: words.append([cur, t0])
    return [(w, t0, words[i + 1][1] if i + 1 < len(words) else end) for i, (w, t0) in enumerate(words)]

def score(pred, truth):
    a, b = [norm(w) for w, *_ in truth], [norm(w) for w, *_ in pred]
    m = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    errs = []
    for blk in m.get_matching_blocks():
        for k in range(blk.size):
            errs.append(abs(pred[blk.b + k][1] - truth[blk.a + k][1]))
    return {'matched': len(errs), 'of': len(truth), 'mean_ms': round(1000 * float(np.mean(errs)), 1) if errs else None,
            'max_ms': round(1000 * float(np.max(errs)), 1) if errs else None}

def vad_segments(audio, models):
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = os.path.join(models, 'silero_vad.onnx')
    cfg.silero_vad.min_silence_duration = 0.3; cfg.sample_rate = SR
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=120)
    segs, w = [], cfg.silero_vad.window_size
    for i in range(0, len(audio), w):
        vad.accept_waveform(audio[i:i + w])
        while not vad.empty():
            s = vad.front; segs.append((s.start / SR, np.array(s.samples, 'float32'))); vad.pop()
    vad.flush()
    while not vad.empty():
        s = vad.front; segs.append((s.start / SR, np.array(s.samples, 'float32'))); vad.pop()
    return segs

def distribute(text, t0, t1):
    ws = [w for w in text.split() if norm(w)]
    if not ws: return []
    L = [len(norm(w)) for w in ws]; tot = sum(L); out, t = [], t0
    for w, l in zip(ws, L):
        d = (t1 - t0) * l / tot; out.append((w, t, t + d)); t += d
    return out

def run(rec, audio):
    st = rec.create_stream(); st.accept_waveform(SR, audio); rec.decode_stream(st); return st.result

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default=os.path.expanduser('~/.cache/vm'))
    ap.add_argument('--out', default='/tmp/asr')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    with tempfile.TemporaryDirectory() as d:
        audio, truth = build(d)
    dur = len(audio) / SR
    sf.write(os.path.join(a.out, 'test.wav'), audio, SR)
    json.dump(truth, open(os.path.join(a.out, 'truth.json'), 'w'), ensure_ascii=False)
    M = a.models; res = {'audio_s': round(dur, 2)}
    W = os.path.join(M, 'sherpa-onnx-whisper-turbo')
    C = os.path.join(M, 'sherpa-onnx-nemo-ctc-giga-am-v2-russian-2025-04-19')
    T = os.path.join(M, 'sherpa-onnx-nemo-transducer-giga-am-v2-russian-2025-04-19')
    recs = {
        'whisper_turbo': lambda: sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=f'{W}/turbo-encoder.int8.onnx', decoder=f'{W}/turbo-decoder.int8.onnx',
            tokens=f'{W}/turbo-tokens.txt', language='ru', task='transcribe', num_threads=4, tail_paddings=1000),
        'gigaam_ctc': lambda: sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=f'{C}/model.int8.onnx', tokens=f'{C}/tokens.txt', num_threads=4),
        'gigaam_rnnt': lambda: sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=f'{T}/encoder.int8.onnx', decoder=f'{T}/decoder.onnx', joiner=f'{T}/joiner.onnx',
            tokens=f'{T}/tokens.txt', model_type='nemo_transducer', num_threads=4),
    }
    segs = vad_segments(audio, M)
    res['vad_segments'] = [(round(s, 2), round(s + len(x) / SR, 2)) for s, x in segs]
    for name, mk in recs.items():
        t = time.time(); rec = mk(); load = time.time() - t
        t = time.time(); r = run(rec, audio); el = time.time() - t
        stamps = list(getattr(r, 'timestamps', []) or [])
        entry = {'load_s': round(load, 1), 'rtf': round(el / dur, 3), 'text': r.text.strip(), 'has_timestamps': bool(stamps)}
        if stamps:
            entry['words'] = score(words_from_tokens(list(r.tokens), stamps, dur), truth)
        # запасной вариант: VAD-фразы + распределение по буквам
        t = time.time(); pred = []
        for s0, x in segs:
            rr = run(rec, x); pred += distribute(rr.text, s0, s0 + len(x) / SR)
        entry['vad_distribute'] = score(pred, truth); entry['vad_distribute_rtf'] = round((time.time() - t) / dur, 3)
        res[name] = entry
        print(name, json.dumps(entry, ensure_ascii=False), flush=True)
    json.dump(res, open(os.path.join(a.out, 'results.json'), 'w'), ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main()


def long_form(models, out, reps=6):
    """GigaAM transducer на ~1 минуте: целиком и по VAD-кускам (время со сдвигом)."""
    with tempfile.TemporaryDirectory() as d:
        audio, truth = build(d)
    one = len(audio) / SR
    audio = np.concatenate([audio] * reps)
    truth = [(w, t0 + k * one, t1 + k * one) for k in range(reps) for (w, t0, t1) in truth]
    dur = len(audio) / SR
    T = os.path.join(models, 'sherpa-onnx-nemo-transducer-giga-am-v2-russian-2025-04-19')
    rec = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=f'{T}/encoder.int8.onnx', decoder=f'{T}/decoder.onnx', joiner=f'{T}/joiner.onnx',
        tokens=f'{T}/tokens.txt', model_type='nemo_transducer', num_threads=4)
    res = {'audio_s': round(dur, 1)}
    t = time.time(); r = run(rec, audio)
    res['whole'] = {'rtf': round((time.time() - t) / dur, 3),
                    **score(words_from_tokens(list(r.tokens), list(r.timestamps), dur), truth)}
    t = time.time(); pred = []
    for s0, x in vad_segments(audio, models):
        rr = run(rec, x)
        pred += [(w, s0 + a, s0 + b) for w, a, b in words_from_tokens(list(rr.tokens), list(rr.timestamps), len(x) / SR)]
    res['vad'] = {'rtf': round((time.time() - t) / dur, 3), **score(pred, truth)}
    print('long_form', json.dumps(res, ensure_ascii=False), flush=True)
    return res


if __name__ == '__main__' and os.environ.get('ASR_LONG'):
    long_form(os.path.expanduser('~/.cache/vm'), '/tmp/asr')
