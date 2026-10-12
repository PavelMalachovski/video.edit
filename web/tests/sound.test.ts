import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  audioUrl, dbToGain, DEFAULT_MUSIC_DB, MIN_MUSIC, envelopeCurve, FADE_IN, FADE_OUT, levelsOf, loudnessDb, MUSIC_BOOST, musicEnvelope, musicGainDb, musicMix,
  musicOffset, scheduleKey, SFX_GAIN_DB, soundPlan, VOICE_LUFS,
} from '../lib/sound.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('the mix numbers are the engine\'s (audio.py): voice level, music boost, sounds, fades, default music dB', () => {
  const py = readFileSync(new URL('../../engine/vm/audio.py', import.meta.url), 'utf8');
  const num = (name: string) => Number(new RegExp(`^${name} = (-?[\\d.]+)`, 'm').exec(py)?.[1]);
  assert.deepEqual([VOICE_LUFS, MUSIC_BOOST, SFX_GAIN_DB, FADE_IN, FADE_OUT, MIN_MUSIC],
    ['VOICE_LUFS', 'MUSIC_BOOST', 'SFX_GAIN_DB', 'FADE_IN', 'FADE_OUT', 'MIN_MUSIC'].map(num));
  assert.match(py, new RegExp(`music\\.get\\("gainDb", ${DEFAULT_MUSIC_DB}\\)`));
});

test('the editor hears the music and the sounds through the page (same origin), pinned to the head', () => {
  const head = 'a'.repeat(40);
  assert.equal(audioUrl('261010-070509-abcd', head, 'assets/music/lo fi.mp3'), `/api/jobs/261010-070509-abcd/audio?path=assets%2Fmusic%2Flo%20fi.mp3&v=${head}`);
});

test('music: the session\'s choice with Pavel\'s edits on top', () => {
  const draft = { file: 'assets/music/a.mp3', gainDb: -12, at: 1 };
  assert.deepEqual(musicMix(draft), { file: 'assets/music/a.mp3', gainDb: -12, muted: false, at: 1, from: 0, fadeIn: FADE_IN, fadeOut: FADE_OUT });
  assert.deepEqual(musicMix(draft, { gainDb: -20, muted: true, from: 5, fadeOut: 3 }),
    { file: 'assets/music/a.mp3', gainDb: -20, muted: true, at: 1, from: 5, fadeIn: FADE_IN, fadeOut: 3 });
  assert.equal(musicMix(null, { muted: false }), null, 'музыки нет — правка её не добавит (как edits.apply)');
  assert.deepEqual(musicMix(draft, { file: 'assets/music/b.mp3' })?.file, 'assets/music/b.mp3', 'другой трек');
  assert.deepEqual(musicMix(null, { file: 'assets/music/b.mp3', at: 2 }),
    { file: 'assets/music/b.mp3', gainDb: DEFAULT_MUSIC_DB, muted: false, at: 2, from: 0, fadeIn: FADE_IN, fadeOut: FADE_OUT }, 'трек в ролике без музыки');
});

test('music offset: silent before it starts; the first pass from `from`, then the whole track again', () => {
  const m = { at: 2, from: 10 };
  assert.equal(musicOffset(m, 30, 1), null);
  assert.equal(musicOffset(m, 30, 2), 10);
  close(musicOffset(m, 30, 21.5) as number, 29.5);
  close(musicOffset(m, 30, 22) as number, 0);
  close(musicOffset(m, 30, 27) as number, 5);
});

test('music envelope: rises over fadeIn from its start, falls over fadeOut to the end; fades no longer than the music', () => {
  const m = { at: 1, fadeIn: 2, fadeOut: 4 };
  assert.equal(musicEnvelope(m, 0.5, 20), 0);
  close(musicEnvelope(m, 2, 20), 0.5);
  assert.equal(musicEnvelope(m, 10, 20), 1);
  close(musicEnvelope(m, 18, 20), 0.5);
  assert.equal(musicEnvelope(m, 20, 20), 0);
  // 1 с музыки: оба затухания — по 1 с, друг на друге (afade за afade — множатся)
  close(musicEnvelope({ at: 19, fadeIn: 2, fadeOut: 4 }, 19.5, 20), 0.25);
  const curve = envelopeCurve(m, 1, 20, 10);
  assert.equal(curve.length, 191);
  close(curve[10], 0.5, 1e-6);
  assert.equal(curve.at(-1), 0);
});

test('music level: the track is brought to the voice (at most +12 dB), then Pavel\'s dB — as audio_graph', () => {
  assert.equal(musicGainDb(-14, -20), -8);
  assert.equal(musicGainDb(-14, -40), -14 + MUSIC_BOOST, 'тихий трек — не громче чем на 12 дБ');
  assert.equal(musicGainDb(-14, null), -14, 'не измерилась — без выравнивания');
});

test('track loudness: channel power summed (mono counts twice, as the engine spreads it) — about its LUFS; silence — null', () => {
  const sine = new Float32Array(48000).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  close(loudnessDb([sine, sine], 48000, 10) as number, -0.691 + 10 * Math.log10(0.25), 0.01);
  close(loudnessDb([sine], 48000, 10) as number, -0.691 + 10 * Math.log10(0.25), 0.01);
  const half = new Float32Array(96000);
  half.set(sine);
  close(loudnessDb([half], 48000, 1) as number, -0.691 + 10 * Math.log10(0.25), 0.01);
  assert.equal(loudnessDb([new Float32Array(1000)], 48000, 10), null);
  // с места трека: тихое вступление пропущено — меряется то, что звучит (как _loudness движка с -ss)
  const intro = new Float32Array(96000);
  intro.set(sine, 48000);
  close(loudnessDb([intro], 48000, 1, 1) as number, -0.691 + 10 * Math.log10(0.25), 0.01);
  assert.equal(loudnessDb([intro], 48000, 1, 0), null, 'тишина вступления');
});

test('levels: the voice as loud as the element can play (up to 1); a louder voice turns the rest down — the balance stays', () => {
  const up = levelsOf({ voice: { gainDb: 6 }, musicDb: -8 });
  assert.equal(up.voice, 1);
  close(up.music, dbToGain(-14));
  close(up.sound({ gainDb: 2 }), dbToGain(SFX_GAIN_DB + 2 - 6));
  const down = levelsOf({ voice: { gainDb: -6 }, musicDb: -8 });
  close(down.voice, dbToGain(-6));
  close(down.music, dbToGain(-8));
  assert.equal(levelsOf({ voice: { muted: true }, musicDb: -8 }).voice, 0);
  assert.equal(levelsOf({ musicDb: null }).music, 0, 'музыка без звука');
  assert.equal(levelsOf({ musicDb: -8 }).sound({ muted: true }), 0);
});

test('sounds from a moment: the coming ones wait, one still ringing plays on from its middle, muted ones never', () => {
  const sounds = [{ key: 'insert:0', t0: 1, file: 'a.wav' }, { key: 'teaser', t0: 3, file: 'b.wav' }, { key: 'end', t0: 9, file: 'a.wav' }];
  const plan = soundPlan(sounds, { end: { muted: true } }, 2.5, () => 2);
  assert.deepEqual(plan.map((p) => [p.key, p.when, p.offset]), [['insert:0', 0, 1.5], ['teaser', 0.5, 0]]);
  assert.deepEqual(soundPlan(sounds, {}, 5, () => 1).map((p) => p.key), ['end']);
});

test('what plays when (the schedule) — not how loud: a volume or mute change needs no restart of the music and sounds', () => {
  const music = { file: 'm.mp3', gainDb: -14, muted: false, at: 1, from: 0, fadeIn: 0.1, fadeOut: 1 };
  const sounds = [{ key: 'insert:0', t0: 2, file: 'pop.wav' }];
  const key = scheduleKey({ duration: 10, music, sounds });
  assert.equal(scheduleKey({ duration: 10, music: { ...music, gainDb: -30, muted: true }, sounds }), key);
  assert.notEqual(scheduleKey({ duration: 10, music: { ...music, at: 2 }, sounds }), key);
  assert.notEqual(scheduleKey({ duration: 10, music: { ...music, fadeOut: 3 }, sounds }), key);
  assert.notEqual(scheduleKey({ duration: 10, music, sounds: [{ ...sounds[0], t0: 3 }] }), key);
  assert.notEqual(scheduleKey({ duration: 12, music, sounds }), key);
  assert.notEqual(scheduleKey({ duration: 10, music: null, sounds }), key);
});
