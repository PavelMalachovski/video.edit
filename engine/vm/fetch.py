"""Входные файлы задачи из черновика релиза `job-<id>`: куски `<файл>.part-NNNNN` склеиваются по порядку номеров.

`source` → `in/source.<расширение из manifest.json>`; несколько видео задачи (`videos` манифеста, по порядку) —
`source`, `source-2`, … → `in/source.<расширение>`, `in/source-2.<расширение>`, …; вставки к ролику (`uploads` манифеста) и картинки к ответам
(`uploads` в answers.json) → `in/uploads/<файл>`. Другие группы `upload-*` в черновике — брошенные загрузки (картинку
выбрали заново, вставку не выбрали при продолжении): их не качаем. Размер каждого склеенного файла сверяется с
манифестом, и все группы проверяются до того, как качать тяжёлое. Уже скачанный файл нужного размера второй раз не качается; оборванный запуск продолжается с уже
скачанных кусков (`work/fetch/<файл>/`). Ходим через curl, как проверяли в облачной сессии: прокси сессии сам
авторизует GitHub для video.edit (`GITHUB_TOKEN` там — заглушка `proxy-injected`; настоящий токен из окружения
передаётся заголовком, и curl не отдаёт его на чужой хост при переходе на подписанную ссылку ассета). Обрыв
соединения (прокси сессии такое умеет) или зависший кусок curl повторяет сам.
"""
import json
import os
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .job import Job

PART = re.compile(r"^(?P<file>.+)\.part-(?P<n>\d{5})$")
VIDEO_ASSET = re.compile(r"^source(-([2-9]|10))?$")  # видео задачи по порядку: source, source-2 … source-10
PLACEHOLDERS = {"", "proxy-injected"}
PARALLEL = 8
TIMEOUT = 1800  # с на один запрос со всеми повторами (кусок 4 МБ качается секунды; потолок — от зависания)
# повторять любую ошибку, в том числе обрыв посреди куска; медленнее 1 КБ/с минуту — зависло, повторить
RETRY = ["--retry", "5", "--retry-all-errors", "--retry-delay", "2", "--connect-timeout", "20",
         "--speed-limit", "1024", "--speed-time", "60"]


class FetchError(RuntimeError):
    """Черновик, ассеты или куски не такие, как ждём; или сеть не отдала файл."""


def _api() -> str:
    return os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")


def _repo(job: Job) -> str:
    """owner/repo: из VM_REPO или GITHUB_REPOSITORY, иначе из адреса origin репозитория, где лежит задача."""
    named = os.environ.get("VM_REPO") or os.environ.get("GITHUB_REPOSITORY")
    if named:
        return named
    here = job.root
    while not here.exists():
        here = here.parent
    url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=here, capture_output=True, text=True, check=False).stdout.strip()
    m = re.search(r"([^/:]+)/([^/]+?)(?:\.git)?/?$", url)
    if not m:
        raise FetchError("не понял, какой это репозиторий: задайте VM_REPO=owner/repo")
    return f"{m[1]}/{m[2]}"


def _curl(url: str, out: Path | None = None, accept: str = "application/vnd.github+json") -> bytes:
    cmd = ["curl", "-sS", "-f", "-L", *RETRY, "--noproxy", "127.0.0.1,localhost",
           "-H", f"Accept: {accept}", "-H", "X-GitHub-Api-Version: 2022-11-28"]
    token = os.environ.get("GITHUB_TOKEN", "")
    if token not in PLACEHOLDERS:
        cmd += ["-H", f"Authorization: Bearer {token}"]
    if out is not None:
        cmd += ["-o", str(out)]
    try:
        done = subprocess.run([*cmd, url], capture_output=True, timeout=TIMEOUT, check=False)
    except subprocess.TimeoutExpired:
        raise FetchError(f"{url}: нет ответа за {TIMEOUT} с") from None
    if done.returncode != 0:
        raise FetchError(f"{url}: {done.stderr.decode(errors='replace').strip() or f'curl {done.returncode}'}")
    return done.stdout


def _pages(url: str) -> list[dict]:
    """Весь список GitHub по страницам — до пустой страницы."""
    items: list[dict] = []
    for page in range(1, 1000):
        chunk = json.loads(_curl(f"{url}{'&' if '?' in url else '?'}per_page=100&page={page}"))
        if not chunk:
            return items
        items += chunk
    raise FetchError(f"{url}: слишком длинный список")


def _release(api: str, repo: str, tag: str) -> dict | None:
    """Черновик по тегу: страницы списка — пока не найдётся (каждый релиз в списке несёт все свои ассеты)."""
    for page in range(1, 1000):
        chunk = json.loads(_curl(f"{api}/repos/{repo}/releases?per_page=100&page={page}"))
        found = next((r for r in chunk if r.get("tag_name") == tag), None)
        if found or not chunk:
            return found
    raise FetchError(f"{api}/repos/{repo}/releases: слишком длинный список")


def _asset_url(api: str, repo: str, asset: dict) -> str:
    return f"{api}/repos/{repo}/releases/assets/{asset['id']}"


def _join(api: str, repo: str, pieces: list[dict], dest: Path, work: Path) -> None:
    """Куски — параллельно во временную папку (куски нужного размера от прошлого запуска не качаются заново),
    затем подряд в dest (через временное имя)."""
    work.mkdir(parents=True, exist_ok=True)
    paths = [work / f"{i:05d}" for i in range(len(pieces))]

    def get(i: int) -> None:
        if paths[i].is_file() and paths[i].stat().st_size == pieces[i]["size"]:
            return
        _curl(_asset_url(api, repo, pieces[i]), paths[i], accept="application/octet-stream")
        if paths[i].stat().st_size != pieces[i]["size"]:
            raise FetchError(f"{pieces[i]['name']}: скачано {paths[i].stat().st_size} байт вместо {pieces[i]['size']}")

    with ThreadPoolExecutor(PARALLEL) as pool:
        list(pool.map(get, range(len(pieces))))
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(f".{dest.name}.partial")
    try:
        with open(partial, "wb") as out:
            for path in paths:
                with open(path, "rb") as src:
                    shutil.copyfileobj(src, out, 8 * 1024 * 1024)
        os.replace(partial, dest)
    finally:
        partial.unlink(missing_ok=True)
    shutil.rmtree(work, ignore_errors=True)


def _answer_uploads(job: Job) -> list[str]:
    """Ассеты картинок к ответам, на которые ссылается answers.json (`in/uploads/<ассет>`); ответов ещё нет — []."""
    if not job.path("answers.json").is_file():
        return []
    uploads = job.read("answers.json").get("uploads") or {}
    return sorted({Path(rel).name for rel in uploads.values() if isinstance(rel, str) and rel.startswith("in/uploads/upload-")})


def fetch(job: Job) -> dict[str, Path]:
    """Скачать и склеить входные файлы задачи. → {имя группы: путь} (source и upload-*)."""
    api, repo, tag = _api(), _repo(job), f"job-{job.id}"
    release = _release(api, repo, tag)
    if release is None:
        raise FetchError(f"черновик {tag} не найден в {repo}")
    assets = _pages(f"{api}/repos/{repo}/releases/{release['id']}/assets")
    named = {a["name"]: a for a in assets}
    if "manifest.json" not in named:
        raise FetchError(f"{tag}: нет manifest.json — загрузка видео не закончена")
    try:
        manifest = json.loads(_curl(_asset_url(api, repo, named["manifest.json"]), accept="application/octet-stream"))
    except json.JSONDecodeError:
        manifest = None
    uploads = manifest.get("uploads") or [] if isinstance(manifest, dict) else None
    if not isinstance(uploads, list) or not all(isinstance(u, dict) and isinstance(u.get("asset"), str) for u in uploads):
        raise FetchError(f"{tag}: manifest.json не такой, как пишет страница (объект; uploads — список с asset)")

    videos = manifest.get("videos")
    if videos is None:  # задача из одного видео (как до нескольких)
        videos = [{"asset": "source", "name": manifest.get("name"), "size": manifest.get("size"), "parts": manifest.get("parts")}]
    assets_of = [v.get("asset") if isinstance(v, dict) else None for v in videos] if isinstance(videos, list) else []
    if not (assets_of and assets_of[0] == "source" and len(set(assets_of)) == len(assets_of)
            and all(isinstance(a, str) and VIDEO_ASSET.match(a) for a in assets_of)):
        raise FetchError(f"{tag}: videos в manifest.json не такой, как пишет страница (source, source-2 … без повторов)")

    groups: dict[str, list[tuple[int, dict]]] = {}
    for a in assets:
        if m := PART.match(a["name"]):
            groups.setdefault(m["file"], []).append((int(m["n"]), a))
    targets: dict[str, tuple[Path, int | None, int | None]] = {}
    for v in videos:
        ext = Path(str(v.get("name") or "")).suffix.lower() or ".mp4"
        targets[v["asset"]] = (job.path(f"in/{v['asset']}{ext}"), v.get("size"), v.get("parts"))
    for up in uploads:
        targets[up["asset"]] = (job.path(f"in/uploads/{up['asset']}"), up.get("size"), up.get("parts"))
    for name in _answer_uploads(job):  # картинок к ответам в манифесте нет — размер не сверить
        targets.setdefault(name, (job.path(f"in/uploads/{name}"), None, None))

    plan = []  # сначала все группы: битая загрузка вставки найдётся до того, как скачаны 2 ГБ исходника
    for name, (dest, size, count) in targets.items():
        pieces = sorted(groups.get(name, []), key=lambda p: p[0])
        numbers = [n for n, _ in pieces]
        if not pieces:
            raise FetchError(f"{tag}: нет кусков {name}")
        if numbers != list(range(len(pieces))):
            lost = sorted(set(range(max(numbers) + 1)) - set(numbers))
            raise FetchError(f"{name}: не хватает кусков {', '.join(map(str, lost[:10]))}")
        if count is not None and len(pieces) != count:
            raise FetchError(f"{name}: кусков {len(pieces)}, а по манифесту {count}")
        total = sum(a["size"] for _, a in pieces)
        if size is not None and total != size:
            raise FetchError(f"{name}: куски вместе {total} байт, а по манифесту {size}")
        plan.append((name, dest, total, [a for _, a in pieces]))

    files: dict[str, Path] = {}
    for name, dest, total, pieces in plan:
        if not (dest.is_file() and dest.stat().st_size == total):
            _join(api, repo, pieces, dest, job.path(f"work/fetch/{name}"))
        files[name] = dest
    return files
