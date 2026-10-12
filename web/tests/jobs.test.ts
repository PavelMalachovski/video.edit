import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  newJobId, partName, chunkCount, CHUNK_SIZE, jobTag, jobBranch, jobDir, chunkName, uploadAssetName, isUploadFile, resolveJobPath,
  imageType, audioType, audioPaths, checkSource, checkInsert, checkTotal, partsOf, verifyParts, MAX_SOURCE_BYTES, MAX_INSERT_BYTES,
  checkVoice, isVoiceFile, MAX_VOICE_BYTES, voiceAssetName, checkVideos, isSourceFile, MAX_VIDEOS, videoAsset, videoFile, checkSources,
} from '../lib/jobs.ts';

test('job id is UTC date-time plus 4 base36 chars', () => {
  const id = newJobId(new Date(Date.UTC(2026, 9, 10, 7, 5, 9)), () => 0.5);
  assert.match(id, /^261010-070509-[0-9a-z]{4}$/);
  assert.equal(jobTag(id), `job-${id}`);
});

test('part names are zero-padded and sort in order', () => {
  assert.equal(partName(0), 'source.part-00000');
  assert.equal(partName(123), 'source.part-00123');
  const names = [10, 2, 1].map(partName).sort();
  assert.deepEqual(names, ['source.part-00001', 'source.part-00002', 'source.part-00010']);
});

test('chunk size fits under the Vercel 4.5 MB body limit', () => {
  assert.ok(CHUNK_SIZE <= 4 * 1024 * 1024);
  assert.equal(chunkCount(0), 0);
  assert.equal(chunkCount(1), 1);
  assert.equal(chunkCount(CHUNK_SIZE), 1);
  assert.equal(chunkCount(CHUNK_SIZE + 1), 2);
});

test('chunk names keep source.part-NNNNN and add <file>.part-NNNNN', () => {
  assert.equal(chunkName('source', 3), 'source.part-00003');
  assert.equal(partName(3), chunkName('source', 3));
  assert.equal(chunkName('upload-i2.mov', 12), 'upload-i2.mov.part-00012');
  assert.equal(jobBranch('261010-070509-abcd'), 'claude/job-261010-070509-abcd');
  assert.equal(jobDir('261010-070509-abcd'), 'jobs/261010-070509-abcd');
});

test('upload asset names are ASCII', () => {
  const names = [
    uploadAssetName('i', 2, 'демо.MOV', 'video/quicktime'),
    uploadAssetName('q', 'hook', 'logo.PNG', 'image/png'),
    uploadAssetName('q', 'Вставка 1', 'a.jpg', 'image/jpeg'),
    uploadAssetName('i', 1, 'без расширения', 'image/webp'),
    uploadAssetName('i', 3, 'странное.слишкомдлинное', 'application/x-unknown'),
  ];
  assert.equal(names[0], 'upload-i2.mov');
  assert.equal(names[1], 'upload-q-hook.png');
  assert.match(names[2], /^upload-q-x[0-9a-f]{8}\.jpg$/);
  assert.equal(uploadAssetName('q', 'Вставка 1', 'b.jpg', 'image/jpeg'), names[2]);
  assert.equal(names[3], 'upload-i1.webp');
  assert.equal(names[4], 'upload-i3.bin');
  for (const n of names) assert.ok(isUploadFile(n), n);
  assert.ok(!isUploadFile('source.part-00000') && !isUploadFile('upload-q-../x.png'));
});

test('resolveJobPath stays inside the job folder or assets/', () => {
  const id = '261010-070509-abcd';
  assert.equal(resolveJobPath(id, 'frame.png'), `jobs/${id}/frame.png`);
  assert.equal(resolveJobPath(id, 'look/../frame.png'), `jobs/${id}/frame.png`);
  assert.equal(resolveJobPath(id, '../../assets/logos/a.png'), 'assets/logos/a.png');
  for (const bad of ['../../engine/vm/job.py', '/etc/passwd', 'a\\b', '..', '../other/x.png', '']) {
    assert.equal(resolveJobPath(id, bad), null, bad);
  }
});

test('only raster images are served', () => {
  assert.equal(imageType('a.svg'), null);
  assert.equal(imageType('page.html'), null);
  assert.equal(imageType('F.PNG'), 'image/png');
  assert.equal(imageType('q-logo.jpg'), 'image/jpeg');
  assert.equal(imageType('x.webp'), 'image/webp');
});

test('sound for the editor: the engine\'s sound types, from the job folder, else from assets/ (as render finds it)', () => {
  assert.equal(audioType('assets/music/a.MP3'), 'audio/mpeg');
  assert.equal(audioType('x.m4a'), 'audio/mp4');
  assert.equal(audioType('x.wav'), 'audio/wav');
  assert.equal(audioType('x.ogg'), 'audio/ogg');
  assert.equal(audioType('x.flac'), 'audio/flac');
  assert.equal(audioType('x.aac'), 'audio/aac');
  for (const bad of ['x.mp4', 'page.html', 'a.svg', 'mp3']) assert.equal(audioType(bad), null, bad);
  // те же расширения, что SOUNDS движка (render.py)
  const sounds = /^SOUNDS = \{([^}]*)\}/m.exec(readFileSync(new URL('../../engine/vm/render.py', import.meta.url), 'utf8'))?.[1] ?? '';
  const engine = sounds.split(',').map((x) => x.trim().replace(/^"\.|"$/g, '')).filter(Boolean).sort();
  assert.deepEqual(engine, ['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']);
  for (const ext of engine) assert.ok(audioType(`a.${ext}`), ext);

  const id = '261010-070509-abcd';
  assert.deepEqual(audioPaths(id, 'assets/music/a.mp3'), [`jobs/${id}/assets/music/a.mp3`, 'assets/music/a.mp3']);
  assert.deepEqual(audioPaths(id, 'in/uploads/upload-voice.m4a'), [`jobs/${id}/in/uploads/upload-voice.m4a`]);
  assert.deepEqual(audioPaths(id, './assets/sfx/../sfx/pop.wav'), [`jobs/${id}/assets/sfx/pop.wav`, 'assets/sfx/pop.wav']);
  // выше папки задачи (как и выше репозитория) движок звук не берёт — и страница не отдаёт
  for (const bad of ['../../assets/sfx/pop.wav', '../../engine/x.mp3', '/etc/a.mp3', 'a\\b.mp3', 'https://x/a.mp3', '']) {
    assert.deepEqual(audioPaths(id, bad), [], bad);
  }
});

test('size and type limits', () => {
  assert.match(checkSource(MAX_SOURCE_BYTES + 1) ?? '', /3 ГБ/);
  assert.equal(checkSource(MAX_SOURCE_BYTES), null);
  assert.match(checkInsert({ name: 'IMG.HEIC', size: 10, type: 'image/heic' }) ?? '', /HEIC/);
  assert.match(checkInsert({ name: 'big.mp4', size: MAX_INSERT_BYTES + 1, type: 'video/mp4' }) ?? '', /big\.mp4: больше 200 МБ/);
  assert.match(checkInsert({ name: 'a.pdf', size: 10, type: 'application/pdf' }) ?? '', /тип не подходит/);
  assert.equal(checkInsert({ name: 'ok.mp4', size: 5 * 1024 ** 2, type: 'video/mp4' }), null);
});

test('empty files are refused before upload', () => {
  assert.match(checkSource(0) ?? '', /пустой/);
  assert.match(checkInsert({ name: 'a.png', size: 0, type: 'image/png' }) ?? '', /a\.png: пустой файл/);
});

test('source and inserts together stay under 1000 release assets', () => {
  assert.match(checkTotal(3 * 1024 ** 3, Array(10).fill(200 * 1024 ** 2)) ?? '', /3,5 ГБ/);
  assert.equal(checkTotal(3 * 1024 ** 3, [200 * 1024 ** 2, 200 * 1024 ** 2]), null);
  assert.equal(partsOf(0), 1);
  assert.equal(partsOf(CHUNK_SIZE + 1), 2);
});

test('verifyParts reports missing parts and size mismatch', () => {
  const assets = [{ name: 'source.part-00000', size: 4 }, { name: 'source.part-00002', size: 3 }, { name: 'upload-i1.png.part-00000', size: 9 }];
  assert.deepEqual(verifyParts(assets, 'source', 3, 11), { missing: [1], total: 7 });
  assert.deepEqual(verifyParts(assets, 'upload-i1.png', 1, 9), { missing: [], total: 9 });
});


test('a voiceover is one audio file up to 200 MB under its own asset name', () => {
  assert.equal(voiceAssetName('Запись 12.M4A', 'audio/x-m4a'), 'upload-voice.m4a');
  assert.equal(voiceAssetName('voice', 'audio/mpeg'), 'upload-voice.mp3');
  assert.equal(voiceAssetName('take.wav', 'audio/wav', 2), 'upload-voice-2.wav');
  for (const n of ['upload-voice.m4a', 'upload-voice-2.wav', 'upload-voice.aac']) assert.ok(isUploadFile(n) && isVoiceFile(n), n);
  for (const n of ['upload-i1.png', 'upload-voice.exe', 'upload-voice-x.mp3']) assert.ok(!isVoiceFile(n), n);
  assert.equal(checkVoice({ name: 'Запись.m4a', size: 5 * 1024 ** 2, type: 'audio/x-m4a' }), null);
  assert.equal(checkVoice({ name: 'take.mp3', size: 5, type: '' }), null, 'тип браузер не знает — по расширению');
  assert.equal(checkVoice({ name: 'voice', size: 5, type: 'audio/aac' }), null);
  assert.match(checkVoice({ name: 'clip.mov', size: 5, type: 'video/quicktime' }) ?? '', /clip\.mov: нужна запись голоса — M4A, MP3, WAV или AAC/);
  assert.match(checkVoice({ name: 'big.wav', size: MAX_VOICE_BYTES + 1, type: 'audio/wav' }) ?? '', /big\.wav: больше 200 МБ/);
  assert.match(checkVoice({ name: 'e.m4a', size: 0, type: 'audio/mp4' }) ?? '', /e\.m4a: пустой файл/);
});

test('the videos of a job: source, source-2 … source-10, in that order; vm fetch puts each into in/ by its extension', () => {
  assert.equal(MAX_VIDEOS, 10);
  assert.deepEqual(Array.from({ length: MAX_VIDEOS }, (_, k) => videoAsset(k)), ['source', ...Array.from({ length: 9 }, (_, k) => `source-${k + 2}`)]);
  for (const ok of ['source', 'source-2', 'source-10']) assert.ok(isSourceFile(ok), ok);
  for (const bad of ['source-1', 'source-11', 'source-0', 'source-02', 'source2', 'upload-i1.png', '../source', 'source.mov']) assert.ok(!isSourceFile(bad), bad);
  // как Path(name).suffix.lower() движка (fetch.py), без расширения — .mp4
  assert.equal(videoFile('source', 'IMG_1.MOV'), 'in/source.mov');
  assert.equal(videoFile('source-2', 'clip.v2.Mp4'), 'in/source-2.mp4');
  assert.equal(videoFile('source-3', 'без расширения'), 'in/source-3.mp4');
  assert.equal(videoFile('source-4', '.mov'), 'in/source-4.mp4', 'скрытый файл — без расширения');
  assert.equal(videoFile('source-5', 'a.'), 'in/source-5.mp4');
});

test('the videos the page reports: the first is the top-level one, then source-2…; sizes and parts add up', () => {
  const top = { name: 'a.mov', size: 10, type: 'video/quicktime', lastModified: 1, parts: 1 };
  const two = [
    { asset: 'source', name: 'a.mov', size: 10, type: 'video/quicktime', lastModified: 1, parts: 1, duration: 3.5 },
    { asset: 'source-2', name: 'b.mp4', size: CHUNK_SIZE + 1, type: 'video/mp4', lastModified: 2, parts: 2, duration: null },
  ];
  assert.deepEqual(checkVideos(undefined, top), { videos: null }, 'одно видео — без списка, как раньше');
  assert.deepEqual(checkVideos(two, top), { videos: two });
  const bad: [unknown, string][] = [
    ['source', 'не список'],
    [[two[0]], 'одно видео — без списка'],
    [[two[1], two[0]], 'первое — не source'],
    [[two[0], { ...two[1], asset: 'source-3' }], 'пропуск номера'],
    [[{ ...two[0], name: 'другое.mov' }, two[1]], 'первое — не то, что сверху'],
    [[two[0], { ...two[1], size: 0 }], 'пустое видео'],
    [[two[0], { ...two[1], parts: 1 }], 'кусков меньше, чем по размеру'],
    [[two[0], { ...two[1], name: 7 }], 'имя — не текст'],
    [[two[0], { ...two[1], duration: -1 }], 'длительность'],
    [Array.from({ length: MAX_VIDEOS + 1 }, (_, k) => ({ ...two[0], asset: videoAsset(k) })), 'больше десяти'],
  ];
  for (const [videos, why] of bad) assert.ok('error' in checkVideos(videos, top), why);
});

test('several videos: each one as a single video, together under 3 GB, no more than ten', () => {
  assert.equal(checkSources([10, 20]), null);
  assert.equal(checkSources([MAX_SOURCE_BYTES]), null, 'одно видео — как раньше');
  assert.match(checkSources([10, 0]) ?? '', /пустой/);
  assert.match(checkSources([MAX_SOURCE_BYTES / 2, MAX_SOURCE_BYTES / 2 + 1]) ?? '', /вместе больше 3 ГБ/);
  assert.match(checkSources(Array.from({ length: MAX_VIDEOS + 1 }, () => 10)) ?? '', /Не больше 10 видео/);
});
