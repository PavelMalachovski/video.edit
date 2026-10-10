# Сквозной прогон: сессия играет роль рутины

Как проверить `SKILL.md` и движок целиком без страницы и без рутины: сессия сама проходит шаги `analyze`,
(ответы за Павла), `render` и `fix` по `.claude/skills/video-montage/SKILL.md` на сгенерированном видео.
Так сделано в задаче 14 Плана 2 (2026-10-10); что тогда нашлось — внизу.

## 1. Фикстура

Речь — espeak-ng по фразам с паузами, картинка — testsrc2 1080×1920; логотип и тихая музыка — для вопросов о
вставке и музыке. В тексте — повтор (для вырезки), «сюда добавь…» (вопрос о вставке), «денежные» слова
(звёздочки) и призыв с кодовым словом (титр).

```bash
D=/tmp/dryrun && mkdir -p $D/speech && cd $D
python3 - <<'PY'
import subprocess, numpy as np, soundfile as sf
sentences = [("Сегодня покажу, как я монтирую ролики за десять минут.", 0.9),
             ("Я снимаю, я снимаю всё на айфон, без штатива.", 2.2),
             ("Сюда добавь мой логотип.", 0.9),
             ("Обычно монтажёр стоит пять тысяч рублей.", 0.8),
             ("А этот способ почти бесплатный.", 0.9),
             ("Главное — убрать паузы и оставить только смысл.", 1.0),
             ("Пишите мне слово монтаж, и я пришлю подробный гайд.", 0.0)]
rate, pieces = 48000, [np.zeros(int(0.6 * 48000), "float32")]
for i, (text, gap) in enumerate(sentences):
    subprocess.run(["espeak-ng", "-v", "ru", "-s", "150", "-w", f"speech/s{i}.wav", text], check=True)
    audio, sr = sf.read(f"speech/s{i}.wav", dtype="float32")
    idx = np.round(np.arange(0, len(audio), sr / rate)).astype(int)
    pieces += [audio[idx[idx < len(audio)]], np.zeros(int(gap * rate), "float32")]
sf.write("voice.wav", np.concatenate(pieces + [np.zeros(int(0.8 * rate), "float32")]), rate)
PY
DUR=$(python3 -c "import soundfile as sf; i=sf.info('voice.wav'); print(i.frames/i.samplerate)")
ffmpeg -y -f lavfi -i "testsrc2=s=1080x1920:r=30:d=$DUR" -i voice.wav -c:v libx264 -preset ultrafast \
  -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -shortest source-upload.mp4
ffmpeg -y -f lavfi -i "color=c=0x1E88E5:s=600x600:d=1,drawbox=x=150:y=150:w=300:h=300:color=0xFFD23F:t=fill" \
  -frames:v 1 test-logo.png
ffmpeg -y -f lavfi -i "sine=f=330:d=20,volume=0.3" -c:a libmp3lame -q:a 6 test.mp3
```

## 2. Песочница вместо GitHub

`vm push` коммитит и пушит папку задачи — пусть пушит в локальный «origin», а не в GitHub. Черновика релиза в
песочнице нет, поэтому `vm fetch` пропускается: видео кладётся в `in/` руками (как его положил бы fetch).

```bash
cd $D && git init -q --bare -b master origin.git
git -C <репозиторий video.edit> push -q $D/origin.git HEAD:refs/heads/master
git clone -q origin.git repo && cd repo
mkdir -p assets/logos assets/music && cp ../test-logo.png assets/logos/ && cp ../test.mp3 assets/music/
git add assets && git commit -qm "test assets" && git push -q origin master
JOB=261010-180700-dry1 && git checkout -qb claude/job-$JOB
mkdir -p jobs/$JOB/in && cp ../source-upload.mp4 jobs/$JOB/in/source.mp4
# job.json — как его пишет страница: brief «… МУЗЫКА: спокойная. Кодовое слово — монтаж.», uploads [], runs
PYTHONPATH=engine python3 -m vm status jobs/$JOB --state queued --phase "Запускаю сессию" --message "…"
git add jobs && git commit -qm "web($JOB): analyze #1" && git push -qu origin claude/job-$JOB
```

## 3. Шаги

1. **analyze** — по SKILL.md: `prepare --status`, сводка, `frames --grid`, черновик `edit.json` скриптом,
   `questions.json` (`cut`, `hook`, `insert-1` с картинкой `vm preview --out q-insert-1.jpg --mark …`, `stars`,
   `hold`; музыку и кодовое слово ТЗ уже назвало — о них не спрашивать), `preview`, `styles.json`, `validate`,
   статус `waiting_answers` и `push`.
2. **Ответы за Павла** — `answers.json`, как пишет страница (вариант B, свои шрифты и цвет), статус `queued`,
   коммит `web(<job>): render #1`.
3. **render** — в *свежем клоне* ветки задачи (как новая сессия: `source.mp4`, `look/`, `work/` нет): видео в
   `in/`, `prepare --status --state rendering` (восстанавливает исходник, речь заново не распознаёт), ответы →
   `edit.json`, `check` до чистой геометрии, `render --status`, `result.json`, статус `rendered`,
   `push --outputs`.
4. **fix** — `fix.json` с правкой и `version: 2`, `render --version 2`.

Ожидается: `validate` чист на каждом шаге; `check` и `render` — «всё в порядке»; в коммитах только файлы задачи
(без `in/`, `look/`, `sheet.png`, `qa/qa-*.png`, `source.mp4`).

## 4. Что нашёл прогон 2026-10-10 (исправлено)

- GigaAM на 30 с синтетической речи с паузами молчал (0 слов), с 18 с терял целые фразы; Whisper слышал всё.
  Живая речь (ролик Павла 4:25) — без потерь. Теперь кусок с малым числом слов на секунду речи перераспознаётся
  по фразам VAD (`asr.transcribe`), а сводка `prepare` предупреждает о речи без слов.
- Мягкая резка опиралась только на слова: нераспознанную фразу она вырезала бы как паузу. Теперь `plan_keep`
  получает речь по VAD (`speech.json`) и внутри неё не режет.
- Кадр «титр» на контрольном листе брался из промежутка в один кадр — теперь из первого не короче 0,1 с.
- Пометку «нет звуков вставок» стирал следующий рендер — теперь её пишет сам рендер.

Замеры (облачная сессия, 4 vCPU): `prepare` 30 с видео — 32 с (распознавание с перераспознаванием), повторный
`prepare` в новой сессии — 7 с; `check` — 7 с; `render` ролика 19 с — 23 с. Настоящий ролик Павла 4:25 (4K HEVC):
`fetch` 51 с, нормализация 7,8 мин в veryfast, в ultrafast по замеру на 20-секундном куске — ~5,5 мин,
GigaAM ~32 с, Whisper ~3 мин.
