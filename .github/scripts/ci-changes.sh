#!/usr/bin/env bash
# Что затронул PR — по этому CI решает, какие тяжёлые проверки нужны (минуты Actions на тарифе Free — 2 000 в месяц).
# Движок — если менялись engine, template, assets, setup, .claude/skills или .github; шаблон — template, engine, assets,
# .github; страница целиком (e2e) — web, template, engine, assets, .github. Печатает engine=…, template=…, web=… для
# $GITHUB_OUTPUT. $1 — база сравнения (origin/master).
set -euo pipefail
base=$1
files=$(git diff --name-only "$base"...HEAD)
echo "изменено файлов: $(printf '%s\n' "$files" | grep -c . || true)" >&2
has() { if printf '%s\n' "$files" | grep -qE "^($1)/"; then echo true; else echo false; fi; }
echo "engine=$(has 'engine|template|assets|setup|\.claude/skills|\.github')"
echo "template=$(has 'template|engine|assets|\.github')"
echo "web=$(has 'web|template|engine|assets|\.github')"
