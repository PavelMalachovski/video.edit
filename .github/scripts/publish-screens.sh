#!/usr/bin/env bash
# Скриншоты прогона → служебная ветка `$2` одним коммитом без истории (каждый прогон её перезаписывает). Так их видит и
# Claude из облачной сессии: артефакты GitHub ему недоступны, а `git fetch origin <ветка>` — да. Кладутся только файлы
# из папки `$1`; пушит задание `screens` токеном с правом записи (сторонний код в нём не запускается).
set -euo pipefail
dir=$1
ref=$2
if [ ! -d "$dir" ] || [ -z "$(ls -A "$dir")" ]; then
  echo "скриншотов нет ($dir) — ветку $ref не трогаю"
  exit 0
fi
repo=$(git rev-parse --absolute-git-dir)
export GIT_INDEX_FILE="$RUNNER_TEMP/screens.index"
rm -f "$GIT_INDEX_FILE"
(cd "$dir" && git --git-dir="$repo" --work-tree=. add -A -f .)
tree=$(git write-tree)
export GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@users.noreply.github.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@users.noreply.github.com
commit=$(git commit-tree "$tree" -m "e2e screens of ${GITHUB_SHA:0:7}")
git push -q -f origin "$commit:refs/heads/$ref"
echo "скриншоты ($(ls "$dir" | wc -l)): ветка $ref"
