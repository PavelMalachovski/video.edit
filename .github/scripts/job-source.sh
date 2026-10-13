#!/usr/bin/env bash
# Готовый исходник задачи в её черновик релиза (vm.source): видео Павла → source.mp4 тем же движком, что в сессии, →
# source-<ключ>.mp4 кусками по 256 МБ и последним source-<ключ>.json (размер, sha256 — по нему vm fetch проверяет).
# Уже есть — выходим сразу (workflow запускается на каждый коммит job.json). Не вышло — в черновике остаётся метка
# source-<ключ>.failed, и следующие запуски этот ключ не пробуют (сессии нормализуют сами, как без Action); запуск
# вручную снимает метку и пробует снова. Видео длиннее 30 минут, не влезающее на диск машины или в запас ассетов
# черновика — не делаем. Старые исходники с другим ключом (до «Повторить без озвучки») удаляются из черновика.
# Окружение: GH_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_EVENT_NAME; JOB — id задачи вручную.
set -euo pipefail
repo="$GITHUB_REPOSITORY"
id="${JOB:-${GITHUB_REF_NAME#claude/job-}}"
if [[ ! "$id" =~ ^[0-9]{6}-[0-9]{6}-[0-9a-z]{4}$ ]]; then
  echo "::error::не id задачи: $id"
  exit 1
fi
dir="jobs/$id"
tag="job-$id"
if [ ! -f "$dir/job.json" ]; then
  echo "::error::нет $dir/job.json — не ветка задачи"
  exit 1
fi
export PYTHONPATH=engine
python3 -m pip install -q jsonschema
name="$(python3 -m vm.source "$dir" --name)"
if [ -z "$name" ]; then
  echo "задача-сценарий: видео нет"
  exit 0
fi
about="${name%.mp4}.json"
marker="${name%.mp4}.failed"
assets="$(gh release view "$tag" -R "$repo" --json assets --jq '.assets[].name')"
if grep -qxF "$about" <<<"$assets"; then
  echo "готовый исходник $name уже в черновике"
  exit 0
fi
if grep -qxF "$marker" <<<"$assets"; then
  if [ "${GITHUB_EVENT_NAME:-}" != workflow_dispatch ]; then
    echo "::notice::исходник $name уже не получился ($marker) — сессии нормализуют сами; заново — запуск вручную"
    exit 0
  fi
  gh release delete-asset "$tag" "$marker" -R "$repo" --yes
fi

# сколько нужно: оригиналы и вставки, пока идёт нормализация, плюс исходник (~8 МБ/с при 1080×1920, crf 16) и запас
read -r need secs < <(python3 - "$dir/job.json" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
videos = [v for v in m.get("videos") or [{"size": m.get("size"), "duration": m.get("duration")}] if isinstance(v, dict)]
size = sum(int(v.get("size") or 0) for v in videos) + sum(int(u.get("size") or 0) for u in m.get("uploads") or [] if isinstance(u, dict))
secs = sum(float(v.get("duration") or 0) for v in videos) or size / 4e6  # длина неизвестна — как видео 4 МБ/с
print(int(size + secs * 8.5e6 + 1e9), int(secs))
EOF
)
if [[ ! "$need" =~ ^[0-9]+$ || ! "$secs" =~ ^[0-9]+$ ]]; then
  echo "::error::не понял размеры видео в $dir/job.json"
  exit 1
fi
avail="$(df -B1 --output=avail . | tail -1)"
if [ "$secs" -gt 1800 ] || [ "$need" -gt "$avail" ]; then
  echo "::notice::видео ${secs} с, нужно ~$((need / 1000000000)) ГБ при свободных $((avail / 1000000000)) ГБ — готовый исходник не делаю, сессии нормализуют сами"
  exit 0
fi

work="$(mktemp -d)"
failed() {
  local code=$?
  if [ "$code" -ne 0 ]; then  # метка: следующие коммиты job.json не повторяют то, что не выходит
    echo "код $code" >"$work/$marker"
    gh release upload "$tag" -R "$repo" --clobber "$work/$marker" || true
  fi
}
trap failed EXIT

sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg >/dev/null
python3 -c "import sys; from vm.fetch import fetch; from vm.job import Job; fetch(Job(sys.argv[1]), originals=True)" "$dir"
start=$SECONDS
python3 -m vm.source "$dir"
size="$(stat -c %s "$dir/source.mp4")"
echo "исходник за $((SECONDS - start)) с: $size байт"
rm -rf "$dir/in" "$dir/work"  # оригиналы больше не нужны — место под куски
count=$(((size + 268435455) / 268435456))  # куски по 256 МБ, как режет split -b 256M
if [ $(($(grep -c . <<<"$assets" || true) + count + 1)) -gt 900 ]; then  # запас черновика — под готовые ролики
  echo "::notice::в черновике $tag мало места под ассеты — готовый исходник не кладу"
  exit 0
fi
python3 -m vm.source "$dir" --describe "$count" >"$work/$about"
export tag repo work
# каждый кусок грузится и удаляется сразу: на диске — исходник и один кусок, а не две копии
split -b 256M -d -a 5 --filter='cat >"$FILE" && gh release upload "$tag" -R "$repo" --clobber "$FILE" && rm "$FILE" && echo "$FILE" >>"$work/uploaded"' \
  "$dir/source.mp4" "$work/$name.part-"
rm "$dir/source.mp4"
uploaded="$(wc -l <"$work/uploaded")"
if [ "$uploaded" -ne "$count" ]; then
  echo "::error::загружено кусков $uploaded, а нужно $count"
  exit 1
fi
gh release upload "$tag" -R "$repo" --clobber "$work/$about"  # последним: есть описание — всё загружено
while read -r stale; do
  [ -n "$stale" ] && gh release delete-asset "$tag" "$stale" -R "$repo" --yes
done < <(grep -E '^source-[0-9a-f]{12}\.(json|failed|mp4\.part-[0-9]{5})$' <<<"$assets" | grep -vF "${name%.mp4}." || true)
echo "готовый исходник $name: $count кусков"
