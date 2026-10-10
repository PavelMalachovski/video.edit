#!/usr/bin/env bash
# Ставит всё, что нужно скиллу: ffmpeg, распознавание речи (whisper), шрифт, Node Playwright.
# Повторный запуск безопасен: что уже стоит — пропускается.
# В конце печатает строку MODEL=..., её передают в edit_video.py / transcribe.py как --model.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"
say() { printf '[setup] %s\n' "$*"; }

# 1. ffmpeg (+ libass для субтитров)
if ! command -v ffmpeg >/dev/null; then
  say "ставлю ffmpeg"
  if command -v apt-get >/dev/null; then $SUDO apt-get update -qq && $SUDO apt-get install -y -qq ffmpeg >/dev/null
  elif command -v brew >/dev/null; then brew install ffmpeg
  else say "поставьте ffmpeg вручную"; fi
fi
ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' ass ' || say "ВНИМАНИЕ: ffmpeg без libass — субтитры не вшить"

# 2. Шрифт Montserrat (кириллица) для субтитров и вставок
FONTS="$HOME/.fonts"; mkdir -p "$FONTS"
for f in ExtraBold Bold; do
  [ -s "$FONTS/Montserrat-$f.ttf" ] || curl -sSfL -o "$FONTS/Montserrat-$f.ttf" \
    "https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-$f.ttf" \
    || say "шрифт Montserrat-$f не скачался — будет запасной (DejaVu Sans)"
done
command -v fc-cache >/dev/null && fc-cache -f >/dev/null 2>&1

# 3. Распознавание речи.
#    a) обычный путь: whisper.cpp + модель с huggingface.co
#    b) если huggingface.co закрыт (облачные сессии Claude): та же модель Whisper large-v3-turbo
#       в формате ONNX из релизов sherpa-onnx на GitHub + обёртка whisper-cli.
MODEL=""
HF_OK=0; curl -sS -o /dev/null -m 15 -I https://huggingface.co 2>/dev/null && HF_OK=1
if [ $HF_OK -eq 1 ]; then
  if ! command -v whisper-cli >/dev/null; then
    if command -v brew >/dev/null; then brew install whisper-cpp
    else
      say "собираю whisper.cpp"
      SRC="${TMPDIR:-/tmp}/whisper.cpp"
      [ -d "$SRC" ] || git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
      (cd "$SRC" && cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build build -j"$(nproc 2>/dev/null || echo 4)" --config Release >/dev/null) \
        && $SUDO cp "$SRC/build/bin/whisper-cli" /usr/local/bin/ && $SUDO cp -P "$SRC"/build/src/libwhisper.so* "$SRC"/build/ggml/src/libggml*.so* /usr/local/lib/ 2>/dev/null; $SUDO ldconfig 2>/dev/null
    fi
  fi
  MODEL="large-v3-turbo"          # скачается сам при первом запуске
else
  say "huggingface.co недоступен — ставлю sherpa-onnx + Whisper turbo с GitHub"
  python3 -c "import sherpa_onnx, soundfile, numpy" 2>/dev/null || pip install -q sherpa-onnx soundfile numpy
  M="$HOME/.cache/sherpa/sherpa-onnx-whisper-turbo"
  if [ ! -s "$M/turbo-encoder.int8.onnx" ]; then
    mkdir -p "$HOME/.cache/sherpa"
    curl -sSL --retry 3 -o "$HOME/.cache/sherpa/turbo.tar.bz2" \
      https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-turbo.tar.bz2 \
      && tar xjf "$HOME/.cache/sherpa/turbo.tar.bz2" -C "$HOME/.cache/sherpa" && rm -f "$HOME/.cache/sherpa/turbo.tar.bz2"
  fi
  $SUDO install -m 755 "$HERE/whisper_sherpa.py" /usr/local/bin/whisper-cli
  MODEL="$M"
fi

# 4. Playwright (Node) для анимированных вставок — нужен только если будут вставки
if ! (cd "$HERE/overlay" && NODE_PATH="$(npm root -g 2>/dev/null)" node -e "require('playwright')" 2>/dev/null); then
  say "Playwright не найден: для вставок выполните  npm i -g playwright  (браузер Chromium должен быть установлен)"
fi

command -v whisper-cli >/dev/null && say "whisper-cli: ok" || say "whisper-cli НЕ установлен: будет только резка по тишине, без субтитров"
echo "MODEL=$MODEL"
