"""CLI движка для Claude: python -m vm <команда> <папка задачи> …

    fetch    входные файлы из черновика job-<id> → in/
    prepare  in/ → source.mp4, work/source.wav, language.json, words.json, reference.txt, cuts.json, sheet.png; сводка
             (--lang — язык ролика по ответу Павла)
    frames   кадры исходника в моменты --at (с --grid — с сеткой) → look/
    preview  кадр исходника для превью → frame.png (или --out: картинка к вопросу, с --mark — с рамкой)
    validate файлы задачи по схемам и файлы, на которые они ссылаются
    style    итоговый стиль по styles.json и answers.json (для edit.json.style)
    fonts    шрифты, в которых есть все буквы текста ролика (для styles.json.fonts), и чего каким не хватает
    check    до рендера: слой по edit.json, проверка геометрии и 4 контрольных кадра → look/check.png
    render   финал по edit.json → out/final[-vN].mp4|.srt, qa/qa.png, result.json
    push     коммит и пуш папки задачи (с --outputs — большие файлы out/ режутся на части)
    status   записать status.json (и при --push отправить)

С `--status` долгие команды пишут фазы в status.json и пушат его — страница показывает их Павлу.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

from . import fonts
from .fetch import fetch
from .git import MAX_FILE_BYTES, GitError, push
from .job import Job, set_status, states, validate
from .media import extract_frame, grid_frames
from .prepare import prepare
from .qa import (
    check_layout,
    check_render,
    checklist,
    compose_frames,
    control_frames,
    face_box,
    slot_times,
)
from .render import _resolve, draw_layer, render, variant_b
from .style import final_style

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
    _stepper(job, args.state, args.status)("Скачиваю видео", "Забираю загруженные файлы")
    files = fetch(job)
    for name, path in files.items():
        print(f"{name}: {path.relative_to(job.root)} ({path.stat().st_size / 1024 / 1024:.1f} МБ)")


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
    path = extract_frame(job.path("source.mp4"), args.at, job.path(args.out), mark=args.mark)
    what = "для превью (styles.json: frameTime)" if args.out == "frame.png" else "— картинка для вопроса"
    print(f"{path.relative_to(job.root)} — кадр {args.at:g} с {what}")


CHECKED = ("status.json", "questions.json", "answers.json", "styles.json", "review.json", "edit.json", "result.json", "script.json")


def _files(job: Job, name: str, data: dict, unchecked: set[str] | None = None) -> list[str]:
    """Файлы, на которые ссылаются данные и которых нет: картинки вопросов и кадр превью — от папки задачи (так их
    берёт страница); вставки, звуки и музыка edit.json — от папки задачи или корня репозитория (так их берёт рендер).
    Файлы `in/…` появляются только после `vm fetch` (шаг restyle идёт без него): пока исходника `in/source.*` нет, их
    не проверить — они попадают в `unchecked`, а не в потерянные. Сама папка `in/` — ещё не признак: в ней с первого
    коммита лежит копия логотипа бренда (`in/brand/`)."""
    lost = []
    fetched = any(job.path("in").glob("source.*"))

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
    print(json.dumps(final_style(styles, answers), ensure_ascii=False, indent=2))


def _fonts(args: argparse.Namespace) -> None:
    """Шрифты для текста ролика. Есть черновик edit.json — текст из него и из вариантов хука и написаний в
    questions.json (рисуется только это; сырые words.json и reference.txt бывают с мусором — ♪, лишняя греческая
    буква); черновика нет — из words.json и reference.txt. Список без единого шрифта — все шрифты и предупреждение:
    без кнопок Павлу нечего выбрать."""
    job = _job(args)
    if job.path("edit.json").is_file():
        main_text, hand_text = fonts.texts(job.read("edit.json"))
        if job.path("questions.json").is_file():
            labels = [o["label"] for q in job.read("questions.json")["questions"] if q["id"] in ("hook", "word")
                      for o in q.get("options") or []]  # fmt: skip
            main_text, hand_text = "\n".join([main_text, *labels]), "\n".join([hand_text, *labels])
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
    """Шрифты стиля edit.json с буквами ролика — до тяжёлой работы: иначе превью и ролик разойдутся."""
    if problems := fonts.check(job.read("edit.json")):
        raise ValueError("шрифты:\n" + "\n".join(f"  - {line}" for line in problems))


def _beats_line(beats: dict | None) -> str | None:
    """Строка вывода о монтаже в такт (`render`/`draw_layer` → `beats`); без музыки — None."""
    if not beats:
        return None
    if not beats["bpm"]:
        return "в такт музыке: ровного ритма в треке нет — зумы и вставки на своих местах"
    return f"в такт музыке ({round(beats['bpm'])} уд/мин): к долям подвинуто событий — {beats['moved']}"


def _check(args: argparse.Namespace) -> None:
    job = _job(args)
    _fonts_ok(job)
    layer = draw_layer(job)
    edit = layer.edit
    problems = check_layout(layer.boxes, face_box(edit.get("face")), edit.get("inserts"))
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
    edit = job.read("edit.json")
    variant = variant_b(edit) if edit.get("ab") else None  # вторая версия A/B-теста; ошибка в ab — до сборки
    step("Монтирую", "Собираю ролик: нарезка, текст, вставки, звук")
    result = render(job, job.path("out"), name=name, preset=args.preset)
    for done in (f"{name}.mp4", f"{name}.srt"):  # части прошлого push --outputs — от старого ролика
        drop_parts(job.path("out"), done)
    step("Проверяю", "Смотрю контрольные кадры и геометрию")
    final = job.path(f"out/{name}.mp4")
    boxes = json.loads(job.path("work/render/frames/boxes.json").read_text(encoding="utf-8"))
    problems = check_layout(boxes, face_box(edit.get("face")), edit.get("inserts")) + check_render(final, edit, boxes, result)
    frames = control_frames(final, slot_times(boxes), job.path("qa"))
    checks = checklist(final, boxes, result)  # по гайду — для экрана «Готово»
    second = None
    if variant:  # без тизера или без музыки, со своим слоем
        step("Монтирую", "Собираю вторую версию для теста")
        result_b = render(job, job.path("out"), name=f"{name}-b", preset=args.preset, edit=variant, work="work/render-b")
        for done in (f"{name}-b.mp4", f"{name}-b.srt"):
            drop_parts(job.path("out"), done)
        boxes_b = json.loads(job.path("work/render-b/frames/boxes.json").read_text(encoding="utf-8"))
        final_b = job.path(f"out/{name}-b.mp4")
        problems_b = check_layout(boxes_b, face_box(variant.get("face")), variant.get("inserts")) + check_render(final_b, variant, boxes_b, result_b)
        second = {"differs": edit["ab"], "durations": result_b["durations"], "qa": {"ok": not problems_b, "problems": problems_b}}
        print(f"{final_b.relative_to(job.root)}: {result_b['durations']['final']:.1f} с — версия B, {'без тизера' if edit['ab'] == 'teaser' else 'без музыки'}")
        for line in problems_b:
            print(f"  версия B: {line}")
    previous = job.read("result.json") if job.path("result.json").is_file() else {}
    job.write(
        "result.json",
        {
            "durations": result["durations"],
            "done": previous.get("done", []),
            "unsure": previous.get("unsure", []),
            "missing": result["missing"],
            "qa": {"ok": not problems, "problems": problems},
            **({"caption": previous["caption"]} if previous.get("caption") else {}),  # подпись к посту — от Claude
            **({"ab": second} if second else {}),
            "checklist": checks,
        },
    )
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


def drop_parts(out: Path, name: str) -> None:
    """Убрать `<name>.part-*` и `<name>.sha256` из out/: они от прежней версии файла."""
    for stale in [*out.glob(f"{name}.part-*"), out / f"{name}.sha256"]:
        stale.unlink(missing_ok=True)


def split_outputs(job: Job) -> list[Path]:
    """Файлы out/ больше 95 МБ → `<имя>.part-aa`, `-ab`, … по 95 МБ и `<имя>.sha256` (как `split -b 95M -a 2` и
    `sha256sum`); целый файл уходит в work/out/ (в git его нет). Их склеит Action job-outputs. → новые части.
    У каждого целого файла сначала убираются части прежней версии (иначе Action склеил бы и их); скрытые файлы —
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
        sub.add_argument("--status", action="store_true", help="писать фазы в status.json и пушить")
        sub.add_argument("--state", choices=["analyzing", "rendering"], default="analyzing",
                         help="состояние задачи в status.json: analyzing (analyze, restyle) или rendering (render, fix)")
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

    command("validate", _validate, "файлы задачи по схемам и файлы, на которые они ссылаются")

    command("style", _style, "итоговый стиль: вариант из answers.json с выбранными шрифтами и цветами (для edit.json.style)")

    command("fonts", _fonts, "шрифты, в которых есть все буквы текста ролика, и чего каким не хватает")

    command("check", _check, "до рендера: слой, проверка геометрии и контрольные кадры → look/check.png")

    render_ = command("render", _render, "финал по edit.json → out/, qa/, result.json")
    render_.add_argument("--version", type=_version, help="номер версии: 1 — final, 2 и дальше → final-vN (правки)")
    render_.add_argument("--preset", default="medium", help="пресет x264 (для проверок — ultrafast)")
    render_.add_argument("--status", action="store_true", help="писать фазы в status.json и пушить")

    push_ = command("push", _push, "коммит и пуш папки задачи")
    push_.add_argument("-m", "--message", required=True, help="сообщение коммита")
    push_.add_argument("--outputs", action="store_true", help="файлы out/ больше 95 МБ — частями (их склеит Action)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        args.run(args)
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as err:
        # RuntimeError — это и GitError, MediaError, RenderError, FetchError, ошибки soundfile
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())


__all__ = ["GitError", "main", "split_outputs"]
