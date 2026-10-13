#!/usr/bin/env bash
# Сквозная проверка страницы: поддельный GitHub и API рутины (порт 4010), собранная страница (порт 3000),
# Playwright по сегментам flow-e2e.mjs. Логи серверов — в папке, которую печатает при сбое. Другие порты (второй прогон
# рядом, из другой копии ветки) — E2E_APP_PORT и E2E_FAKE_PORT.
set -euo pipefail
cd "$(dirname "$0")/../.."

export E2E_APP_PORT="${E2E_APP_PORT:-3000}" E2E_FAKE_PORT="${E2E_FAKE_PORT:-4010}"
app="http://127.0.0.1:$E2E_APP_PORT" fake="http://127.0.0.1:$E2E_FAKE_PORT"

logs=$(mktemp -d)
pids=()
cleanup() {  # серверы — в своих группах процессов: гасим группу целиком (npx и next держат дочерние процессы)
  for p in "${pids[@]}"; do kill -- "-$p" 2>/dev/null || kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT

for port in "$E2E_APP_PORT" "$E2E_FAKE_PORT"; do
  if curl -s -o /dev/null "http://127.0.0.1:$port/"; then
    echo "порт $port занят — остался сервер от прошлого прогона? (pgrep -af 'next start|fake-github')" >&2
    exit 1
  fi
done

wait_port() {  # wait_port <url> <что>
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null "$1"; then return 0; fi
    sleep 0.5
  done
  echo "не поднялся $2 ($1); логи: $logs" >&2
  tail -n 40 "$logs"/*.log >&2 || true
  return 1
}

export GITHUB_TOKEN=t GITHUB_REPO=o/r GITHUB_API_URL="$fake/api" GITHUB_UPLOADS_URL="$fake/up" \
  ROUTINE_ID=trig_e2e ROUTINE_TOKEN=rt ROUTINE_API_URL="$fake" APP_PASSWORD=pw SESSION_SECRET=e2e

setsid node tests/e2e/fake-github.mjs "$E2E_FAKE_PORT" >"$logs/fake.log" 2>&1 &
pids+=($!)
npm run build >"$logs/build.log" 2>&1 || { tail -n 60 "$logs/build.log" >&2; exit 1; }
setsid npx next start -p "$E2E_APP_PORT" >"$logs/next.log" 2>&1 &
pids+=($!)
wait_port "$fake/__state" 'поддельный GitHub'
wait_port "$app/login" 'страница'

if ! PLAYWRIGHT_MODULE="$(npm root -g)/playwright" PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  node --experimental-strip-types --no-warnings tests/e2e/flow-e2e.mjs; then
  echo "--- next.log (хвост) ---" >&2
  tail -n 40 "$logs/next.log" >&2 || true
  exit 1
fi
