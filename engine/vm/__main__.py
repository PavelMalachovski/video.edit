"""CLI движка для Claude: python -m vm <команда> <папка задачи> …

    fetch    входные файлы из черновика job-<id> → in/
    prepare  in/ → source.mp4, work/source.wav, language.json, words.json, reference.txt, cuts.json, sheet.png; сводка
             (--lang — язык ролика по ответу Павла)
    frames   кадры исходника в моменты --at (с --grid — с сеткой) → look/
    broll    перебивки (uploads kind broll): лист кадров каждого клипа → look/broll-<b>.png, длина, звук и речь; сводка
    preview  кадр исходника для превью → frame.png (или --out: картинка к вопросу, с --mark — с рамкой, --dim — фон темнее)
    validate файлы задачи по схемам и файлы, на которые они ссылаются
    style    итоговый стиль по styles.json и answers.json (для edit.json.style)
    fonts    шрифты, в которых есть все буквы текста ролика (для styles.json.fonts), и чего каким не хватает
    check    до рендера: слой по edit.json, проверка геометрии и 4 контрольных кадра → look/check.png
    render   финал по edit.json → out/final[-vN].mp4|.srt, qa/qa.png, result.json
    push     коммит и пуш папки задачи (с --outputs — большие файлы out/ режутся на части)
    status   записать status.json (и при --push отправить)
    wait     ждать долгую команду, запущенную с --detach (не дольше --max с): её вывод и код; ещё идёт — код 3

С `--status` долгие команды пишут фазы в status.json и пушат его — страница показывает их Павлу. С `--detach` (fetch,
prepare, render) команда уходит в фон своим процессом (вывод — work/<команда>.log), конец ждёт `vm wait` (background.py).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import background, edits, fonts, matte, warm
from .fetch import fetch
from .git import MAX_FILE_BYTES, GitError, push
from .job import Job, set_status, states, validate
from .media import extract_frame, grid_frames, probe
from .prepare import prepare
from .qa import (
    ADS_SAFE,
    SAFE,
    check_layout,
    check_render,
    checklist,
    compose_frames,
    control_frames,
    face_box,
    slot_times,
)
from .render import (
    COVER_ZONE,
    _resolve,
    draw_layer,
    render,
    render_cover,
    timeline,
    variant_ad,
    variant_b,
)
from .render import _matte as render_matte
from .style import final_style, merge_style
from .timeline import Timeline
from .zoom import zoom_at

SERVICE = ("own", "none", "upload")  # служебные варианты вопросов: их подписи — интерфейс страницы
PART_SIZE = 95 * 1024 * 1024  # как `split -b 95M`: столько же, сколько MAX_FILE_BYTES


def _job(args: argparse.Namespace) -> Job:
    return Job(Path(args.jobdir))


def _stepper(job: Job, state: str, enabled: bool):
    """Колбэк фаз: с --status — status.json и пуш только его, иначе ничего. Пуш статуса — не повод бросать работу:
    не вышел — предупреждение в stderr, команда идёт дальше (следующая фаза или итоговый push его догонят)."""

    def step(phase: str, message: str) -> None:
        if enabled:
            set_status(job, state=state, phase=phase, message=message)
            try:
                push(job, f"status({job.id}): {phase}", paths=["status.json"])
            except GitError as err:
                print(f"внимание: статус «{phase}» не отправлен: {err}", file=sys.stderr)

    return step


def _status(args: argparse.Namespace) -> None:
    job = _job(args)
    status = set_status(
        job,
        state=args.state,
        phase=args.phase,
        message=args.message,
        needs=args.needs,
        progress=args.progress,
        error=args.error,
    )
    if args.push:  # только status.json: остальные файлы задачи уходят своим push (тяжёлое режется перед этим)
        push(job, f"status({job.id}): {args.phase}", paths=["status.json"])
    print(f"{job.id}: {status['state']} / {status['phase']}" + (" (pushed)" if args.push else ""))


def _fetch(args: argparse.Namespace) -> None:
    job = _job(args)
    warm.start(analyze=not job.path("editor.json").is_file())  # пока качается видео — модели или Chromium с диска
    _stepper(job, args.state, args.status)("Скачиваю видео", "Забираю загруженные файлы")
    files = fetch(job, originals=args.originals)
    for name, path in files.items():
        ready = " — готовый исходник из черновика: vm prepare не нормализует видео заново" if name == "source.mp4" else ""
        print(f"{name}: {path.relative_to(job.root)} ({path.stat().st_size / 1024 / 1024:.1f} МБ){ready}")


def _matte_ahead(args: argparse.Namespace) -> None:
    """Маска затемнения фона по плотной резке заранее (шаг analyze): рендер возьмёт свои куски из неё готовыми."""
    job = _job(args)
    if reason := matte.unavailable():
        print(f"маска фона: {reason} — затемнения фона в ролике не будет")
        return
    if not (job.path("cuts.json").is_file() and job.path("source.mp4").is_file()):
        raise ValueError("нет cuts.json или source.mp4 — сначала vm prepare")
    keep = [(float(a), float(b)) for a, b in job.read("cuts.json")["keep"]]
    os.nice(10)  # фоном: команды Claude в это время (vm check, vm preview) — первыми
    _, note = render_matte(job, Timeline(keep, 1.0))
    if note:
        print(note)
    elif list(job.path("out").glob(f"matte-{matte.job_key(job)}.*")):
        print("маска фона по плотной резке — в out/: уйдёт с vm push в черновик, рендер возьмёт её готовой")
    else:
        print("маска фона посчитана, но в out/ не легла (больше 95 МБ): рендер посчитает свою")


def _broll(args: argparse.Namespace) -> None:
    from . import broll

    print(broll.summary(broll.describe(_job(args))))


def _prepare(args: argparse.Namespace) -> None:
    job = _job(args)
    print(prepare(job, _stepper(job, args.state, args.status), redo=args.redo, language=args.lang))


def _frames(args: argparse.Namespace) -> None:
    job = _job(args)
    source = job.path("source.mp4")
    look = job.path("look")
    if args.grid:
        paths = grid_frames(source, args.at, look)
    else:
        paths = [extract_frame(source, t, look / f"frame_{t:08.3f}.png") for t in args.at]
    for p in paths:
        print(p.relative_to(job.root))


def _preview(args: argparse.Namespace) -> None:
    job = _job(args)
    source, mask = job.path("source.mp4"), None
    if args.dim:  # фон темнее — по маске человека этого кадра, как в ролике с edit.dim
        if reason := matte.unavailable():
            raise RuntimeError(f"затемнение фона: {reason}")
        try:
            mask = matte.frame_matte(source, args.at, job.path("work/preview-matte.png"))
        except Exception as err:  # и исключения onnxruntime — понятной строкой, а не трассировкой
            raise RuntimeError(f"затемнение фона: {err}") from err
    path = extract_frame(source, args.at, job.path(args.out), mark=args.mark, fill=True, mask=mask, dim=args.dim)
    what = "для превью (styles.json: frameTime)" if args.out == "frame.png" else "— картинка для вопроса"
    print(f"{path.relative_to(job.root)} — кадр {args.at:g} с {what}" + (f", фон темнее на {args.dim:.0%}" if args.dim else ""))


CHECKED = ("status.json", "questions.json", "answers.json", "styles.json", "review.json", "edit.json", "timeline.json", "result.json",
           "script.json")


def _files(job: Job, name: str, data: dict, unchecked: set[str] | None = None) -> list[str]:
    """Файлы, на которые ссылаются данные и которых нет: картинки вопросов и кадр превью — от папки задачи (так их
    берёт страница); вставки, звуки и музыка edit.json — от папки задачи или корня репозитория (так их берёт рендер).
    Файлы `in/…` появляются только после `vm fetch` (шаг restyle идёт без него): пока нет ни видео `in/source.*`, ни
    `source.mp4` (готовый исходник fetch кладёт сразу туда), их не проверить — они попадают в `unchecked`, а не в
    потерянные. Сама папка `in/` — ещё не признак: в ней с первого коммита лежит копия логотипа бренда (`in/brand/`)."""
    lost = []
    fetched = any(job.path("in").glob("source.*")) or job.path("source.mp4").is_file()

    def need(field: str, rel: str, render: bool = False) -> None:
        if render and not fetched and rel.startswith("in/"):
            if unchecked is not None:
                unchecked.add(rel)
            return
        found = _resolve(job, rel) is not None if render else (job.root / rel).resolve().is_file()
        if not found:
            lost.append(f"{name}: {field}: нет файла {rel}")

    if name == "questions.json":
        for i, q in enumerate(data["questions"]):
            if q.get("image"):
                need(f"questions[{i}].image", q["image"])
            for k, option in enumerate(q.get("options") or []):
                if option.get("image"):
                    need(f"questions[{i}].options[{k}].image", option["image"])
    elif name == "styles.json":
        need("frame", data["frame"])
        for i, f in enumerate((data.get("cover") or {}).get("frames") or []):  # кадры обложки — vm preview
            need(f"cover.frames[{i}].image", f["image"])
    elif name == "edit.json":
        for i, ins in enumerate(data["inserts"]):
            for key in ("src", "sfx"):
                if ins.get(key):
                    need(f"inserts[{i}].{key}", ins[key], render=True)
        if data.get("music"):
            need("music.file", data["music"]["file"], render=True)
    return lost


def _validate(args: argparse.Namespace) -> None:
    job = _job(args)
    problems, checked, unchecked = [], [], set()
    for name in CHECKED:
        if not job.path(name).is_file():
            continue
        checked.append(name)
        try:
            data = job.read(name)
            validate(name, data)
        except ValueError as err:
            problems.append(str(err))
            continue
        problems += _files(job, name, data, unchecked)
    if problems:
        raise ValueError("\n".join(problems))
    print("в порядке: " + (", ".join(checked) or "файлов со схемой нет"))
    if unchecked:
        print("не проверял (in/uploads/ появится после vm fetch): " + ", ".join(sorted(unchecked)))


def _style(args: argparse.Namespace) -> None:
    job = _job(args)
    styles, answers = job.read("styles.json"), job.read("answers.json")
    validate("styles.json", styles)
    validate("answers.json", answers)
    spec = final_style(styles, answers)
    if args.onto:  # «Монтировать» из редактора: новый выбор поверх стиля ролика (правки текстом остаются)
        fixes = job.read("fix.json").get("fixes") if job.path("fix.json").is_file() else None
        before = fixes[-1].get("styleFrom") if fixes else None
        if before and job.path("edit.json").is_file():
            validate("answers.json", {**answers, "style": before})
            spec = merge_style(final_style(styles, {"style": before}), job.read("edit.json")["style"], spec)
    print(json.dumps(spec, ensure_ascii=False, indent=2))


def _fonts(args: argparse.Namespace) -> None:
    """Шрифты для текста ролика. Есть черновик edit.json — текст из него и из вариантов хука и написаний в
    questions.json (рисуется только это; сырые words.json и reference.txt бывают с мусором — ♪, лишняя греческая
    буква); черновика нет — из words.json и reference.txt. Список без единого шрифта — все шрифты и предупреждение:
    без кнопок Павлу нечего выбрать."""
    job = _job(args)
    if job.path("edit.json").is_file():
        main_text, hand_text = fonts.texts(edits.edit_of(job))  # с текстом, что Павел поправил в редакторе
        if job.path("questions.json").is_file():
            questions = job.read("questions.json")["questions"]

            def options(keep) -> list[str]:  # «Свой», «Не надо» — кнопки страницы, не текст ролика
                return [o["label"] for q in questions if keep(q) for o in q.get("options") or [] if o["id"] not in SERVICE]

            labels = options(lambda q: q["id"] == "hook" or q["type"] == "word")  # хук и написания слов
            calls = options(lambda q: q["id"] == "end")  # призыв финальной карточки
            main_text, hand_text = "\n".join([main_text, *labels, *calls]), "\n".join([hand_text, *labels])
        hand_text = f"{hand_text}\n{main_text}"  # рукописным может стать любое слово хука — с запасом
    else:
        parts = [w["text"] for w in json.loads(job.path("words.json").read_text(encoding="utf-8"))] if job.path("words.json").is_file() else []
        if job.path("reference.txt").is_file():
            parts.append(job.path("reference.txt").read_text(encoding="utf-8"))
        main_text = hand_text = "\n".join(parts)
    catalog = fonts.catalog()
    covering = fonts.coverage(main_text, hand_text)
    notes = []
    for kind, text, role in (("main", main_text, "основном"), ("hand", hand_text, "рукописном")):
        if not covering[kind]:
            kinds = [f for f in catalog if f.kind == kind]
            covering[kind] = [f.id for f in kinds]
            nowhere = set.intersection(*(set(fonts.missing(f, text)) for f in kinds))
            notes.append(f"ВНИМАНИЕ: ни в одном {role} шрифте нет букв {''.join(sorted(nowhere))} — в списке все; "
                         "выбери тот, где не хватает меньше всего, и скажи об этом в unsure")
    print(json.dumps(covering, ensure_ascii=False))
    for note in notes:
        print(note)
    for font in catalog:
        if lack := fonts.missing(font, main_text if font.kind == "main" else hand_text):
            print(f"нет букв: {font.id} — {lack}")


def _fonts_ok(job: Job) -> None:
    """Шрифты стиля edit.json с буквами ролика — до тяжёлой работы: иначе превью и ролик разойдутся. Текст — с правками
    Павла из редактора (timeline.json: слова субтитров, текст хука, титра, акцентов и вставок)."""
    source = job.path("source.mp4")
    if problems := fonts.check(edits.edit_of(job, probe(source).duration if source.is_file() else None)):
        raise ValueError("шрифты:\n" + "\n".join(f"  - {line}" for line in problems))


def _beats_line(beats: dict | None) -> str | None:
    """Строка вывода о монтаже в такт (`render`/`draw_layer` → `beats`); без музыки — None."""
    if not beats:
        return None
    if not beats["bpm"]:
        return "в такт музыке: ровного ритма в треке нет — зумы и вставки на своих местах"
    return f"в такт музыке ({round(beats['bpm'])} уд/мин): к долям подвинуто событий — {beats['moved']}"


def _zoom(edit: dict, tl: Timeline):
    """Уровень зума edit.json в момент финала — для проверки лица: крупный план делает лицо больше."""
    zooms = edit.get("zooms") or []
    return lambda t: zoom_at(zooms, tl, t)


def _layout(boxes: list[dict], edit: dict, tl: Timeline, safe: dict = SAFE) -> list[str]:
    """Геометрия слоя: лицо — такого размера, каким его делает зум в каждый момент (смена крупности, наезд)."""
    return check_layout(boxes, face_box(edit.get("face")), edit.get("inserts"), safe=safe, zoom=_zoom(edit, tl))


def _check(args: argparse.Namespace) -> None:
    job = _job(args)
    _fonts_ok(job)
    layer = draw_layer(job)
    edit = layer.edit
    problems = _layout(layer.boxes, edit, layer.tl)
    frames = compose_frames(job.path("source.mp4"), layer.boxes, layer.frames.parent, layer.tl, slot_times(layer.boxes),
                            job.path("look"))
    print(f"слой нарисован: {len(layer.boxes)} промежутков, {layer.tl.duration:.1f} с (без стоп-кадра)")
    print(f"контрольные кадры: {frames['sheet'].relative_to(job.root)} — кадр исходника и слой; зум, цвет, шкала"
          " и перебивки видны только после render")
    for line in filter(None, [_beats_line(layer.beats)]):
        print(line)
    for line in layer.warnings:
        print(f"внимание: {line}")
    print("геометрия: " + ("всё в порядке" if not problems else "проблемы:"))
    for line in problems:
        print(f"  - {line}")


def _render(args: argparse.Namespace) -> None:
    job = _job(args)
    step = _stepper(job, "rendering", args.status)
    name = "final" if args.version in (None, 1) else f"final-v{args.version}"
    _fonts_ok(job)
    source = job.path("source.mp4")
    edit = edits.edit_of(job, probe(source).duration if source.is_file() else None)  # с правками Павла (timeline.json)
    variant = variant_b(edit) if edit.get("ab") else None  # вторая версия A/B-теста; ошибка в ab — до сборки
    previous = job.read("result.json") if job.path("result.json").is_file() else {}
    if previous:  # done, unsure и подпись Claude переносятся в новый result.json: кривые — ошибка до кодирования
        validate("result.json", previous)
    step("Монтирую", "Собираю ролик: нарезка, текст, вставки, звук")
    result = render(job, job.path("out"), name=name, preset=args.preset)
    for done in (f"{name}.mp4", f"{name}.srt"):  # части прошлого push --outputs — от старого ролика
        drop_parts(job.path("out"), done)
    for extra in ("b", "ad", "cover"):  # прежние версия B, реклама и обложка — не от этого ролика: будут — соберутся заново
        _drop_outputs(job, f"{name}-{extra}")
    step("Проверяю", "Смотрю контрольные кадры и геометрию")
    final = job.path(f"out/{name}.mp4")
    boxes = json.loads(job.path("work/render/frames/boxes.json").read_text(encoding="utf-8"))
    problems = _layout(boxes, result.get("edit", edit), timeline(edit)) + check_render(final, edit, boxes, result)
    frames = control_frames(final, slot_times(boxes), job.path("qa"))
    checks = checklist(final, boxes, result)  # по гайду — для экрана «Готово»
    summary = {
        "durations": result["durations"],
        "done": previous.get("done", []),
        "unsure": previous.get("unsure", []),
        "missing": result["missing"],
        "qa": {"ok": not problems, "problems": problems},
        **({"caption": previous["caption"]} if previous.get("caption") else {}),  # подпись к посту — от Claude
        "checklist": checks,
    }
    job.write("result.json", summary)  # итоги A — сразу: упадут обложка или версия B, они уже от этого ролика
    if edit.get("cover"):  # обложка для сетки профиля: кадр исходника и хук крупно
        step("Монтирую", "Рисую обложку")
        cover = job.path(f"out/{name}-cover.png")
        problems += _cover_problems(render_cover(job, result.get("edit", edit), cover))
        summary["qa"] = {"ok": not problems, "problems": problems}
        job.write("result.json", summary)
        print(f"обложка: {cover.relative_to(job.root)}")
    if variant:  # без тизера или без музыки, со своим слоем
        if edit["ab"] == "music":  # без музыки — те же события, что встали на доли в версии A: отличается только звук
            variant = variant_b(result.get("edit", edit))
        step("Монтирую", "Собираю вторую версию для теста")
        result_b = render(job, job.path("out"), name=f"{name}-b", preset=args.preset, edit=variant, work="work/render-b")
        for done in (f"{name}-b.mp4", f"{name}-b.srt"):
            drop_parts(job.path("out"), done)
        boxes_b = json.loads(job.path("work/render-b/frames/boxes.json").read_text(encoding="utf-8"))
        final_b = job.path(f"out/{name}-b.mp4")
        problems_b = _layout(boxes_b, variant, timeline(variant)) + check_render(final_b, variant, boxes_b, result_b)
        summary["ab"] = {"differs": edit["ab"], "durations": result_b["durations"], "qa": {"ok": not problems_b, "problems": problems_b}}
        job.write("result.json", summary)
        print(f"{final_b.relative_to(job.root)}: {result_b['durations']['final']:.1f} с — версия B, {'без тизера' if edit['ab'] == 'teaser' else 'без музыки'}")
        for line in problems_b:
            print(f"  версия B: {line}")
    if edit.get("ad"):  # версия для рекламы: тот же монтаж (события на тех же долях), текст и вставки — выше кнопки рекламы
        ads = variant_ad(result.get("edit", edit))
        step("Монтирую", "Собираю версию для рекламы")
        result_ad = render(job, job.path("out"), name=f"{name}-ad", preset=args.preset, edit=ads, work="work/render-ad")
        for done in (f"{name}-ad.mp4", f"{name}-ad.srt"):
            drop_parts(job.path("out"), done)
        boxes_ad = json.loads(job.path("work/render-ad/frames/boxes.json").read_text(encoding="utf-8"))
        final_ad = job.path(f"out/{name}-ad.mp4")
        problems_ad = _layout(boxes_ad, ads, timeline(ads), safe=ADS_SAFE) + check_render(final_ad, ads, boxes_ad, result_ad)
        summary["ad"] = {"durations": result_ad["durations"], "qa": {"ok": not problems_ad, "problems": problems_ad}}
        job.write("result.json", summary)
        print(f"{final_ad.relative_to(job.root)}: {result_ad['durations']['final']:.1f} с — версия для рекламы")
        for line in problems_ad:
            print(f"  реклама: {line}")
    print(f"{final.relative_to(job.root)}: {result['durations']['final']:.1f} с (исходник {result['durations']['source']:.1f} с)")
    print(f"контрольный лист: {frames['sheet'].relative_to(job.root)}")
    voice = result.get("voice") or {}
    if voice.get("denoise"):
        print(f"звук: тихая запись ({voice['lufs']:.1f} LUFS) — убрал шум перед выравниванием громкости".replace("-", "−", 1))
    for line in filter(None, [_beats_line(result.get("beats"))]):
        print(line)
    for line in result["missing"]:
        print(f"не хватило: {line}")
    for line in result["warnings"]:
        print(f"внимание: {line}")
    misses = [c["title"] for c in checks if not c["ok"]]
    print(f"чек-лист по гайду: {len(checks) - len(misses)} из {len(checks)}" + (f" — нет: {'; '.join(misses)}" if misses else ""))
    print("проверка: " + ("всё в порядке" if not problems else "проблемы:"))
    for line in problems:
        print(f"  - {line}")


def _cover_problems(report: dict) -> list[str]:
    """Обложка — картинка 1080×1920, текст — в том, что видно в сетке профиля (кадр 3:4 по центру)."""
    size = report.get("size")
    if size and list(size) != [1080, 1920]:
        return [f"обложка: картинка {size[0]}×{size[1]} вместо 1080×1920"]
    b = report.get("box")
    if not b:
        return ["обложка: текста на ней нет"]
    z = COVER_ZONE
    if b["x"] < z["x0"] or b["x"] + b["w"] > z["x1"] or b["y"] < z["y0"] or b["y"] + b["h"] > z["y1"]:
        return [("обложка: текст выходит за то, что видно в сетке профиля (кадр 3:4 по центру) — короче текст обложки "
                 "(edit.cover.text)")]
    return []


def _drop_outputs(job: Job, base: str) -> None:
    """Убрать из out/ файлы `<base>.*` прежнего рендера и их части (версия, которую в этот раз не собирали)."""
    out = job.path("out")
    if not out.is_dir():
        return
    for stale in out.glob(f"{base}.*"):
        if stale.is_file():
            stale.unlink()


def drop_parts(out: Path, name: str) -> None:
    """Убрать `<name>.part-*` и `<name>.sha256` из out/: они от прежней версии файла."""
    for stale in [*out.glob(f"{name}.part-*"), out / f"{name}.sha256"]:
        stale.unlink(missing_ok=True)


def split_outputs(job: Job) -> list[Path]:
    """Файлы out/ больше 95 МБ → `<имя>.part-aa`, `-ab`, … по 95 МБ и `<имя>.sha256` (как `split -b 95M -a 2` и
    `sha256sum`); целый файл уходит в work/out/ (в git его нет). Их склеит страница (web/lib/outputs.ts). → новые части.
    У каждого целого файла сначала убираются части прежней версии (иначе страница склеила бы и их); скрытые файлы —
    временные файлы сборки, их не трогаем (и в git их нет)."""
    out = job.path("out")
    made: list[Path] = []
    if not out.is_dir():
        return made
    for path in sorted(out.iterdir()):
        if not path.is_file() or path.name.startswith(".") or ".part-" in path.name or path.suffix == ".sha256":
            continue
        drop_parts(out, path.name)
        if path.stat().st_size <= MAX_FILE_BYTES:
            continue
        digest = hashlib.sha256()
        letters = "abcdefghijklmnopqrstuvwxyz"
        with open(path, "rb") as src:
            for k in range(26 * 26):
                chunk_path = out / f"{path.name}.part-{letters[k // 26]}{letters[k % 26]}"
                written = 0
                with open(chunk_path, "wb") as dst:
                    while written < PART_SIZE:
                        block = src.read(min(8 * 1024 * 1024, PART_SIZE - written))
                        if not block:
                            break
                        digest.update(block)
                        dst.write(block)
                        written += len(block)
                if written == 0:
                    chunk_path.unlink()
                    break
                made.append(chunk_path)
        (out / f"{path.name}.sha256").write_text(f"{digest.hexdigest()}  {path.name}\n", encoding="utf-8")
        keep = job.path(f"work/out/{path.name}")
        keep.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), keep)
    return made


def _push(args: argparse.Namespace) -> None:
    job = _job(args)
    parts = split_outputs(job) if args.outputs else []
    push(job, args.message)
    note = f", частей: {len(parts)}" if parts else ""
    print(f"{job.id}: pushed{note}")


def _picture_name(text: str) -> str:
    if not re.fullmatch(r"[\w.-]+\.(png|jpe?g)", text) or text.startswith("."):
        raise argparse.ArgumentTypeError("имя картинки в папке задачи: буквы, цифры, '.', '-', '_' и .png/.jpg")
    return text


def _box(text: str) -> tuple[int, int, int, int]:
    try:
        x, y, w, h = (int(v) for v in text.split(","))
    except ValueError:
        raise argparse.ArgumentTypeError("рамка — четыре целых через запятую: x,y,w,h") from None
    return x, y, w, h


def _dim(text: str) -> float:
    value = float(text)
    if not 0 <= value <= 0.8:
        raise argparse.ArgumentTypeError("затемнение фона — доля от 0 до 0.8, например 0.3")
    return value


def _version(text: str) -> int:
    number = int(text)
    if number < 1:
        raise argparse.ArgumentTypeError("версия — 1, 2, 3 …")
    return number


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m vm", description="Движок монтажа video.edit")
    commands = parser.add_subparsers(dest="command", required=True)

    def command(name: str, run, help: str) -> argparse.ArgumentParser:
        sub = commands.add_parser(name, help=help)
        sub.add_argument("jobdir", help="папка задачи, например jobs/<id>")
        sub.set_defaults(run=run)
        return sub

    status = command("status", _status, "записать status.json задачи (и при --push отправить в ветку)")
    status.add_argument("--state", required=True, metavar="STATE", help="одно из: " + ", ".join(states()))
    status.add_argument("--phase", required=True, help="название фазы, например «Расшифровываю»")
    status.add_argument("--message", required=True, help="текст под фазой")
    status.add_argument("--needs", choices=["answers"], help="что ждём от Павла")
    status.add_argument("--progress", type=float, help="готовность фазы, 0..1")
    status.add_argument("--error", help="понятный текст ошибки")
    status.add_argument("--push", action="store_true", help="закоммитить status.json и запушить")

    for name, run, help in (
        ("fetch", _fetch, "скачать входные файлы из черновика job-<id> в in/"),
        ("prepare", _prepare, "исходник, слова, план резки, контактный лист (только недостающее) — и сводка"),
    ):
        sub = command(name, run, help)
        sub.add_argument("--detach", action="store_true", help=DETACH)
        sub.add_argument("--status", action="store_true", help="писать фазы в status.json и пушить")
        sub.add_argument("--state", choices=["analyzing", "rendering"], default="analyzing",
                         help="состояние задачи в status.json: analyzing (analyze, restyle) или rendering (render, fix)")
    commands.choices["fetch"].add_argument(
        "--originals", action="store_true", help="видео Павла, даже если в черновике есть готовый исходник (для prepare --redo)"
    )
    commands.choices["prepare"].add_argument("--redo", action="store_true", help="всё заново, в том числе распознавание")
    commands.choices["prepare"].add_argument(
        "--lang", help="язык ролика по ответу Павла (код или название): другой, чем в language.json, — распознать заново"
    )

    frames = command("frames", _frames, "кадры исходника в моменты --at → look/")
    frames.add_argument("--at", type=float, nargs="+", required=True, help="секунды исходника")
    frames.add_argument("--grid", action="store_true", help="с сеткой 10×10 и подписью времени")

    preview = command("preview", _preview, "кадр исходника для превью → frame.png или картинка к вопросу")
    preview.add_argument("--at", type=float, required=True, help="секунда исходника")
    preview.add_argument("--out", type=_picture_name, default="frame.png", help="имя файла в папке задачи (.png, .jpg)")
    preview.add_argument("--mark", type=_box, help="рамка x,y,w,h в px кадра — например, место вставки")
    preview.add_argument("--dim", type=_dim, default=0.0, help="фон темнее на долю 0–0.8 (картинка к вопросу «Фон»)")

    command("broll", _broll, "перебивки (job.json uploads kind broll): лист кадров каждого клипа → look/, длина, звук и речь — сводка")

    command("validate", _validate, "файлы задачи по схемам и файлы, на которые они ссылаются")

    style = command("style", _style, "итоговый стиль: вариант из answers.json с выбранными шрифтами и цветами (для edit.json.style)")
    style.add_argument("--onto", action="store_true",
                       help="«Монтировать» из редактора со стилем: новый выбор поверх edit.json.style — правки текстом остаются")

    command("fonts", _fonts, "шрифты, в которых есть все буквы текста ролика, и чего каким не хватает")

    command("check", _check, "до рендера: слой, проверка геометрии и контрольные кадры → look/check.png")

    matte_ = command("matte", _matte_ahead, "маска затемнения фона по плотной резке заранее (analyze, фоном) → out/")
    matte_.add_argument("--detach", action="store_true", help=DETACH)

    render_ = command("render", _render, "финал по edit.json → out/, qa/, result.json")
    render_.add_argument("--version", type=_version, help="номер версии: 1 — final, 2 и дальше → final-vN (правки)")
    render_.add_argument("--preset", default="veryfast", help="пресет x264: veryfast (crf 18 — втрое быстрее medium, не хуже по SSIM); для проверок — ultrafast")
    render_.add_argument("--status", action="store_true", help="писать фазы в status.json и пушить")
    render_.add_argument("--detach", action="store_true", help=DETACH)

    wait = command("wait", _wait, "ждать долгую команду, запущенную с --detach: её вывод и код; ещё идёт — код 3")
    wait.add_argument("--max", type=float, default=540, help="ждать не дольше, с (команда сессии живёт до 10 мин)")

    push_ = command("push", _push, "коммит и пуш папки задачи")
    push_.add_argument("-m", "--message", required=True, help="сообщение коммита")
    push_.add_argument("--outputs", action="store_true", help="файлы out/ больше 95 МБ — частями (их склеит страница)")
    return parser


LONG = ("fetch", "prepare", "matte", "render")  # долгие команды: отмечают себя в work/ (background.mark), умеют --detach
DETACH = "в фоне своим процессом (вывод — work/<команда>.log): сразу назад, конец ждёт `vm wait`"


def _wait(args: argparse.Namespace) -> int:
    return background.wait(_job(args), args.max)


def _run(args: argparse.Namespace) -> int:
    try:
        code = args.run(args)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as err:
        # RuntimeError — это и GitError, MediaError, RenderError, FetchError, ошибки soundfile
        print(f"error: {err}", file=sys.stderr)
        return 1
    return code if isinstance(code, int) else 0


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = _parser().parse_args(argv)
    name = argv[0] if argv else ""
    if getattr(args, "detach", False):
        job = Job(args.jobdir)
        if other := background.busy(job):  # два рендера писали бы одни файлы
            print(f"error: в фоне уже идёт vm {other} — дождись её: vm wait {args.jobdir}", file=sys.stderr)
            return 1
        background.detach(job, name, [sys.executable, "-m", "vm", *[a for a in argv if a != "--detach"]])
        print(f"vm {name} идёт в фоне (вывод — work/{name}.log); её конец — vm wait {args.jobdir}")
        return 0
    if name not in LONG:
        return _run(args)
    with background.mark(Job(args.jobdir), name) as m:
        m.code = _run(args)
    return m.code


if __name__ == "__main__":
    sys.exit(main())


__all__ = ["GitError", "main", "split_outputs"]
