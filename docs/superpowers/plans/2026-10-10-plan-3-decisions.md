# План 3 (страница и связка): решения и отложенное

Итог исполнения плана `docs/superpowers/plans/2026-10-10-plan-3-web-and-integration.md`. Рабочий журнал был в
`.superpowers/` (не в git) — здесь всё, что из него важно Павлу: решения, принятые по ходу без вопроса к нему
(с ценой ошибки), исправления по финальному ревью и мелочи, отложенные на потом. Строки — как в журнале.

Финальное ревью всей ветки (свежий агент, самая сильная модель): критичных 0, важных 3, мелких 14. Важные и шесть
мелких, которые по последствиям для Павла важны (тупики без кнопки, ложное «завис», продолжение загрузки на iPhone,
кривые файлы сессии), исправлены одним проходом (коммит `7754cd8`), каждое — тестом, который сначала падал. Итог:
страница 111/111, проверка типов чистая, сквозной e2e 7/7, движок 527 быстрых тестов.

## Проверить на живом аккаунте и iPhone (шаг 5 `docs/setup.md`)

- Черновик на ~500 кусков: Action пишет `out/released.json` с `final.mp4` — иначе «Готово» не появится.
- Кадр превью 1080×1920 (`frame.png`) отдаётся страницей через Vercel.
- iPhone: повторный выбор того же видео продолжает загрузку; экран не гаснет после переключения приложений;
  `<video>` играет ролик по ссылке на GitHub.

## Исправлено по финальному ревью (9)

- Final: fixed I1 abandoned upload groups break vm fetch — test_fetch_takes_only_referenced_uploads (engine), 'a re-picked answer picture never reuses an asset that has parts in the draft' RED→GREEN, suites: engine 527 passed, web 111/111, e2e 7/7 (commit 7754cd8).
- Final: fixed I2 input-caused failure is a dead end — 'a failed step can go back to its last good state', 'back after a failed restyle or render waits for answers again, without a fire', 'back after a failed fix drops that fix and keeps the finished video', 'back after a failed analyze is refused', e2e result («Вернуть готовый ролик») RED→GREEN, suites as above.
- Final: fixed I3 own fonts rejected at «Монтировать» — 'own font ids from assets/fonts pass: Cyrillic, spaces, -hand' RED→GREEN.
- Final: fixed M1 wake lock lost after an app switch — 'the screen lock comes back after the page was hidden', 'no wake lock in the browser — nothing breaks' RED→GREEN.
- Final: fixed M2 iPhone re-pick never matches — 'matchPending resumes re-picked files and drops the rest' (new lastModified now matches) RED→GREEN.
- Final: fixed M3 misses cached per commit — 'a missing read is not remembered for the commit' RED→GREEN.
- Final: fixed M4 malformed session JSON — 'malformed session files read as missing' RED→GREEN; app/jobs/[id]/error.tsx as the last resort; sampleState guards words < 1.
- Final: fixed M5 false «застрял» on long videos — 'long videos get more time before «завис»' RED→GREEN.
- Final: fixed M10 waiting_answers without questions/styles — 'waiting for answers without questions or styles is an error with retry' RED→GREEN.

## Решения (44)

- Task 1: implemented inline (TDD), commit 730b218: RED — routine.test.ts module not found; GREEN — web npm test 26/26, tsc clean (stale .next/ types removed), grep experimental-cc-routine → lib/routine.ts only. Ruling: a response body that echoes the token is masked (***) in the "ответила <status>" text — the brief says "токена в тексте не бывает" — cost if wrong: none. Spike page and route deleted.
- Task 2: implemented inline (TDD), commit f41a132: RED — no GitHubError export; GREEN — npm test 34/34, tsc clean. Ruling: a 403/429 whose body says "rate limit" without retry headers gets retryAfter 60 (GitHub docs: secondary limits may come without headers; Plan 1 measured "60 с после ответа «лимит»") — the brief's "403 без них → null" still holds for a permission 403 (pinned) — cost if wrong: a permissions 403 mentioning "rate limit" waits a minute.
- Task 3: implemented inline (TDD), commit afa751a: RED — branch.ts missing; GREEN — npm test 41/41, tsc clean. Ruling: github.ts exports call/ok/headers/apiBase/retryAfter for branch.ts (the brief: branch.ts consumes GitHubError and the conditional GETs) — cost if wrong: a wider module surface. Ruling: fake DELETE of a missing ref answers 422 like GitHub; deleteBranch treats 404/422 as gone.
- Task 4: implemented inline (TDD), commit 3cb6f5a: RED — jobfiles.ts missing, jobs.ts exports missing; GREEN — npm test 56/56, tsc clean. Ruling: parseAnswersBody also refuses an "upload" answer without its upload claim (the page's form requires a finished upload; the server should not accept less) — cost if wrong: none (the page never sends that). Ruling: verifyParts keeps the brief's signature; the size comparison stays with the caller (missing empty and total === size).
- Task 6: implemented inline (TDD), commit 94f0ce9: RED — jobview.ts missing; GREEN — npm test 66/66, tsc clean. Ruling: /file accepts v = a 40-hex commit sha and reads at that commit (cacheable for a day), otherwise the branch head with no-store — cost if wrong: none. Ruling: interim uploader.tsx list shows phase/screen (the old fields are gone; Task 8 rebuilds the screen). Routes are covered by e2e later (tasks 8–12).
- Task 7: implemented inline (TDD), commit 748b236: RED — steps.ts missing; GREEN — npm test 73/73, tsc clean. Ruling: complete accepts only insert uploads (upload-i*) in the manifest; answer pictures (upload-q-*) are claimed at "answers" and checked with verifyParts there. Ruling: a failed status write after a failed fire is swallowed (the caller still gets the routine error) — cost if wrong: the page shows "queued" until it is stuck.
- Pre-Task 8: Ruling: upload hint drops «Несколько частей — склею по порядку» and says «до 3 ГБ» — spec §5.2 «Несколько частей одного видео — следующая версия (сейчас одна задача = один файл)» supersedes §4 and the mockup; 3 GB is checkSource's real limit — cost if wrong: one line of copy.
- Pre-Task 8: Ruling: the questions screen says «три варианта кадра» and «Показать превью» (mockup: «два») — spec §2/§4 and the Previews mockup show three variants — cost if wrong: copy.
- Pre-Task 8: Ruling: the step strip (Загрузка · Текст · Вопросы · Превью · Монтаж) appears on the upload screen too (mockup «1 · Загрузка» has it), not only on the job page — cost if wrong: a strip to remove.
- Task 8: Ruling: new shared files lib/format.ts (mmss, bytes), lib/client.ts (post, errorText, storage), app/steps.tsx, app/icons.tsx — later screens reuse them — cost if wrong: none.
- Task 8: Ruling: checkSource/checkInsert refuse empty files (a 0-byte insert would fail only at complete with a 409) — cost if wrong: none.
- Task 8: Ruling: vm:pending is cleared right after complete (the upload is whole; nothing to resume), not after start; «Повторить запуск» handles 409 by the job view (error/stuck → retry, running → job page) — cost if wrong: none.
- Task 8: Ruling: on resume, newly picked inserts get asset numbers after the pending ones (partial old chunks are never reused); after an upload error in the same tab «Продолжить загрузку» re-reads the draft's parts — cost if wrong: none.
- Task 8: Ruling: screen wake lock while uploading (iOS 16.4+; silently skipped elsewhere) — a locked phone pauses the page during a 12-minute upload — cost if wrong: none.
- Task 8: Ruling: UI fonts Manrope + Montserrat via next/font/google (self-hosted at build, no browser requests to Google) — cost if wrong: builds need Google Fonts reachable (Vercel and this sandbox: yes).
- Task 8: Ruling: run.sh starts servers with setsid and kills their process groups, fails fast on busy ports 3000/4010 (an npx wrapper kept next alive between runs); fake /__commit accepts {base64} values (binary frames for Task 10); E2E_SHOTS=<dir> saves screenshots.
- Plan 2 final review → Plan 3: Ruling: insert questions use RESERVED.none («не надо»), not `skip` (plan T10/T11 text) — the SKILL and jobfiles RESERVED use `none` — cost if wrong: none.
- Task 5: Ruling: vm fetch already joined upload-* groups and checked their sizes against the manifest (Plan 2 T13); the brief's test_fetch_joins_upload_parts and test_fetch_rejects_upload_size_mismatch passed on arrival and stay as pins (shuffled listing; the error names the file) — cost if wrong: none.
- Task 5: Ruling: vm style validates styles.json and answers.json before merging; a chosen variant missing from styles.json is a ValueError naming it (test_final_style_names_a_missing_variant) — cost if wrong: none.
- Task 9: Ruling: stepIndex(view) lives in lib/jobview.ts (pure, unit-tested): uploading 0, not_started 1, questions 2, restyle 3, render/fix 4, result 5, analyze 1 — cost if wrong: a strip highlight.
- Task 9: Ruling: JobData (GET /api/jobs/<id> body) is one exported type used by the route and the page — cost if wrong: none.
- Task 9: Ruling: one poll request at a time; an action re-polls at once; questions/result screens are placeholders until Tasks 10/12 — cost if wrong: none.
- Task 10: Ruling: LocalUpload gets an optional n (pick count): a re-picked answer picture goes to a new asset upload-q-<id>-<n>, so leftover parts of the previous picture never join into it (vm fetch joins every part of an asset name) — cost if wrong: none.
- Task 10: Ruling: own is the mockup's «Или напиши свой» field (typing selects own); upload is a pill that opens the picker; previewHook strips «» quotes from a variant label (mockup labels are quoted) — cost if wrong: copy.
- Task 10: Ruling: JobData gains releaseId (answer pictures upload into the job's draft); a stored option that no longer exists falls back to the question default, an emptied multi stays empty; the previews screen is a stub until Task 11 — cost if wrong: none.
- Task 11: Ruling: copyTemplate is async — it imports template/fonts.mjs (customFonts, mergeFonts), so the page and render-frames.mjs merge Pavel's fonts by one rule; custom font files go to public/template/fonts/ — cost if wrong: none.
- Task 11: Ruling: PreviewFrame also carries data-state, data-progress and data-big (the e2e redraws the same state in a separate template tab and compares layoutBoxes) — cost if wrong: none.
- Task 11: Ruling: thumbnails are 102 px wide (the mockup's 108 px + 3 px rings overflow a 390 px screen's 350 px column); font buttons are drawn in their own fonts (FontFace from /template/fonts.json), as in the mockup — cost if wrong: layout.
- Task 11: Ruling: Job memoizes questions/styles by their JSON (a 5-s poll does not redraw the previews); stage auto/questions/previews — after a restyle with every question answered the previews open by themselves — cost if wrong: none.
- Task 11: Ruling: the e2e's template tab opens in the page's browser context (the template is behind the login like everything else); the e2e page now has an explicit context — cost if wrong: none.
- Task 12: Ruling: the result screen has its own header («Готово», «<name> · было → стало · стиль X», plus «версия N» after fixes) like the mockup, without the step strip; «Субтитры .srt» only when the release has the .srt (a speechless clip has none since the Plan 2 I1 fix); qa problems — a yellow «Проверка нашла» card above «Что я сделал» — cost if wrong: layout.
- Task 13: Ruling: the prompt also forbids touching setup/ (the brief's list plus the setup script the prompt runs) — cost if wrong: none.
- Task 13: Ruling: the SKILL page contract is pinned by engine/tests/test_skill.py (the brief tested only the prompt) — cost if wrong: none.
- Final: Ruling: I1 — abandoned groups stay in the draft (no deletion by the page; they only count toward GitHub's 1000-asset cap, rare) — fetch ignores them and a re-pick picks a name with no parts (GET parts), so a lost localStorage cannot reuse a name — cost if wrong: a draft with many re-picks nears the cap.
- Final: Ruling: I2 — new action 'back' (only from error, last step restyle/render/fix): restyle/render → status waiting_answers with needs answers (files of the step stay), fix → the last fix.json entry dropped and status rendered; nothing is fired — cost if wrong: none.
- Final: Ruling: I3 — a font id is any non-empty string up to 200 chars without control characters or slashes (the engine schema takes any non-empty id) — cost if wrong: an id the template cannot find fails at render with its name.
- Final: Ruling: M2 — the source and inserts match on name and byte-exact size, lastModified is ignored — cost if wrong: a different video with the same name and exact size would resume into the old draft (practically impossible).
- Final: Ruling: M5 — the analyzing/rendering stuck limit is multiplied by max(1, duration / 5 min); queued and delivery limits stay — cost if wrong: a truly stuck long job is reported later.
- Final: Ruling: (declined) /api/login has no rate limit — Plan 1 code; a single private user behind a long password — cost if wrong: brute force is slowed only by Vercel.
- Final: Ruling: (declined) move-job-outputs.sh builds released.json from the first 100 releases and the release's embedded asset list — verify on the real account with a ~500-part job during Pavel's §10 run — cost if wrong: a finished video never shows as «Готово».
- Final: Ruling: (declined) answers and style live in localStorage until «Монтировать», the own picture disappears from the preview after a reload, the style resets to A after a restyle — plan decisions, kept — cost: re-picking on another device.
- Final: Ruling: (declined) runUpload waits a fixed 60 s on 429; ~500 asset creations per hour vs a 3 GB upload — Plan 1 design, measured fine at 2 GB — cost if wrong: a slower upload for 3 GB.
- Final: Ruling: (declined) Vercel's 4.5 MB response limit for /file images, iPhone <video> via 302, cookies on media requests — need the real account and device; listed for Pavel's §10 run — cost if wrong: a broken frame or video player found there.
- Final: Ruling: (declined) /_next/image excluded from auth, branch snapshots of in-flight jobs, prompt injection via Pavel's own speech — not used / plan design / out of scope — cost: none.

## Отложенные мелочи (8)

- Final: minor (deferred): M6 preview fonts/template come from the deployed master, the render from the job branch's fork — a font added mid-job is offered but missing in the render (now recoverable with «Изменить ответы»).
- Final: minor (deferred): M7 no stale-run guard in the prompt (an old slow session and a restarted one can both push).
- Final: minor (deferred): M8 the sessionUrl commit rewrites job.json from a stale copy (a second tab could lose a runs entry).
- Final: minor (deferred): M9 deleting a job leaves its vm:pending card (dismissable with «Забыть»); DELETE with the draft gone keeps a leftover branch.
- Final: minor (deferred): M11 an insert answer without a picture (sticker) is not drawn on the preview.
- Final: minor (deferred): M12 the page imports stepIndex from lib/jobview.ts, pulling the GitHub client into the client bundle (weight only).
- Final: minor (deferred): M13 GET /api/jobs cost grows with every kept job (all releases with their assets).
- Final: minor (deferred): M14 a client-supplied releaseId is trusted by complete/parts (single user; a stale vm:pending could write into the wrong draft).
