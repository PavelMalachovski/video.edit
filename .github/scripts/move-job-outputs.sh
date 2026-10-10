#!/usr/bin/env bash
# Переносит jobs/<id>/out/* (кроме released.json) в черновик релиза job-<id>.
# Части <имя>.part-* склеиваются по порядку; если рядом есть <имя>.sha256, сумма сверяется.
# Окружение: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME (как в GitHub Actions).
set -euo pipefail
repo="$GITHUB_REPOSITORY"
work="$(mktemp -d)"
moved=0
shopt -s nullglob
for dir in jobs/*/out; do
  id="$(basename "$(dirname "$dir")")"
  tag="job-$id"
  files=()
  for f in "$dir"/*; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in released.json) continue ;; esac
    files+=("$f")
  done
  [ ${#files[@]} -eq 0 ] && continue
  echo "::group::$tag: ${#files[@]} file(s)"
  mkdir -p "$work/$id"
  uploads=()
  # обычные файлы
  for f in "${files[@]}"; do
    b="$(basename "$f")"
    case "$b" in *.part-*|*.sha256) continue ;; esac
    uploads+=("$f")
  done
  # части → целый файл
  for first in "$dir"/*.part-aa; do
    base="$(basename "${first%.part-aa}")"
    cat "$dir/$base".part-* > "$work/$id/$base"
    if [ -f "$dir/$base.sha256" ]; then
      want="$(cut -d' ' -f1 "$dir/$base.sha256")"
      got="$(sha256sum "$work/$id/$base" | cut -d' ' -f1)"
      [ "$want" = "$got" ] || { echo "::error::$base: sha256 mismatch ($got != $want)"; exit 1; }
    fi
    echo "joined $base from $(ls "$dir/$base".part-* | wc -l) part(s): $(stat -c %s "$work/$id/$base") bytes"
    uploads+=("$work/$id/$base")
  done
  if ! gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
    gh release create "$tag" -R "$repo" --draft --title "$tag" --notes "Готовые файлы задачи $id"
  fi
  [ ${#uploads[@]} -gt 0 ] && gh release upload "$tag" -R "$repo" --clobber "${uploads[@]}"
  gh api "repos/$repo/releases?per_page=100" \
    --jq "[.[] | select(.tag_name == \"$tag\")][0] | {release_id: .id, assets: [.assets[] | {name, id, size}]}" \
    > "$work/$id/assets.json"
  python3 - "$work/$id/assets.json" "$dir/released.json" <<'PY'
import json, sys, datetime
d = json.load(open(sys.argv[1]))
d["at"] = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
json.dump(d, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
PY
  git rm -q "${files[@]}"
  git add "$dir/released.json"
  moved=1
  echo "::endgroup::"
done
if [ "$moved" = 1 ]; then
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  ids="$(git diff --cached --name-only | sed -n 's#^jobs/\([^/]*\)/out/.*#\1#p' | sort -u | paste -sd, -)"
  git commit -q -m "chore(job-$ids): move outputs to release"
  for i in 1 2 3 4; do
    git push origin "HEAD:$GITHUB_REF_NAME" && break
    echo "push rejected, rebasing (attempt $i)"; sleep $((i * 2))
    git pull --rebase -q origin "$GITHUB_REF_NAME"
  done
fi
