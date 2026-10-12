#!/usr/bin/env bash
# Playwright глобально и Chromium в $PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers) — как в облачном окружении
# (setup/cloud-setup.sh): тесты шаблона, рендер кадров движком и e2e страницы находят их без настроек.
set -euo pipefail
version="${PW_VERSION:-1.56.1}"
npm i -g "playwright@$version" >/dev/null
sudo mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
sudo chown "$(id -u):$(id -g)" "$PLAYWRIGHT_BROWSERS_PATH"
npx -y "playwright@$version" install --with-deps chromium
node -e "console.log('chromium:', require('$(npm root -g)/playwright').chromium.executablePath())"
