# Результаты проверок (План 1)

План: `docs/superpowers/plans/2026-10-10-plan-1-spikes.md`.
Среда замеров: облачная сессия Claude Code (та же, что у рутин): Ubuntu 24.04.5,
4 vCPU, 15 ГБ RAM, ~30 ГБ свободного диска; в образе уже есть ffmpeg 6.1.1,
Node 22, Playwright 1.56.1 и Chromium в `/opt/pw-browsers`.

## Сводка решений

| Вопрос | Решение | Где подробно |
|---|---|---|
| Распознавание и время слов | GigaAM v2 transducer (sherpa-onnx, MIT): слова + время; Whisper turbo — сплошной текст с пунктуацией для правки Claude | Задача 1 |
| HDR → SDR | `zscale=t=bt709:m=bt709:p=bt709:r=tv:npl=100,format=yuv420p` (прямой перевод HLG без tone mapping); блики проверить на настоящем видео с iPhone | Задача 1 |
| Слой текста | Chromium, 82 мс на кадр 1080×1920 → рисовать только при смене состояния, не 30 к/с | Задача 1 |
| Подготовка окружения | `setup/cloud-setup.sh`: 95 с с нуля, 1,5 с повторно (< 5 мин — кэшируется) | Задача 1 |
| Готовые ролики | (задача 2) | |
| Загрузка с iPhone | (задача 3) | |
| Рутина | (задача 4) | |

## Задача 1 — инструменты в облачной сессии

### Сеть
Открыто: github.com (в т. ч. файлы релизов через `release-assets.githubusercontent.com`),
raw.githubusercontent.com, pypi.org, registry.npmjs.org, archive.ubuntu.com.
Закрыто: huggingface.co, openaipublic.azureedge.net (модели OpenAI Whisper),
alphacephei.com (Vosk), download.pytorch.org. GitHub API чужих репозиториев из
сессии закрыт («GitHub access to this repository is not enabled»), но файлы
релизов публичных репозиториев качаются.

### ffmpeg
`bash setup/probe-tools.sh`: все нужные фильтры и кодеры есть — zscale, tonemap,
libass, loudnorm, sidechaincompress, drawbox, ebur128, signalstats; libx264,
libx265, aac.

### Распознавание: время слов
Скрипт: `docs/spikes/asr_bench.py`. Речь — `espeak-ng -v ru`, по одному слову, с
точно известным началом каждого слова (12 слов, паузы 0,12 с внутри фразы и 0,8 с
между фразами, 10,5 с). Ошибка — модуль разницы начала слова, по совпавшим словам.
Качество текста на синтезированном голосе не показательно (у GigaAM «логотип» →
«набатит»), меряли время.

| Вариант | Время слов | Ошибка начала, мс (сред./макс.) | Совпало слов | Скорость (RTF) |
|---|---|---|---|---|
| Whisper turbo (sherpa-onnx) | нет | — | — | 0,61 |
| Whisper turbo + время фраз (VAD) по буквам | расчётное | 106 / 278 | 7/12 | 0,66 |
| GigaAM v2 CTC | да | 76 / 125 | 8/12 | 0,12 |
| **GigaAM v2 transducer** | да | **47 / 85** | 9/12 | **0,13** |

Длинная запись (50 с, та же речь ×6), GigaAM v2 transducer:
- целиком: ошибка 41 / 82 мс, совпало 51/72, RTF 0,18, память 0,9 ГБ;
- по кусочкам VAD (1,5–2,5 с): ошибка 58 / 132 мс, совпало 37/72 — хуже, мелко
  резать нельзя.

whisper.cpp с `-ml 1` проверить не удалось: модели ggml лежат на huggingface.co,
а исходники Whisper — на openaipublic.azureedge.net, оба закрыты. Нужен ли он, если
GigaAM укладывается в порог (≤ 80 мс, RTF ≤ 0,5), — нет.

**Решение:** `ASR=gigaam-rnnt` — слова и время (запись целиком; длиннее ~60 с —
резать на куски по 30–60 с по паузам, не мельче). Whisper turbo — только сплошной
текст с пунктуацией и регистром, по которому Claude правит слова (RTF 0,6: на
2-минутный ролик ~70 с; можно выключить `VM_WHISPER_REF=0`). Silero VAD — для
поиска пауз при нарезке длинной записи. GigaAM — лицензия MIT
(github.com/salute-developers/GigaAM).

### HDR → SDR
Тест «как в плане» (testsrc2 с пометкой HLG, но без перевода цветов) — не HDR:
любой tone mapping его затемняет (YAVG 78 против 126). Поэтому честный тест —
круг SDR → HLG (`zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=arib-std-b67:m=bt2020nc:p=bt2020:r=tv:npl=100`)
→ SDR и сравнение с исходником:

| Способ HLG → SDR | YAVG (исходник 126,3) | PSNR к исходнику |
|---|---|---|
| **прямой: `zscale=t=bt709:m=bt709:p=bt709:r=tv:npl=100`** | **127,9 (+1,3%)** | **30,3 дБ** |
| linear + `tonemap=clip` | 125,1 | 29,6 дБ |
| linear + `tonemap=mobius` | 111,0 | 22,8 дБ |
| linear + `tonemap=hable` | 85,1 (−33%) | 15,5 дБ |
| только смена метки | 104,9 | 15,7 дБ |

**Решение:** прямой перевод, выход помечается `-color_primaries bt709 -color_trc bt709 -colorspace bt709`.
Ограничение: синтетика без бликов ярче 100 нит. На настоящем HDR с iPhone
(задача 3) сравнить кадры «прямой» / `mobius` / `npl=203` и закрепить вариант.
Dolby Vision с iPhone (профиль 8.4) несёт HLG-базу — ffmpeg читает её как HLG.

### Chromium
`page.screenshot({omitBackground:true})` кадра 1080×1920 с кириллицей (Montserrat
из github.com/google/fonts, подключён как файл): PNG RGBA, **82 мс на кадр**.
2-минутный ролик на 30 к/с — это 3600 кадров ≈ 5 мин; по одному кадру на смену
состояния (≈ 300–600) — 25–50 с. Выбор Плана 2 (события + `ffconcat`) подтверждён.
Важно: ES-модули не видят `NODE_PATH` — глобальный Playwright подключать через
локальную ссылку `node_modules/playwright` или `createRequire`.

### Подготовка окружения и рендер
- `setup/cloud-setup.sh`: с нуля 95 с (apt espeak-ng 3 с, pip ~10 с, модели 1,2 ГБ
  параллельно ~80 с), повторно 1,5 с. Меньше 5 минут — окружение его кэширует.
- Рендер 60 с testsrc2 1080×1920, `libx264 -crf 18 -preset medium` + AAC 192k:
  36 с, пик памяти 0,6 ГБ, **файл 79 МБ**. Синтетика сжимается хуже живого
  видео, но 2–3-минутный ролик может превысить **лимит GitHub 100 МБ на файл в
  git**. Решение — в задаче 2 (готовый файл пушится частями ≤ 95 МБ, Action
  склеивает).
