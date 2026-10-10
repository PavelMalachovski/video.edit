#!/usr/bin/env bash
# Подготовка облачной сессии Claude Code (Ubuntu 24.04, root) для движка монтажа.
# Идемпотентно: что уже стоит — пропускается. Печатает время каждой части и в конце:
#   ASR=gigaam-rnnt            ASR_MODEL=<папка модели GigaAM v2 transducer>
#   ASR_REF=whisper-turbo      ASR_REF_MODEL=<папка модели Whisper turbo>  (сплошной текст для правки)
#   VAD_MODEL=<silero_vad.onnx>
# Модели — из релизов k2-fsa/sherpa-onnx на GitHub (huggingface.co из облака закрыт).
# Пропустить Whisper (экономит ~1 ГБ и ~2 мин на холодном старте): VM_WHISPER_REF=0.
# Выбор моделей и замеры: docs/spikes/2026-10-results.md.
set -u
CACHE="${VM_CACHE:-$HOME/.cache/vm}"
REL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
GIGAAM="sherpa-onnx-nemo-transducer-giga-am-v2-russian-2025-04-19"
WHISPER="sherpa-onnx-whisper-turbo"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"
say() { printf '[setup %3ss] %s\n' "$SECONDS" "$*"; }
fail=0
mkdir -p "$CACHE"

# 1. Системные пакеты: ffmpeg (с zscale, libass, loudnorm), espeak-ng (речь для тестов).
need=""
command -v ffmpeg >/dev/null || need="$need ffmpeg"
command -v espeak-ng >/dev/null || need="$need espeak-ng"
if [ -n "$need" ]; then
  say "apt:$need"
  $SUDO apt-get install -y -qq $need >/dev/null 2>&1 \
    || { $SUDO apt-get update -qq >/dev/null 2>&1 && $SUDO apt-get install -y -qq $need >/dev/null 2>&1; } \
    || { say "НЕ удалось поставить:$need"; fail=1; }
fi
say "ffmpeg: $(ffmpeg -hide_banner -version 2>/dev/null | head -1 | cut -d' ' -f3)"

# 2. Python-зависимости движка.
if ! python3 -c "import sherpa_onnx, soundfile, numpy, jsonschema, pytest" 2>/dev/null; then
  say "pip: sherpa-onnx soundfile numpy jsonschema pytest"
  python3 -m pip install -q --break-system-packages sherpa-onnx soundfile numpy jsonschema pytest >/dev/null 2>&1 \
    || python3 -m pip install -q sherpa-onnx soundfile numpy jsonschema pytest >/dev/null 2>&1 \
    || { say "НЕ удалось поставить Python-пакеты"; fail=1; }
fi

# 3. Модели распознавания (параллельно).
fetch() {  # fetch <имя-архива-без-.tar.bz2>
  local n="$1"
  [ -d "$CACHE/$n" ] && return 0
  curl -sSL --retry 3 -o "$CACHE/$n.tar.bz2" "$REL/$n.tar.bz2" \
    && tar xjf "$CACHE/$n.tar.bz2" -C "$CACHE" && rm -f "$CACHE/$n.tar.bz2"
}
pids=()
fetch "$GIGAAM" & pids+=($!)
if [ "${VM_WHISPER_REF:-1}" != "0" ]; then fetch "$WHISPER" & pids+=($!); fi
[ -s "$CACHE/silero_vad.onnx" ] || curl -sSL --retry 3 -o "$CACHE/silero_vad.onnx" "$REL/silero_vad.onnx"
for p in "${pids[@]}"; do wait "$p" || { say "модель не скачалась"; fail=1; }; done
say "модели: $(du -sh "$CACHE" 2>/dev/null | cut -f1)"

# 4. Playwright (Node) для слоя текста и вставок. Chromium — уже в образе (/opt/pw-browsers).
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
if ! NODE_PATH="$(npm root -g 2>/dev/null)" node -e "require('playwright')" 2>/dev/null; then
  say "npm: playwright"
  npm i -g playwright@1.56.1 >/dev/null 2>&1 || { say "НЕ удалось поставить playwright"; fail=1; }
fi
NODE_PATH="$(npm root -g 2>/dev/null)" node -e "require('playwright').chromium.executablePath()" >/dev/null 2>&1 \
  || { say "Chromium для Playwright не найден в $PLAYWRIGHT_BROWSERS_PATH"; fail=1; }

# 5. Итог.
bash "$(dirname "$0")/probe-tools.sh" >/dev/null || { say "ffmpeg без нужных фильтров: bash setup/probe-tools.sh"; fail=1; }
say "готово (ошибки: $fail)"
echo "ASR=gigaam-rnnt"
echo "ASR_MODEL=$CACHE/$GIGAAM"
if [ -d "$CACHE/$WHISPER" ]; then echo "ASR_REF=whisper-turbo"; echo "ASR_REF_MODEL=$CACHE/$WHISPER"; else echo "ASR_REF=none"; fi
echo "VAD_MODEL=$CACHE/silero_vad.onnx"
exit $fail
