#!/usr/bin/env bash
# 30 секунд настоящего ролика для engine/tests/test_realclip.py → папка $REALCLIP_JOB. Берётся архивом из черновика
# релиза realclip-30s (репозиторий закрытый); архива ещё нет — собирается из задачи $REALCLIP_SOURCE_JOB (файлы — из её
# ветки, исходник — готовый из её черновика или из видео Павла) и кладётся туда же. Видео Павла в git не кладём.
# Окружение: GH_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_WORKSPACE, REALCLIP_JOB; REALCLIP_SOURCE_JOB — id задачи.
set -euo pipefail
repo="$GITHUB_REPOSITORY"
tag="realclip-30s"
asset="realclip-30s.tar"
src_job="${REALCLIP_SOURCE_JOB:-261012-091256-w7eu}"
work="$(mktemp -d)"
mkdir -p "$REALCLIP_JOB"
if gh release download "$tag" -R "$repo" -p "$asset" -D "$work" 2>/dev/null; then
  tar -xf "$work/$asset" -C "$REALCLIP_JOB"
  echo "ролик — из черновика $tag"
  exit 0
fi
dir="jobs/$src_job"
git fetch -q --depth=1 origin "claude/job-$src_job"
git archive FETCH_HEAD "$dir" | tar -x -C "$work"
export PYTHONPATH="$GITHUB_WORKSPACE/engine"
(cd "$work" && python3 -c "import sys; from vm.fetch import fetch; from vm.job import Job; fetch(Job(sys.argv[1]))" "$dir")
if [ ! -f "$work/$dir/source.mp4" ]; then  # готового исходника в черновике не было — из видео Павла
  (cd "$work" && python3 -m vm.source "$dir")
fi
(cd "$GITHUB_WORKSPACE/engine" && python3 -m tests.realclip_prepare "$work/$dir" "$REALCLIP_JOB")
tar -cf "$work/$asset" -C "$REALCLIP_JOB" .
if ! gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  gh release create "$tag" -R "$repo" --draft --title "$tag" --notes "30 секунд настоящего ролика для проверок (workflow realclip). Не удалять."
fi
gh release upload "$tag" -R "$repo" --clobber "$work/$asset"
echo "ролик собран из задачи $src_job и положен в черновик $tag"
