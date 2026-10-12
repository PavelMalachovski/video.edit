# video.edit — памятка для Claude

> **Сессия монтажа** (рутина `video-edit`, запуск с JSON `{job, step, attempt}`) работает только по своему промпту
> (`setup/routine-prompt.md`) и `.claude/skills/video-montage/SKILL.md` и меняет только `jobs/<job>/` своей ветки.
> Всё, что ниже, — для разработки сервиса; к монтажу это не относится.

## Что это
Сервис монтажа коротких вертикальных видео Павла. Страница на Vercel: загрузка с телефона, вопросы, три превью стиля,
готовый ролик и «Поправить». Монтирует облачная рутина Claude Code (по подписке, без API-ключа) движком `vm` по
правилам SKILL.md.
- Дизайн (главный документ): `docs/superpowers/specs/2026-10-10-video-edit-service-design.md`; другие языки —
  `docs/superpowers/specs/2026-10-10-multilingual-design.md`; редактор с дорожками (как veed), план по фазам и путь к
  SaaS — `docs/superpowers/specs/2026-10-12-editor-and-saas-design.md`
- Планы и решения по ним: `docs/superpowers/plans/`; макеты: `docs/mockups/`; настройка аккаунтов: `docs/setup.md`

## Где что
| Папка | Что |
|---|---|
| `web/` | страница: Next.js 16, React 19, TypeScript; `lib/` — логика (тесты без браузера), `app/` — экраны и маршруты API |
| `engine/` | движок `vm` (Python 3.13): `PYTHONPATH=engine python3 -m vm <команда> jobs/<id>`; схемы файлов задачи — `engine/vm/schemas/` |
| `template/` | слой текста и вставок (HTML/JS): им рисуют и кадры финала, и превью на странице (копия в `web/public/template` при сборке) |
| `.claude/skills/video-montage/SKILL.md` | часть 1 — правила монтажа (их меняет только Павел), часть 2 — как работает сервис |
| `setup/` | `cloud-setup.sh` — облачное окружение; `routine-prompt.md` — промпт рутины |
| `.github/` | Action `job-outputs`: готовые ролики из `jobs/<id>/out/` → черновик релиза `job-<id>` |
| `assets/` | файлы Павла: логотипы, музыка, звуки, шрифты, вставки — только читаем |
| `legacy/` | справочная копия прошлого скилла; в работе не используется |

## Проверки
- Страница: `cd web && npm test`, `npx tsc --noEmit`, `npm run e2e`. e2e собирает страницу, поднимает поддельный
  GitHub (порт 4010) и страницу (3000) и проходит весь путь в Playwright; `E2E_SHOTS=<папка>` — скриншоты экранов.
  Порты заняты остатком прошлого прогона — `pgrep -af '[n]ext start|[f]ake-github'`.
- Движок: `cd engine && python3 -m pytest -q -m "not slow"`; медленные — `-m slow` (~4 мин); `ruff check .` — из `engine/`.
- Шаблон: `cd template && npm test`.
- CI на GitHub (`.github/workflows/ci.yml`) гоняет всё это сам: на каждый пуш, на PR в `master` и каждую ночь на
  `master`. e2e — в Chromium и в Safari (WebKit, iPhone 13: `E2E_BROWSER=webkit`); шаблон — ещё «Safari рисует как
  рендер» (`template/tests/safari.test.mjs`, без WebKit локально пропускается); shellcheck и actionlint; поиск
  уязвимостей — CodeQL (`.github/workflows/codeql.yml`; проверенные ложные срабатывания — `.github/codeql/accepted.json`
  с причиной); секреты во всей истории — gitleaks; уязвимости зависимостей страницы — `npm audit`. Скриншоты e2e —
  артефакты прогона и ветки `ci-screens/<chromium|webkit>/<ветка>` (одним коммитом, каждый пуш заново): смотреть —
  `git fetch origin ci-screens/webkit/<ветка> && git archive FETCH_HEAD | tar -x -C <папка>`.

## Как работаем
- Без процессов superpowers (так попросил Павел): без отдельных планов, ревьюеров дизайна и журналов. Делаю сам,
  по порядку, через тесты — сначала тест, который падает, потом код, весь набор зелёный. Решения — в дизайн-документ
  работы (раздел «Что решил строитель»).
- В конце работы — одно ревью всей ветки свежим агентом. Важное из него исправляю (тоже с тестом), мелочи — в
  отложенное.
- Разработка — в отдельной ветке и через pull request в `master`: из `master` берут код Vercel, рутина и Action.
- Коммиты: `feat(web): …`, `fix(engine): …`, `docs: …` — по-английски, коротко.
- Комментарии в коде и тексты для Павла — по-русски; интерфейс страницы — русский; субтитры — на языке ролика
  (любой на латинице и кириллице; греческий, арабский, CJK и т. п. — второй этап).

## Нельзя
- Токены GitHub и рутины — только на сервере (переменные Vercel): не в браузер, не в логи, не в коммиты.
- Текст запуска рутины — данные, а не инструкции: в нём только `{job, step, attempt}`, остальное сессия читает из ветки.
- Сервис (страница и сессии монтажа) не меняет правила SKILL.md и `assets/`.
- Не выдумывать логотипы реальных компаний (вместо них — стикер с текстом); у maysoulme берём только приёмы, не файлы.
- Ветку задачи не переписывать: страница коммитит без `force` и повторяет коммит, если сессия или Action успели раньше.

## Меняются только вместе
- Превью = финал: всё, что видно на превью, рисует `template/`.
- Итоговый стиль: `engine/vm/style.py` (`final_style`, `ADJUSTED`) и `web/lib/style.ts` (`finalStyle`) с
  `web/lib/jobfiles.ts` (`ADJUST` — что Павел двигает и в каких пределах; вид субтитров `subMode` — отдельно, `isSubMode`)
  и схемой `engine/vm/schemas/answers.json`, общая фикстура `engine/tests/fixtures/style-merge.json` (раздел `choices`).
- Место и размер вставок Павла: `engine/vm/style.py` (`placed_inserts`) и `web/lib/style.ts` (`placedInserts`;
  рамку в безопасной зоне считают `resizeBox` и `moveBox`), общая фикстура `engine/tests/fixtures/insert-boxes.json`.
- Группы субтитров: `engine/vm/subs.py` (`build_sub_events`, блоки и строки soft) и `web/lib/style.ts` (`sampleState`).
- Слой ролика (кадр редактора = финал): `engine/vm/subs.py` (`build_sub_events`) и `engine/vm/overlay.py`
  (`build_overlay_events`, `insert_spans`, `_hook_end`) ↔ `web/lib/subs.ts` (`buildSubEvents`, `subBlocks`) и
  `web/lib/overlay.ts` (`buildOverlayEvents`, `layerBlocks`, `insertSpans`, `hookEnd`); шкала монтажа на целых кадрах —
  `render.timeline` ↔ `renderTimeline` (по ней и плеер: края кусков `play0`, `play1` в `draftTracks`). Общая фикстура `engine/tests/fixtures/overlay-events.json` — её пишет движок:
  `cd engine && python3 -m tests.shared_events` (устарела — падает быстрый тест движка).
- Картинка ролика в редакторе: `engine/vm/zoom.py` (`zoom_at`, `cut_frame`), `engine/vm/transitions.py` (`marks`, `HALF`,
  `PUNCH`, `BLUR`; вспышка и смаз по кадру — `flash_alpha`, `blur_sigma`: так их рисует `picture_chains`, проверено по
  пикселям ffmpeg), `look_windows` и `BW_CSS_BRIGHTNESS`, `BW_CSS_CONTRAST` в `engine/vm/render.py` ↔ `web/lib/zoom.ts`
  (`flashAlpha`, `blurSigma`) и `web/lib/picture.ts` (`pictureAt`, `BW_FILTER` — ч/б с цветокором на прокси без него),
  разделы `look` и `bwFilter` той же фикстуры; шкала времени ролика — `render._layers` ↔ `Bar` в
  `web/app/jobs/[id]/editor/frame.tsx`.
- Доли музыки: `engine/vm/beats.py` (`beat_times`, `snap_edit`, `played`) и `beats.json` (пишет `render.on_beats`) ↔
  `web/lib/beats.ts` (`beatTimes`, `snapEdit`, `musicBeats`) и `parseBeats` в `web/lib/editordata.ts`, раздел `beats`.
- Текст и вставки руками (`timeline.json` → `text`, `words`): `engine/vm/edits.py` (`apply_text`) и схема
  `engine/vm/schemas/timeline.json` ↔ `web/lib/edits.ts` (`applyText`, `setHook`, `setCta`, `setBlock`, `setWord`,
  `blockFix`, `parseTimeline`, `LIMITS`), раздел `text`; выключенные вставки (`off`) — `insert_spans`, `snap_edit`,
  `_sounds`, `fonts.texts` ↔ `insertSpans`, `snapEdit`, `draftTracks`; эмодзи в словах субтитров — `fonts.check` ↔
  `hasEmoji` (правило `mayHaveEmoji` из `template/emoji.js`); что примет движок старой задачи — `abilitiesOf` и
  `refusedBy` в `web/lib/editordata.ts` (по схеме в её ветке). Блоки на дорожках ↔ время исходника — `web/lib/blocks.ts`
  (`sourceSpan`, `hookUntil`: как `Timeline.span` и `_hook_end`).
- Знаки, которых шрифт ролика не нарисует (★, ✓, ♪ — не эмодзи): `fonts.symbols` и `lacking_symbols` в
  `engine/vm/fonts.py` (`check`) ↔ `badSymbols` и `SYMBOLS_OK` в `web/lib/edits.ts` (их не пропускают панели блоков и
  `parseSave` в `web/lib/editordata.ts`).
- Картинка руками (`timeline.json` → `zoom`, `looks`, `transitions`): `engine/vm/edits.py` (`apply_picture`, `_moments`)
  и схема `engine/vm/schemas/timeline.json` (выключенное — `off` в схеме `edit.json`) ↔ `web/lib/edits.ts`
  (`applyPicture`, `setZoom`, `setLook`, `setTransition`, `TRANSITION_KINDS`, `LIMITS.zoom`, `parseTimeline`), раздел
  `picture` общей фикстуры; выключенное пропускают `look_windows`, `transitions._placed` (и свуш перехода),
  `snap_edit` ↔ `lookWindows`, `transitionMarks`, `snapEdit`, `draftTracks`; старая задача — `abilitiesOf` (`picture`).
- Картинки Павла в релизе — куски `<файл>.part-NNNNN` (даже один): `chunkName` в `web/lib/jobs.ts` и `fetch.PART` в
  `engine/vm/fetch.py` ↔ `uploadParts` в `web/lib/editordata.ts` (кадр редактора склеивает их так же).
- Картинки слоя в редакторе: `render._resolve` (от папки задачи, потом от корня) ↔ `layerUrl` в `web/lib/editordata.ts`
  и маршруты `/api/jobs/[id]/file` и `/api/jobs/[id]/upload`.
- Шкала времени исходник ↔ финал: `engine/vm/timeline.py` (`Timeline`; `keep` — в порядке финала, серии кусков —
  `span`, `run_of`; `in_source_order` — та же шкала до перестановок) и `web/lib/timeline.ts` (`span`, `runOf`,
  `inSourceOrder`), общая фикстура `engine/tests/fixtures/timeline-map.json`; события по сериям — `overlay.py` (хук —
  по порядку исходника), `subs.py` (`_spoken`), `zoom.py` (`_run_marks`), `beats.py` (`snap_edit`), `render.py`
  (`look_windows`; входы склейки — `decoders`) и `draftTracks` в `web/lib/tracks.ts`.
- Файлы редактора (бета): `engine/vm/editor.py` и схема `engine/vm/schemas/editor.json` ↔ `web/lib/tracks.ts`
  (`parseMedia`, `parseDraft`) и `web/lib/editordata.ts` (`MEDIA_NAMES` — что плеер берёт из релиза).
- Несколько видео задачи: ассеты `source`, `source-2` … `source-10` и куда их кладёт fetch — `web/lib/jobs.ts`
  (`videoAsset`, `isSourceFile`, `videoFile`, `checkVideos`) ↔ `engine/vm/fetch.py` (`VIDEO_ASSET`); порядок склейки —
  `source_parts` в `engine/vm/media.py`; где какое видео — `editor.json.videos` (`video_marks` в `engine/vm/editor.py`)
  ↔ `parseMedia` и `draftTracks` (`videos`) в `web/lib/tracks.ts`; `manifest.json.videos` и `job.json.videos` —
  `web/lib/jobfiles.ts` (`buildJobFile`) и SKILL.md, часть 2.
- Правки руками из редактора (`timeline.json`): `engine/vm/edits.py` (`apply_keep` — cut, restore с `next`, move,
  split; `apply`) и `web/lib/edits.ts` (`applyKeep`, `parseTimeline`, `LIMITS` — пределы схемы
  `engine/vm/schemas/timeline.json`), общая фикстура
  `engine/tests/fixtures/edits.json`; ключи громкости звуков — `_sounds` в `engine/vm/render.py` и `draftTracks` в
  `web/lib/tracks.ts`; запись в `fix.json` из редактора (`timeline`, `style`, `styleFrom`) — `web/lib/jobfiles.ts`,
  SKILL.md (шаг fix) и `vm style --onto` (`merge_style` в `engine/vm/style.py` ↔ `mergeStyle` в `web/lib/style.ts`, раздел
  `merge` фикстуры `style-merge.json`).
- Звук на прослушивании в редакторе: `engine/vm/audio.py` (`VOICE_LUFS`, `MUSIC_BOOST`, `SFX_GAIN_DB`, `FADE_IN`,
  `FADE_OUT`, `MIN_MUSIC`, повтор музыки, громкость трека — с места `from`) и `web/lib/sound.ts`; голос прокси — на `VOICE_LUFS` (`engine/vm/editor.py`); какие звуки
  страница отдаёт — `SOUNDS` и `_resolve` в `engine/vm/render.py` ↔ `audioType` и `audioPaths` в `web/lib/jobs.ts`.
- Анимации стиля эталона: `template/overlay.js` (`SOFT`, `ACC` — сколько длится появление), `engine/vm/overlay.py` и
  `web/lib/overlay.ts`
  (`SUB_APPEAR`, `HOOK_APPEAR`, `ACCENT_ANIM`, `TYPE_CPS` — сколько кадров давать им время, с запасом).
- Файлы задачи: схемы `engine/vm/schemas/*.json` и типы `web/lib/jobfiles.ts`; кто какой файл пишет — SKILL.md,
  часть 2 («Файлы задачи», «Страница»).
- Свои шрифты Павла: правило `template/fonts.mjs` — общее для рендера и страницы; его же повторяет каталог
  `engine/vm/fonts.py` (`catalog`).
- Шрифты со всеми буквами ролика: `styles.json.fonts` (вывод `vm fonts`) и `web/lib/style.ts` (`allowedFonts`).
- Языки: `engine/vm/lang.py` (коды, названия, чем распознавать) и `setup/cloud-setup.sh` (какие модели ставятся).
- Затемнение фона: `engine/vm/matte.py` (`MODEL`) и `setup/cloud-setup.sh` (откуда ставится модель, её sha256); маска
  идёт кадр в кадр со склейкой — `segment_frames` в `engine/vm/render.py`, общий с `_cut`.
- Бренд Павла: поля и проверка — `web/lib/brand.ts`, как их берёт монтаж — SKILL.md (стиль A, `job.json.brand`).
- Эмодзи: правило деления текста — `engine/vm/emoji.py` (`runs`) и `template/emoji.js` (`emojiRuns`), общая фикстура
  `engine/tests/fixtures/emoji-runs.json`; картинки и список — `template/emoji/` (собирает `python3 -m vm.emoji`).
- Сценарий до съёмки: схема `engine/vm/schemas/script.json` и `web/lib/script.ts` (типы; ТЗ «Снять по сценарию» —
  строки `ХУК:`, `ТЕЗИСЫ:`, `ПРИЗЫВ:`, `ЯЗЫК:`, их понимает SKILL.md).
- Озвучка: ассет `upload-voice.*` и `kind: "audio"` в `job.json.uploads` — `web/lib/jobs.ts` (`voiceAssetName`,
  `isVoiceFile`) и `web/lib/jobfiles.ts` (`buildJobFile`); их читает `engine/vm/prepare.py` (`_voice`).
