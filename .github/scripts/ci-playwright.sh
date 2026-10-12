#!/usr/bin/env bash
# Playwright глобально и браузеры в $PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers) — как в облачном окружении
# (setup/cloud-setup.sh): тесты шаблона, рендер кадров движком и e2e страницы находят их без настроек.
# PW_BROWSERS — какие ставить (по умолчанию chromium; webkit — движок Safari для e2e и шаблона).
set -euo pipefail
version="${PW_VERSION:-1.56.1}"
browsers="${PW_BROWSERS:-chromium}"
npm i -g "playwright@$version" >/dev/null
sudo mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
sudo chown "$(id -u):$(id -g)" "$PLAYWRIGHT_BROWSERS_PATH"
# shellcheck disable=SC2086 # список браузеров — словами
npx -y "playwright@$version" install --with-deps $browsers
for b in $browsers; do
  node -e "console.log('$b:', require('$(npm root -g)/playwright')['$b'].executablePath())"
done
