# План 2 (движок монтажа): решения и отложенное

Итог исполнения плана `docs/superpowers/plans/2026-10-10-plan-2-montage-engine.md`. Рабочий журнал был в
`.superpowers/` (не в git) — здесь всё, что из него важно Павлу: решения, принятые по ходу без вопроса к нему
(с ценой ошибки), исправления по финальному ревью и мелочи, отложенные на потом. Строки — как в журнале.

Финальное ревью всей ветки (самая сильная модель): критичных 0, важных 3, мелких 14. Важные и четыре мелких,
которые по последствиям для Павла важны, исправлены одним проходом (коммит `1a21e87`), каждое — тестом,
который сначала падал; весь набор движка — 519 быстрых и 42 медленных теста — зелёный.

## Исправлено по финальному ревью (7)

- Final: fixed I1 empty .srt blocks delivery — test_render_without_words_has_no_subs RED→GREEN, suite 519/519 fast + 42/42 slow (commit 1a21e87).
- Final: fixed I2 insert place lost between analyze and render — test_edit_keeps_a_planned_insert_waiting_for_its_answer, test_an_insert_still_waiting_for_its_answer_stops_the_layer, test_planned_inserts_keep_their_place_from_analyze_to_render RED→GREEN, suite 519/519 + 42/42.
- Final: fixed I3 no noise reduction for quiet recordings — test_loudness_reads_integrated_lufs_and_none_without_sound, test_quiet_voice_is_denoised_before_loudnorm, test_denoise_lowers_the_hiss_between_phrases, test_quiet_recording_is_denoised_and_reported, test_check_shows_the_layout_before_the_render (printed line) RED→GREEN, suite 519/519 + 42/42.
- Final: fixed M1 validate in restyle — test_validate_leaves_uploads_alone_until_fetch RED→GREEN, suite 519/519 + 42/42.
- Final: fixed M2 missing notes — test_render_without_words_has_no_subs, test_render_reports_a_missing_fullscreen_file, test_sounds_skip_absent_cutaways_and_report_missing_files, test_sounds_say_when_assets_have_no_sfx, test_missing_music_file_warns_not_fails RED→GREEN, suite 519/519 + 42/42.
- Final: fixed M7 long analyze phase without status — test_analyze_refreshes_the_status_before_the_long_text_work RED→GREEN.
- Final: fixed M13 literal face + 90-zoom cap — test_the_edit_draft_has_no_literal_face, test_quiet_recordings_and_the_zoom_cap_are_in_the_rules RED→GREEN.

## Решения (47)

- Ruling: edit.json insert items get optional `title` (string) — sticker/badge need it and T7 InsertState has it — cost if wrong: one optional schema field.
- Ruling: edit.json `face` = {x, y, w?, h?} in frame fractions; QA face box defaults to w=0.30, h=0.22 centred on (x,y) — T12 needs a box, Claude only reliably gives a point — cost if wrong: coarse face-overlap check.
- Ruling: T8's render-frames.mjs also writes `boxes.json` (layoutBoxes() per interval: [{t0,t1,boxes}]) — T12 consumes it; keeps file ownership in T8 — cost if wrong: none.
- Ruling: T11 `render(job, out_dir, name="final") -> dict` writes `<name>.mp4/.srt`; T13 `render --version N` passes name=`final-vN` — cost if wrong: one parameter.
- Ruling: heavy/intermediate job files live in `<jobdir>/work/` (already ignored by root .gitignore `work/`): work/in/ (downloaded inputs), work/source.mp4, work/source.wav, work/sheet.png, work/look/, work/frames/; committed: *.json, frame.png, qa/qa.png, out/* — default push(job) staging the whole job folder is then safe — cost if wrong: T13 paths change.
- Task 1: Ruling: re-graded Minor "styles.json sample.words minItems:1" to Important — Review Focus names silent clips; analyze could not write styles.json for them — cost if wrong: one schema keyword.
- Task 1: Ruling: fix (3) = `status --push` stages only status.json AND push() refuses to stage any file >95 MB (GitError naming it) — defence in depth for the 100 MB GitHub limit — cost if wrong: an over-cautious guard.
- Task 3: Ruling: fixture is 8.4 s (not 10.5 s) → long-audio test uses ×10 = 84 s (brief said ×8 / >75 s) — cost: none.
- Task 3: Ruling: chunk rule replaced: remaining ≤60 s → one piece; else cut near the middle (target = start+min(45, rem/2), window ±15 s clipped to [start+15, start+60]) at the longest VAD silence, else quietest 50 ms — "every piece 30–60 s" left no room for 60–70 s recordings and could cut inside a word — cost if wrong: piece sizes 15–60 s instead of 30–60 s.
- Task 4: Ruling: a kept word abutting a cut word gets no lead-in (cutting it would leave a stub of the cut word) — kept as built; T14 dry run listens to cut points; if onsets clip, add a small lead-in (~0.04 s) at cut boundaries — cost if wrong: clipped first consonant after removed fillers.
- Task 5: Ruling: subtitle grouping = phrases (break after .?!… or pause > 0.35 s), each phrase split into n = ceil(len/N) balanced chunks (legacy finish.py rule); N = n_words for karaoke/plate, 6 for accumulate; Plan 2 T5 text and Plan 3 T11 sampleState updated (docs commit) — cost if wrong: groups differ from the old fixed-chunk reading of the brief; preview mirrors via punctuation only.
- Task 6: Ruling: StyleSpec.hook.y optional 120–1530, default 400 (centre of caps line), CTA same height — spec §5.5 lists title position in the style; schema lacked it — cost: one optional field.
- Task 6: Ruling: `node --test tests/` fails on Node 22 → `node --test "tests/*.test.mjs"` (npm test) — cost: none.
- Task 6: Ruling: subtitles centred on the safe zone x=475, subtitles.y = vertical centre, box clamped into Y 120–1530; shrink ×0.94 (floor 0.3) to fit karaoke/plate 2 lines, word 1, accumulate 2 (≥0.8×) else 3 — cost if wrong: layout tweaks.
- Task 6: Ruling: accent test checks the share of accent pixels in the active word box, not one centre pixel — centre may fall between strokes.
- Task 6: Ruling: helpers template/browser.mjs + template/serve.mjs (Chromium cannot fetch fonts.json over file://); T8 reuses them; custom fonts → T8 serves a merged fonts.json from a first root.
- Task 7: Ruling: no rotation/wobble/spring for badge/sticker/anim (spec: no rotation; appearance by anim ease-out) — cost: legacy look slightly calmer.
- Task 7: Ruling: InsertState x,y = top-left; src = URL (relative to overlay.html or absolute) — T8 serves job/asset files and passes URLs; fullscreen kind is refused by the template (ffmpeg's job).
- Task 8: Ruling: inner interval borders quantized to the 30 fps grid, last interval ends exactly at D + hold; whatever is visible on the last video frame stays through the hold; anim inserts get one interval per frame (t = s since show), static inserts t = 0 — cost if wrong: retiming tweaks.
- Task 8: Ruling: render-frames prints JSON {frames, intervals, duration} (brief: "prints the number of frames"); options --root DIR (repeatable) and --fonts DIR — cost: none.
- Task 9: implemented inline, commit d228912 (vm/zoom.py, 9 tests). Ruling: zoompan (z by input time it, x=fx*(iw-iw/zoom), y=fy*(ih-ih/zoom), d=1, s=1080x1920, fps=30) instead of scale eval=frame + crop — crop clamps x/y to its configured (first-frame) input size, so the face moved 25–38 px; zoompan keeps it ≤ 2 px — cost if wrong: zoompan integer window offsets (≤ ~1 px jitter during 0.45 s transitions).
- Task 8: Ruling: an insert placed wholly inside a cut shows at the next kept moment for 1.5 s (pinned by test) — the moment Claude chose was cut, the next kept moment is the nearest — cost if wrong: an unwanted insert after a cut.
- Task 11: Ruling: unreadable fullscreen file (probe fails or no decodable frame) is a note in missing and the render goes on, like a missing file — consistent with "чего-то не хватает — монтировать без этого и сказать" — cost if wrong: a video without a cutaway instead of an error.
- Task 11: Ruling: GIF cutaways loop for the window (-stream_loop -1 -t); images hold; videos shorter than the window stay on their last frame (overlay eof repeat) — cost if wrong: a meme that should play once.
- Task 11: Ruling: bar height rounds up to even (15 → 16 px) — yuv420p overlay starts on even rows — cost if wrong: 1 px.
- Task 11: Ruling: keep clamped to floor(duration·30 + 0.01) frames of the source (container duration can exceed the video by an AAC frame); warning when > 0.1 s of source is dropped. QA must take the render's own duration (carry to T12 fix: check_render gets render's report) — cost if wrong: a silent trim of a bad keep.
- Task 12: Ruling: insert identity = edit index n in the overlay state, echoed by drawInserts into boxes.json (template change) — boxes are the only thing QA reads — cost if wrong: one more field in the state (PNG cache key per insert index).
- Task 12: Ruling: the music gate checks (a) render's notes naming the music file or no music in the mix, (b) the music file's own first 0.5 s peak ≥ −50 dB; the mix-level head check is removed (speech masks it) — cost if wrong: a track whose music starts after 0.5 s of near-silence passes if it is louder than −50 dB.
- Task 12: Ruling: check_render(final, edit, boxes, report) — expected duration from render's report (render clamps keep to the source) — cost if wrong: none found.
- Task 13: Ruling: prepare is incremental — source.mp4 rebuilt when missing; an existing words.json skips ASR, cut plan (when cuts.json exists) and the sheet; --redo for everything — spec: render/fix must not re-recognise speech; one command for every step — cost if wrong: a stale words.json from an aborted analyze is reused (use --redo).
- Task 13: Ruling: spec §5.9 "перед полным рендером — 4 контрольных кадра и проверка геометрии" → new `vm check` (layer + check_layout + composed frames source+layer, no zoom/colour/cutaways) before `vm render`; render reuses the layer (key = events + style + insert file stamps) — cost if wrong: a check frame without zoom differs slightly from the final.
- Task 13: Ruling: intermediate source.mp4 x264 ultrafast crf 16 (was veryfast). Measured on Pavel's real 4:25 4K HEVC clip (rotation −90): fetch 51 s; normalize 7 min 48 s at veryfast (1710 CPU-s, 367 % CPU, 0.85 GB RSS, 1.12 GB file); per 20 s excerpt: decode 17.6 s, +scale 20.7 s, +veryfast 34.7 s (83 MB), +ultrafast 24.1 s (154 MB), +superfast crf18 30.0 s — decode of 4K HEVC is half the time; every later session re-normalizes (source.mp4 is not in git) — cost if wrong: ~1.85× intermediate size (≈2 GB for 4.5 min) on a 30 GB disk.
- Task 13: Ruling: status pushes are best-effort (warning) — the final push carries status.json anyway — cost if wrong: the page shows a phase late.
- Task 14: Ruling: question pictures are JPEG frames with a yellow box (vm preview --out q-<id>.jpg --mark) — the spec asks for a frame "с отметкой, куда он показывает" — cost if wrong: the mark is a box, not an arrow.
- Task 14: Ruling: the skill builds edit.json with a Python snippet (Job.write validates), not by hand — hundreds of words — cost if wrong: none found.
- Task 14: Ruling: hook.y rule in the skill (above the face if y ≤ face_top − 240, else below at ≥ face_bottom + 115) and vm check as the arbiter; default face (0.5, 0.33) puts the hook at y≈970 — cost if wrong: hooks lower than Pavel expects; he can change the rule.
- Final: Ruling: I3 uses afftdn=nr=12:nf=-50:tn=1 when the source is quieter than −30 LUFS, not the reviewer's nf=-25 (that floor would treat quiet speech as noise) — cost if wrong: hiss between −30 and −25 LUFS stays.
- Final: Ruling: I1 — the Action script stays as is: the engine no longer writes empty outputs and the script has no test harness — cost if wrong: a future empty output would block delivery again.
- Final: Ruling: M4 — job sessions do not add animation types to template/ (spec §5.8 allows it in the job branch): the page draws previews from master's template, so a job-branch animation breaks preview = final, and jobs/<id>/ is the session's write boundary — cost if wrong: a new animation needs a master change.
- Final: Ruling: vm render prints «не хватило: …» instead of «нет: …» — the notes are now Russian sentences that start with «нет» — cost: none.
- Final: Ruling: (declined) move-job-outputs.sh reads only the first 100 releases — stands: the job's draft is among the newest — cost if wrong: delivery misses after 100+ newer releases.
- Final: Ruling: (declined) cloud-setup.sh does not probe drawtext/drawgrid/tile/xstack/zoompan/tpad — stands: the same image passes every test; a missing filter fails with ffmpeg's own message — cost: a confusing first error if the image changes.
- Final: Ruling: (declined) job branches cut from master pin the engine/template/SKILL/assets a job started with — stands (deterministic jobs); fonts added mid-job → M3 — cost: such a font fails the render.
- Final: Ruling: (declined) Plan 3's insert option `skip` vs RESERVED `none` — the page uses RESERVED.none like the SKILL; Plan 3 T10/T11 tests use `none` (also in the Plan 3 ledger) — cost: none.
- Final: Ruling: (declined) the 25-min stuck threshold stays; the SKILL now refreshes the status every ~10 min (M7) — cost: none.
- Final: Ruling: (declined) template visuals (hand word overhang, long CTA shrink), long words in the safe zone — stand, pinned by template tests — cost: none.
- Final: Ruling: (declined) routine-prompt.md is still the spike prompt — Plan 3 Task 13; fetch lists releases with all assets — fine for one user; frame.png has no grade/zoom — preview = final is about text and inserts; git ops without network timeouts — already a deferred minor.

## Отложенные мелочи (38)

- Task 1: minor (deferred): `referencing` not listed in pyproject deps (jsonschema>=4.18 pulls it).
- Task 1: minor (deferred): no Job.validate(name)/read(validate=True) for files Claude writes directly (T13 may add).
- Task 1: minor (deferred): schema constraints enforced but not pinned by tests (keep shape, speed>0, hold>=0, status.at pattern...).
- Task 1: minor (deferred): cross-field gaps (choice without options, image/fullscreen without src, sticker without text/title, t1<t0, unordered keep, typo'd optional keys).
- Task 1: minor (deferred): no network timeout guard on git operations.
- Task 1: minor (deferred): cosmetic _message for items:false; test_git.py:262 asserts only "git" in err.
- Task 1: minor (deferred): no test pins the tracked-file-grew-past-95-MB branch of git._oversized (re-reviewer verified it works).
- Task 2: minor (deferred): no normalize test for iPhone-native -90 rotation, rotation+HDR combined (Review Focus line 1), VFR source, non-zero stream start_time — reviewer probes show all work; verify on Pavel's real iPhone clip.
- Task 2: minor (deferred): source A/V start offset erased (each stream re-anchored at 0) — iPhone offsets assumed ~0, unmeasured.
- Task 2: minor (deferred): DV-only HDR (no HLG/PQ transfer tag) fails late in zscale (iPhone 8.4 unaffected).
- Task 2: minor (deferred): signal kill (OOM) gives empty error text; test helpers hide ffmpeg stderr; label content not asserted; silent mixed-shape fitting; nits (Probe.fps comment, tuple indexing, unused {tmp}, duplicated ffmpeg helpers, -sseof re-encode).
- Task 3: minor (deferred): pause ranking uses whole pause length, not the in-window part (asr.py:289) — valid sizes, not always "near the middle".
- Task 3: minor (deferred): _quietest uses non-overlapping 50 ms frames (50 ms resolution).
- Task 3: minor (deferred): sherpa-onnx unpinned (behaviour measured on 1.13.8); private job._atomic_write import; nits (tone naming, shadowed spans, t1 rounding ≤0.5 ms past end, load_words read errors unwrapped, _whisper imports before file check).
- Task 3: minor (deferred): skips can hide slow coverage (espeak missing → skip; models-loaded-once test trivially true without Whisper).
- Task 4: minor (deferred): plan_keep does not validate duration (NaN/negative → [] silently) — carry to T13 CLI (validate probe duration).
- Task 4: minor (deferred): no test pins words beyond the clip end (asr clamps them); docstring cites spike results for the 35 ms figure that lives in the ledger ruling.
- Task 5: minor (deferred): _Spoken.t0/t1 are final times while _Spoken.word.t0/t1 are source times (naming hazard); EPS defined in both cuts.py and subs.py; events of a block share one `words` list object.
- Task 7: minor (deferred): image cache keyed by URL never evicts (a changed file at the same URL keeps the old size — Plan 3 uses ?v=<head>); no InsertState validation in the template (engine validates x/y/w); legacy xR/iconPaths/shine/pulse/rot dropped; untitled sticker bottom padding 30.
- Task 6: minor (deferred): word-mode underline hops with descenders (by design); silent overflow at the fit floor (no QA flag); no readiness signal beyond the load event.
- Task 8: minor (deferred): hook.until inside a leading cut gives no hook (only QA would notice); only render failures carry the 'промежуток i' prefix.
- Task 9: minor (deferred): plateau renders 1.0811 (zoompan truncation); ~2 px face wobble during ramps; '+-' formatting for zoom-outs.
- Task 10: minor (deferred): AAC/M4A music loops with ~26 ms seams; missing ffprobe reported as unreadable files.
- Task 11: minor (deferred): no A/V-sync assertion across many cuts in tests; cutaway colour not graded like the main picture. Lint note: run ruff from engine/ (from the repo root `vm` counts as third-party → I001).
- Task 12: minor (deferred): M2 face box for landscape sources / zoom growth / euclid corner gap; titles get +40 face but not +20 subs; M4 more boundary pins (890/120 edges, gap values, format/no-audio branches, sheet order); M5 unknown slot keys ignored, sheet without captions, bare CalledProcessError, non-atomic qa.png; M7 W/H re-declared.
- Task 13: minor (deferred): token on curl argv (real tokens only outside the cloud session); same-size stale in/source.* trusted; VIDEO whitelist vs manifest ext; prepare reaches into asr._model/_missing; frames --grid does not print the frame size; GitError re-export/PART_SIZE duplicate/split_outputs in the entry module; QA sheet of four black cells when nothing is shown.
- Final: minor (deferred): M3 a missing insert picture or chosen font stops check/render (SKILL says mount without it; skill-level fallback works).
- Final: minor (deferred): M5 no command gives final-time positions for result.json «done» lines (hook, CTA, inserts).
- Final: minor (deferred): M6 accumulate ignores subtitles.words; SKILL says «3–6 слов в блоке».
- Final: minor (deferred): M8 the last status before delivery reads «Готово» (phase «Загружаю» would be clearer).
- Final: minor (deferred): M9 VAD protection keeps wordless fillers/breaths (1.0 s on the real clip).
- Final: minor (deferred): M10 no listening check of a real false-start cut (word stubs possible with adjacent GigaAM words).
- Final: minor (deferred): M11 the dry run never exercised the code-word question.
- Final: minor (deferred): M12 SVG logos are not covered by the SKILL (the page shows only raster question pictures).
- Final: minor (deferred): M14 `vm frames --at T1 T2 <jobdir>` fails with the job folder last.
- Final: minor (deferred): re-run the analyze → render dry run with a fresh agent per step on the real clip (the class of gap I2 was).
- Final: minor (deferred): layer cache per state across runs (each vm check on a 2:47 final redraws ~564 PNGs, ~50 s).
- Final: minor (deferred): a helper that pre-aligns GigaAM words to reference.txt punctuation and casing.
