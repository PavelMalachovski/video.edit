#!/usr/bin/env bash
# Печатает, какие фильтры и кодеры ffmpeg нужны движку монтажа и есть ли они.
# Использование: bash setup/probe-tools.sh   (код выхода 1, если чего-то нет)
set -u
FF="${FFMPEG:-ffmpeg}"
if ! command -v "$FF" >/dev/null; then echo "ffmpeg: no"; exit 1; fi
echo "ffmpeg: $("$FF" -hide_banner -version | head -1)"
filters="$("$FF" -hide_banner -filters 2>/dev/null)"
encoders="$("$FF" -hide_banner -encoders 2>/dev/null)"
missing=0
for f in zscale tonemap libass ass loudnorm sidechaincompress drawbox ebur128 signalstats; do
  name="$f"; [ "$f" = libass ] && name=subtitles
  if grep -qE "^ [.TSC|]{3} +$name " <<<"$filters"; then echo "filter $f: yes"; else echo "filter $f: no"; missing=1; fi
done
for e in libx264 libx265 aac; do
  if grep -qE "^ [VAS][.F][.S][.X][.B][.D] +$e " <<<"$encoders"; then echo "encoder $e: yes"; else echo "encoder $e: no"; missing=1; fi
done
exit $missing
