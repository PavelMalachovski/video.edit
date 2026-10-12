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
  уязвимостей — CodeQL (`.github/workflows/codeql.yml`). Скриншоты e2e — артефакты прогона.

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
  `web/lib/jobfiles.ts` (`ADJUST` — что Павел двигает и в каких пределах), общая фикстура
  `engine/tests/fixtures/style-merge.json`.
- Место и размер вставок Павла: `engine/vm/style.py` (`placed_inserts`) и `web/lib/style.ts` (`placedInserts`;
  рамку в безопасной зоне считают `resizeBox` и `moveBox`), общая фикстура `engine/tests/fixtures/insert-boxes.json`.
- Группы субтитров: `engine/vm/subs.py` (`build_sub_events`, блоки и строки soft) и `web/lib/style.ts` (`sampleState`).
- Шкала времени исходник ↔ финал: `engine/vm/timeline.py` (`Timeline`) и `web/lib/timeline.ts`, общая фикстура
  `engine/tests/fixtures/timeline-map.json`.
- Файлы редактора (бета): `engine/vm/editor.py` и схема `engine/vm/schemas/editor.json` ↔ `web/lib/tracks.ts`
  (`parseMedia`, `parseDraft`) и `web/lib/editordata.ts` (`MEDIA_NAMES` — что плеер берёт из релиза).
- Правки руками из редактора (`timeline.json`): `engine/vm/edits.py` (`apply_keep`, `apply`) и `web/lib/edits.ts`
  (`applyKeep`, `parseTimeline`, `LIMITS` — пределы схемы `engine/vm/schemas/timeline.json`), общая фикстура
  `engine/tests/fixtures/edits.json`; ключи громкости звуков — `_sounds` в `engine/vm/render.py` и `draftTracks` в
  `web/lib/tracks.ts`; запись в `fix.json` из редактора (`timeline`, `style`, `styleFrom`) — `web/lib/jobfiles.ts`,
  SKILL.md (шаг fix) и `vm style --onto` (`merge_style` в `engine/vm/style.py`).
- Звук на прослушивании в редакторе: `engine/vm/audio.py` (`VOICE_LUFS`, `MUSIC_BOOST`, `SFX_GAIN_DB`, `FADE_IN`,
  `FADE_OUT`, `MIN_MUSIC`, повтор музыки, громкость трека — с места `from`) и `web/lib/sound.ts`; голос прокси — на `VOICE_LUFS` (`engine/vm/editor.py`); какие звуки
  страница отдаёт — `SOUNDS` и `_resolve` в `engine/vm/render.py` ↔ `audioType` и `audioPaths` в `web/lib/jobs.ts`.
- Анимации стиля эталона: `template/overlay.js` (`SOFT`, `ACC` — сколько длится появление) и `engine/vm/overlay.py`
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
