# Настройка video.edit

Что делает Павел своими аккаунтами (один раз). Всё остальное уже в репозитории.
Порядок важен: шаги 2–4 опираются на код в ветке `master`.

## 1. Код в master
Vercel, рутина и GitHub Action берут код из `master`. Пока разработка идёт в ветке
`ccr-862b766a-c9c3qm` — её нужно слить в `master` (pull request).

## 2. Токен GitHub (для страницы на Vercel)
GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** →
Generate new token:
- Repository access: **Only select repositories** → `video.edit`
- Permissions → Repository permissions → **Contents: Read and write** (создавать черновики
  релизов, загружать и удалять файлы, удалять ветки задач)
- Expiration: 1 год
Скопируйте токен — он понадобится в шаге 3. Никуда больше его не вставляйте.

## 3. Vercel
vercel.com → Add New → Project → Import `PavelMalachovski/video.edit`:
- **Root Directory**: `web`; Framework: Next.js (определится сам).
- **Environment Variables** (Production):
  - `APP_PASSWORD` — пароль для входа на страницу (придумайте);
  - `SESSION_SECRET` — длинная случайная строка (например, 40 любых символов);
  - `GITHUB_TOKEN` — токен из шага 2;
  - `GITHUB_REPO` = `PavelMalachovski/video.edit`;
  - `ROUTINE_ID`, `ROUTINE_TOKEN` — после шага 4 (потом Redeploy).
- Deploy. Адрес вида `https://video-edit-….vercel.app` — это и есть страница.

## 4. Облачное окружение и рутина Claude
claude.ai/code:
1. **Окружение** (меню облачного окружения → New/Edit): имя `video-edit`; сеть — по
   умолчанию (Trusted); **Setup script** — вставьте целиком содержимое
   `setup/cloud-setup.sh` из репозитория. Он ставит распознавание речи и проверяет ffmpeg;
   первый раз ~1,5 минуты, дальше кэшируется.
2. **Рутина** (Routines → New): имя `video-edit`; репозиторий `video.edit`; окружение
   `video-edit`; промпт — текст из `setup/routine-prompt.md` (между линиями); расписание —
   не нужно; **включите API-триггер** и скопируйте id рутины и токен.
3. Вставьте их в Vercel (`ROUTINE_ID`, `ROUTINE_TOKEN`) и сделайте Redeploy.

## 5. Проверка с iPhone (Safari)
1. Откройте страницу Vercel, войдите паролем.
2. «Выбрать видео» → ролик из «Фото» **от 300 МБ**, снятый камерой как обычно → «Загрузить».
   Дождитесь зелёной строки «Загружено …». Запомните размер ролика в «Фото» (свайп вверх
   по видео — там размер).
3. Ещё раз то же, но на середине **заблокируйте экран** на 30 секунд, потом вернитесь.
4. Ещё раз, на середине **переключитесь в другое приложение** на 30 секунд.
5. Откройте `/spike` на той же странице → «Запустить тест рутины».
Напишите в чат, что видели (особенно ошибки), и размер ролика из «Фото» — остальное
Claude проверит в GitHub сам.

## Уборка после проверок
В GitHub → Releases удалите черновик `job-spike`, в Branches — ветку `claude/job-spike`
(тестовые, сессия Claude удалять не может).
