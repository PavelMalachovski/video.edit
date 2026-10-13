#!/usr/bin/env bash
# Готовый исходник задачи в её черновик релиза (vm.source): видео Павла → source.mp4 тем же движком, что в сессии, →
# source-<ключ>.mp4 кусками по 256 МБ и последним source-<ключ>.json (размер, sha256 — по нему vm fetch проверяет).
# Уже есть — выходим сразу (workflow запускается на каждый коммит job.json). Старые исходники с другим ключом (до
# «Повторить без озвучки») удаляются из черновика.
# Окружение: GH_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME; JOB — id задачи при запуске вручную.
set -euo pipefail
repo="$GITHUB_REPOSITORY"
id="${JOB:-${GITHUB_REF_NAME#claude/job-}}"
if [[ ! "$id" =~ ^[0-9]{6}-[0-9]{6}-[0-9a-z]{4}$ ]]; then
  echo "::error::не id задачи: $id"
  exit 1
fi
dir="jobs/$id"
tag="job-$id"
if [ ! -f "$dir/job.json" ]; then  # запуск вручную с master: job.json — из ветки задачи
  git fetch -q --depth=1 origin "claude/job-$id"
  git checkout -q FETCH_HEAD -- "$dir/job.json"
fi
export PYTHONPATH=engine
python3 -m pip install -q jsonschema
name="$(python3 -m vm.source "$dir" --name)"
if [ -z "$name" ]; then
  echo "задача-сценарий: видео нет"
  exit 0
fi
about="${name%.mp4}.json"
assets="$(gh release view "$tag" -R "$repo" --json assets --jq '.assets[].name')"
if grep -qxF "$about" <<<"$assets"; then
  echo "готовый исходник $name уже в черновике"
  exit 0
fi
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg >/dev/null
python3 -c "import sys; from vm.fetch import fetch; from vm.job import Job; fetch(Job(sys.argv[1]), originals=True)" "$dir"
start=$SECONDS
python3 -m vm.source "$dir"
echo "исходник за $((SECONDS - start)) с: $(stat -c %s "$dir/source.mp4") байт"
work="$(mktemp -d)"
split -b 256M -d -a 5 "$dir/source.mp4" "$work/$name.part-"
parts=("$work/$name".part-*)
python3 -m vm.source "$dir" --describe "${#parts[@]}" > "$work/$about"
gh release upload "$tag" -R "$repo" --clobber "${parts[@]}"
gh release upload "$tag" -R "$repo" --clobber "$work/$about"  # последним: есть описание — всё загружено
while read -r stale; do
  [ -n "$stale" ] && gh release delete-asset "$tag" "$stale" -R "$repo" --yes
done < <(grep -E '^source-[0-9a-f]{12}\.(json|mp4\.part-[0-9]{5})$' <<<"$assets" | grep -vF "${name%.mp4}." || true)
echo "готовый исходник $name: ${#parts[@]} кусков"
