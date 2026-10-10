#!/usr/bin/env python3
"""Спайк: время слов для нерусской речи (этап 1 мультиязычности).

Как asr_bench.py: espeak-ng по одному слову (начало каждого слова известно), паузы 0,12 с в фразе и 0,8 с
между фразами. Языки — en, cs, de, uk (+ ru для сравнения). Варианты:
  parakeet — NeMo Parakeet TDT 0.6B v3 int8 (transducer, 25 европейских языков, время токенов);
  whisper_ts — Whisper turbo с enable_token_timestamps (язык задан);
  whisper_auto — Whisper turbo без языка: какой язык он определил.

    python3 -I docs/spikes/asr_bench_multi.py [--models ~/.cache/vm] [--out /tmp/asr-multi]
"""
import argparse, difflib, json, os, re, subprocess, tempfile, time
import numpy as np, soundfile as sf, sherpa_onnx

SR = 16000
TEXT = {
    'en': [['today', 'I', 'will', 'tell', 'you'], ['how', 'I', 'learn', 'Czech', 'every', 'day'], ['add', 'the', 'logo', 'here']],
    'cs': [['dnes', 'vám', 'řeknu'], ['jak', 'se', 'učím', 'česky', 'každý', 'den'], ['přidej', 'sem', 'logo']],
    'de': [['heute', 'erzähle', 'ich', 'euch'], ['wie', 'ich', 'jeden', 'Tag', 'Tschechisch', 'lerne'], ['füge', 'hier', 'das', 'Logo', 'hinzu']],
    'uk': [['сьогодні', 'я', 'розповім'], ['як', 'я', 'вчу', 'чеську', 'щодня'], ['додай', 'сюди', 'логотип']],
    'ru': [['сегодня', 'я', 'расскажу'], ['как', 'я', 'учу', 'чешский', 'каждый', 'день'], ['добавь', 'сюда', 'логотип']],
}
VOICE = {'en': 'en-us', 'cs': 'cs', 'de': 'de', 'uk': 'uk', 'ru': 'ru'}


def synth(word, voice, d):
    p = os.path.join(d, 'w.wav')
    subprocess.run(['espeak-ng', '-v', voice, '-s', '150', '-w', p, word], check=True)
    s, sr = sf.read(p, dtype='float32')
    if s.ndim > 1:
        s = s.mean(axis=1)
    n = int(len(s) * SR / sr)
    s = np.interp(np.linspace(0, len(s) - 1, n), np.arange(len(s)), s).astype('float32')
    nz = np.where(np.abs(s) > 0.02)[0]
    return s[nz[0]:nz[-1] + 1]


def build(lang, d, reps=1):
    out, truth, t = [np.zeros(int(0.5 * SR), 'float32')], [], 0.5
    phrases = TEXT[lang] * reps
    for pi, ph in enumerate(phrases):
        for wi, w in enumerate(ph):
            a = synth(w, VOICE[lang], d)
            truth.append((w, t)); out.append(a); t += len(a) / SR
            gap = 0.12 if wi < len(ph) - 1 else 0.8
            out.append(np.zeros(int(gap * SR), 'float32')); t += gap
    return np.concatenate(out), truth


def norm(w):
    return re.sub(r'[^\w]', '', w.lower())


def words(tokens, stamps):
    """BPE (▁) или буквы с пробелом → слова с временем первого токена."""
    out, cur, t0 = [], '', None
    for tok, ts in zip(tokens, stamps):
        new = tok.startswith('▁') or tok.startswith(' ') or not tok.strip()
        if new and cur:
            out.append((cur, t0)); cur, t0 = '', None
        tok = tok.replace('▁', '').strip()
        if not tok:
            continue
        if t0 is None:
            t0 = ts
        cur += tok
    if cur:
        out.append((cur, t0))
    return out


def score(pred, truth):
    a, b = [norm(w) for w, _ in truth], [norm(w) for w, _ in pred]
    m = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    errs = [abs(pred[k.b + i][1] - truth[k.a + i][1]) for k in m.get_matching_blocks() for i in range(k.size)]
    e = np.array(errs) if errs else np.array([np.nan])
    return {'matched': len(errs), 'of': len(truth), 'mean_ms': round(1000 * float(np.mean(e)), 1),
            'max_ms': round(1000 * float(np.max(e)), 1), 'within_100ms': round(float(np.mean(e <= 0.1)), 2) if errs else 0}


def run(rec, audio):
    st = rec.create_stream(); st.accept_waveform(SR, audio); rec.decode_stream(st); return st.result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default=os.path.expanduser('~/.cache/vm'))
    ap.add_argument('--out', default='/tmp/asr-multi')
    ap.add_argument('--reps', type=int, default=1)
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    M = a.models
    P = os.path.join(M, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
    W = os.path.join(M, 'sherpa-onnx-whisper-turbo')
    t = time.time()
    parakeet = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=f'{P}/encoder.int8.onnx', decoder=f'{P}/decoder.int8.onnx', joiner=f'{P}/joiner.int8.onnx',
        tokens=f'{P}/tokens.txt', model_type='nemo_transducer', num_threads=4)
    print('parakeet load', round(time.time() - t, 1), flush=True)

    def whisper(lang, ts):
        return sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=f'{W}/turbo-encoder.int8.onnx', decoder=f'{W}/turbo-decoder.int8.onnx', tokens=f'{W}/turbo-tokens.txt',
            language=lang, task='transcribe', num_threads=4, tail_paddings=1000, enable_token_timestamps=ts)

    auto = whisper('', False)
    res = {}
    for lang in TEXT:
        with tempfile.TemporaryDirectory() as d:
            audio, truth = build(lang, d, a.reps)
        dur = len(audio) / SR
        sf.write(os.path.join(a.out, f'{lang}.wav'), audio, SR)
        entry = {'audio_s': round(dur, 1)}
        t = time.time(); r = run(parakeet, audio)
        entry['parakeet'] = {'rtf': round((time.time() - t) / dur, 3), 'text': r.text.strip(),
                             **score(words(list(r.tokens), list(r.timestamps)), truth)}
        if a.reps == 1:
            t = time.time(); r = run(whisper(lang, True), audio[: 29 * SR])
            stamps = list(r.timestamps or [])
            entry['whisper_ts'] = {'rtf': round((time.time() - t) / min(dur, 29), 3), 'text': r.text.strip(), 'stamps': len(stamps),
                                   **(score(words(list(r.tokens), stamps), truth) if stamps else {})}
            r = run(auto, audio[: 29 * SR])
            entry['whisper_auto'] = {'lang': getattr(r, 'lang', '?'), 'text': r.text.strip()}
        res[lang] = entry
        print(lang, json.dumps(entry, ensure_ascii=False), flush=True)
    json.dump(res, open(os.path.join(a.out, f'results-{a.reps}.json'), 'w'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
