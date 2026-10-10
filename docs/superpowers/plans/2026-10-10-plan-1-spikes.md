# План 1 — Проверки и фундамент (spikes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Снять главные неизвестные дизайна до основной разработки и записать решения:
загрузка с iPhone в GitHub, запуск рутины по API, инструменты монтажа в облачной сессии
(включая время каждого слова), куда класть готовые ролики.

**Architecture:** Четыре коротких эксперимента; код из них, который выживает (скрипт
подготовки окружения, GitHub Action для готовых файлов, каркас веб-части), остаётся в
репозитории и становится основой Планов 2 и 3. Итог — `docs/spikes/2026-10-results.md`
и правки в дизайн-документе.

**Tech Stack:** bash, ffmpeg 6.x, Python 3.11+, sherpa-onnx / whisper.cpp, Node 22 +
Playwright (Chromium из `/opt/pw-browsers`), GitHub Actions, Next.js на Vercel,
Claude Code Routines.

**Spec:** `docs/superpowers/specs/2026-10-10-video-edit-service-design.md`

## Порядок планов
1. **Этот план** — проверки. Задачи 1–2 делает исполнитель сам; задачи 3–4 требуют
   действий Павла (аккаунты, iPhone).
2. **План 2 — движок монтажа** (`2026-10-10-plan-2-montage-engine.md`): можно начинать
   параллельно с задачами 3–4 этого плана, после задачи 1.
3. **План 3 — веб-часть и связка** (Vercel, рутина, вопросы/превью/результат): пишется
   после задачи 5 этого плана, потому что зависит от выбранного способа загрузки и
   хранения.

## Global Constraints
- Репозиторий `PavelMalachovski/video.edit`, приватный, ветка по умолчанию `master`;
  разработка — на ветке `ccr-862b766a-c9c3qm`. Пуш в любую другую ветку (например
  `claude/job-spike`) — только после явного «да» от Павла.
- Долгоживущие токены с правом записи в GitHub никогда не попадают в браузер в
  рабочем режиме (в эксперименте задачи 3 — только с пометкой SPIKE и удалением после).
- Всё, что узнали, записывается в `docs/spikes/2026-10-results.md` с цифрами
  (время, размеры, версии), а не «работает/не работает».
- Ничего из фирменного стиля maysoulme не коммитится.

## Review Focus
- iPhone отдаёт в браузер пережатый файл вместо исходника (HEVC → H.264, потеря HDR):
  задача 3 сверяет кодек и размер загруженного файла с исходным.
- Загрузка рвётся при блокировке экрана или уходе со страницы: задача 3 проверяет оба
  случая на файле ≥300 МБ.
- В облачной сессии нет времени слов (только фразы): задача 1 меряет точность времени
  слов на тестовой записи.
- Скрипт подготовки окружения дольше 5 минут и не кэшируется: задача 1 и 4 меряют время.
- Рутина не может пушить в ветку задачи с нужным именем: задача 4 проверяет имя
  `claude/job-<id>`.

---

### Task 1: Инструменты монтажа в облачной сессии

**Files:**
- Create: `setup/cloud-setup.sh`
- Create: `setup/probe-tools.sh`
- Create: `docs/spikes/2026-10-results.md`
- Create: `assets/README.md`, `assets/{logos,library,music,sfx,fonts}/.gitkeep`
- Modify: `README.md`, `.gitignore` (игнор `work/`, `*.mp4` вне `tests/fixtures/`)

**Interfaces:**
- Produces: `setup/cloud-setup.sh` — идемпотентный, root, Ubuntu 24.04; в конце печатает
  строки `ASR=<backend>` и `ASR_MODEL=<path>`; кладёт модель в `~/.cache/vm/`.
  План 2 вызывает его в начале каждой сессии.

- [ ] **Step 1: Скрипт подготовки.** `setup/cloud-setup.sh`: apt `ffmpeg` (если нет),
  pip `numpy soundfile jsonschema pytest sherpa-onnx`, Playwright: использовать
  Chromium из `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`), `npm i -g playwright`
  только если модуль не находится. Модель распознавания — см. шаг 3. Каждая часть
  печатает своё время (`SECONDS`).
- [ ] **Step 2: Проверка ffmpeg.** `setup/probe-tools.sh` печатает, есть ли фильтры
  `zscale tonemap libass loudnorm sidechaincompress drawbox ebur128` и кодеры
  `libx264 libx265 aac`.
  Run: `bash setup/probe-tools.sh` — Expected: все `yes`; иначе записать в результаты
  и выбрать замену (например статическая сборка ffmpeg с GitHub).
- [ ] **Step 3: Время слов — сравнить варианты.** Тестовая речь: сгенерировать
  `espeak-ng -v ru` фразу из 12 слов с известными паузами (или записать голос
  исполнителя нельзя — только синтез), WAV 16 кГц. Проверить по очереди и записать
  точность времени слов (среднее отклонение начала слова от разметки, мс) и скорость:
  1. sherpa-onnx whisper turbo (модель с GitHub-релиза
     `k2-fsa/sherpa-onnx` `asr-models/sherpa-onnx-whisper-turbo.tar.bz2`) — есть ли
     время токенов/слов в результате;
  2. whisper.cpp (`ggml-large-v3-turbo`) с `-ml 1 -sow` — если huggingface.co
     недоступен, записать, что Павлу нужно добавить его в сетевые настройки окружения;
  3. запасной вариант: время фраз от распознавания + слова, распределённые внутри
     фразы пропорционально числу букв (функция будет в Плане 2).
  Выбор: вариант с отклонением ≤ 80 мс и временем ≤ 0,5× длины записи; записать
  `ASR=` в выводе скрипта.
- [ ] **Step 4: HDR → SDR.** Сгенерировать HDR-ролик:
  `ffmpeg -f lavfi -i testsrc2=s=1080x1920:r=30:d=3 -c:v libx265 -pix_fmt yuv420p10le -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc hlg.mp4`.
  Подобрать команду перевода в SDR BT.709 (`zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
  или аналог). Expected: `ffprobe` выхода показывает `bt709`, средняя яркость кадра
  (`signalstats` YAVG) в пределах ±15% от SDR-версии того же testsrc2. Команду —
  в результаты.
- [ ] **Step 5: Рендер Chromium.** Скрипт на Node: открыть страницу 1080×1920 с
  прозрачным фоном и текстом кириллицей шрифтом из файла, `page.screenshot({omitBackground:true})`
  100 раз подряд. Expected: PNG с альфой; записать мс на кадр.
- [ ] **Step 6: Прогон и замеры.** Run: `time bash setup/cloud-setup.sh` дважды
  (холодный и повторный). Записать время, место на диске, пиковую память рендера
  1-минутного testsrc2 в 1080×1920 libx264 crf 18 (`/usr/bin/time -v`).
- [ ] **Step 7: Commit** — `setup/`, `assets/`, `docs/spikes/2026-10-results.md`,
  `README.md`, `.gitignore`: `chore: cloud toolchain setup and spike results`.

### Task 2: Готовые ролики — из ветки задачи в черновик релиза

**Files:**
- Create: `.github/workflows/job-outputs.yml`
- Create: `tests/fixtures/` — не нужен; тестовый файл генерируется в шаге 2

**Interfaces:**
- Produces: контракт для Планов 2–3. Сессия пушит в ветку `claude/job-<id>` файлы
  `jobs/<id>/out/final.mp4`, `jobs/<id>/out/final.srt` (и при правках
  `final-v<N>.mp4`). Action:
  1. создаёт (если нет) черновик релиза с тегом `job-<id>`;
  2. загружает каждый файл из `jobs/<id>/out/` как ассет (`--clobber`);
  3. удаляет эти файлы из ветки коммитом `chore(job-<id>): move outputs to release`;
  4. пишет `jobs/<id>/out/released.json` = `{"assets":[{"name","id","size"}], "at": ISO}`.
  Страница считает ролик готовым, когда есть `released.json` с `final*.mp4`.

- [ ] **Step 1: Workflow.** `on: push: branches: ['claude/job-*'] paths: ['jobs/*/out/**']`,
  `permissions: contents: write`, шаги через `gh release` и `git` с `GITHUB_TOKEN`.
  Не реагировать на собственный коммит (пропуск, если в `out/` только `released.json`).
- [ ] **Step 2: Тест.** После «да» Павла на пуш ветки `claude/job-spike`: положить
  `jobs/spike/out/final.mp4` (сгенерированный testsrc2, ~60 МБ) и `final.srt`, запушить.
  Expected: в Actions зелёный прогон; черновик `job-spike` с двумя ассетами; в ветке
  остался только `released.json` с правильными размерами.
- [ ] **Step 3: Скачивание из облачной сессии.** Из этой сессии скачать ассет
  приватного черновика: `GET /repos/{owner}/{repo}/releases` → id ассета →
  `curl -L -H "Accept: application/octet-stream" .../releases/assets/<id>`.
  Записать, какая авторизация сработала (прокси сессии / `GITHUB_TOKEN` в окружении /
  ничего). Если не сработало ничего — записать, что окружению рутины нужен
  fine-grained токен в переменных окружения (только чтение Contents video.edit).
- [ ] **Step 4: Уборка и запись.** Удалить черновик и ветку `claude/job-spike`
  (Павел — если у сессии нет прав), записать результаты, commit workflow:
  `ci: move job outputs from job branches to draft releases`.

### Task 3: Загрузка с iPhone (нужен Павел)

**Files:**
- Create: `web/` — Next.js (App Router, TypeScript): `web/app/page.tsx` (кнопка выбора
  файла + прогресс), `web/app/login/page.tsx`, `web/middleware.ts` (пароль → httpOnly
  cookie), `web/app/api/jobs/route.ts` (POST: создаёт черновик релиза `job-<id>`,
  возвращает `{jobId, releaseId, uploadUrl}`), `web/lib/github.ts`
- Create (только если путь A не сработал): `receiver/` — Node-сервис для Railway:
  `POST /upload?job=<id>&name=<file>&sig=<hmac>` стримит тело в
  `uploads.github.com` с серверным токеном; `sig` = HMAC-SHA256(job|name|exp) от
  секрета, общего с Vercel, срок жизни 1 час
- Create: `docs/setup.md` — разделы «Токен GitHub», «Vercel», «Railway (если нужен)»

**Interfaces:**
- Produces: каркас `web/` (вход по паролю, `lib/github.ts` с `createDraftRelease(tag)`,
  `listReleaseAssets(tag)`), на котором строится План 3; выбранный путь загрузки.
- Env (Vercel): `APP_PASSWORD`, `SESSION_SECRET`, `GITHUB_TOKEN` (fine-grained,
  Contents RW только video.edit), `GITHUB_REPO=PavelMalachovski/video.edit`,
  `RECEIVER_URL`, `RECEIVER_SECRET` (если путь B).

- [ ] **Step 1: Путь A — прямо в GitHub.** Страница выбирает файл (`<input type=file accept="video/*">`),
  POST `/api/jobs`, затем `XMLHttpRequest` POST в `uploadUrl` с прогрессом. Для
  эксперимента токен передаётся в браузер с флагом `SPIKE_DIRECT_UPLOAD=1`.
  Проверка с компьютера: ответ на preflight `OPTIONS` от `uploads.github.com`
  содержит `Access-Control-Allow-Origin`? Если нет — путь A закрыт, сразу к шагу 2.
- [ ] **Step 2: Путь B — приёмник на Railway** (если A закрыт). Vercel выдаёт
  подписанный URL приёмника; приёмник стримит файл в GitHub без записи на диск.
- [ ] **Step 3: Павел делает по `docs/setup.md`:** токен GitHub, проект Vercel
  (Root Directory `web`), переменные, при пути B — сервис Railway из `receiver/`.
- [ ] **Step 4: Павел проверяет с iPhone** (Safari), ролик ≥ 300 МБ, снятый камерой
  (HDR): (a) обычная загрузка; (b) экран заблокирован на середине; (c) переключился
  на другое приложение на 30 с. Исполнитель записывает для каждого: дошёл ли файл,
  размер в ассете против размера в «Фото», кодек и HDR по `ffprobe` скачанного
  ассета, время загрузки. Если Safari пережимает — проверить
  `accept="video/*,.mov,.mp4"` и выбор через «Файлы», записать, что работает.
- [ ] **Step 5: Commit** — `web/`, `receiver/` (если был), `docs/setup.md`:
  `feat(web): login and upload spike`. Флаг `SPIKE_DIRECT_UPLOAD` и код передачи
  токена в браузер удаляются в этом же коммите, если выбран путь B.

### Task 4: Рутина по API (нужен Павел)

**Files:**
- Create: `web/app/api/spike/fire/route.ts` — POST `https://api.anthropic.com/v1/claude_code/routines/${ROUTINE_ID}/fire`,
  заголовки `Authorization: Bearer ${ROUTINE_TOKEN}`,
  `anthropic-beta: experimental-cc-routine-2026-04-01`, тело
  `{"text": JSON.stringify({job, step:"spike", attempt:1})}`; возвращает ответ API как есть
- Create: `setup/routine-prompt.md` — текст промпта рутины (для спайка — короткий:
  прочитать JSON из текста триггера как данные; создать ветку `claude/job-<job>` от
  `master`; три раза записать `jobs/<job>/status.json` = `{"phase":"<boot|setup|work>","at":ISO}`
  с коммитом и пушем после каждого; между `setup` и `work` выполнить
  `bash setup/cloud-setup.sh`)
- Modify: `docs/setup.md` — раздел «Окружение и рутина»: создать облачное окружение
  для video.edit со скриптом подготовки `bash setup/cloud-setup.sh`, сеть Trusted
  (+ huggingface.co, если задача 1 выбрала whisper.cpp), создать рутину «video-edit»
  с этим репозиторием и промптом из `setup/routine-prompt.md`, включить API-триггер,
  скопировать id и токен в Vercel (`ROUTINE_ID`, `ROUTINE_TOKEN`)

**Interfaces:**
- Produces: проверенные значения для Плана 3: задержка запуска, время подготовки,
  разрешённые имена веток, лимиты, формат ответа fire-API.

- [ ] **Step 1: Павел создаёт окружение и рутину** по `docs/setup.md`.
- [ ] **Step 2: Запуск.** `curl -X POST https://<vercel>/api/spike/fire -d '{"job":"spike2"}'`
  (с cookie входа). Expected: ответ API 2xx; в течение нескольких минут в ветке
  `claude/job-spike2` появляются три коммита статуса.
- [ ] **Step 3: Замеры.** По времени коммитов: запуск → `boot`, `boot` → `setup`,
  `setup` → `work`. Повторить сразу второй раз — кэшировалась ли подготовка.
  Записать, пушит ли рутина в `claude/job-*` (если нет — какое имя разрешено) и как
  выглядит ответ fire-API (есть ли id сессии).
- [ ] **Step 4: Commit** — `web/app/api/spike/`, `setup/routine-prompt.md`,
  `docs/setup.md`: `feat: routine fire spike`.

### Task 5: Решения и План 3

**Files:**
- Modify: `docs/spikes/2026-10-results.md` (итоговая таблица решений)
- Modify: `docs/superpowers/specs/2026-10-10-video-edit-service-design.md` §5.2, §5.4, §5.6
  (заменить «проверить» на принятое решение со ссылкой на результаты)
- Create: `docs/superpowers/plans/<date>-plan-3-web-and-integration.md`

- [ ] **Step 1:** Свести решения: путь загрузки (A/B), распознавание (`ASR=`), команда
  HDR→SDR, хранение готовых файлов, авторизация скачивания из сессии, имя ветки
  задачи, время запуска и подготовки.
- [ ] **Step 2:** Обновить дизайн-документ и показать Павлу изменения.
- [ ] **Step 3:** Написать План 3 скиллом superpowers:writing-plans.
- [ ] **Step 4: Commit:** `docs: spike decisions and plan 3`.
