"""Кадры из TMDB для разбора персонажа (`vm tmdb`, шаг analyze; решение Павла 30.10.2026 — свои перебивки Павла в
первую очередь, недостающее Claude находит сам).

По `job.json.character` (`film`, `name?`, `actor?`): фильм или сериал (поиск на русском, точное название — первым),
актёр (имя от Павла — поиском, иначе — по имени персонажа в ролях; персонаж назван как сериал — по оригинальному
названию), кадры с актёром из этого фильма (`tagged_images`), кадры фильма без надписей (`backdrops`, лучшие по
оценке) и фото актёра (`profiles`). Скачивает их в `found/tmdb-<n>.jpg` (кадры — w780, фото — h632) и пишет
`found/tmdb.json` и лист `look/found.png` — Claude смотрит его и ставит кадры как перебивки (`src: found/tmdb-<n>.jpg`).
`found/` коммитится в ветку задачи: рендер берёт кадры от папки задачи, редактор — с ветки (`/api/jobs/[id]/file`).

Токен — `TMDB_TOKEN` (API Read Access Token, Bearer) в переменных окружения рутины; сеть — `api.themoviedb.org` и
`image.tmdb.org` (картинки — без токена). Бесплатный ключ TMDB — для некоммерческого использования.
"""
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

from .job import Job

API = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p"
STILLS = 12  # кадров из фильма
PHOTOS = 6  # фото актёра
SIZES = {"still": "w780", "photo": "h632"}
TIMEOUT = 20


class TmdbError(RuntimeError):
    """Что не так с поиском — по-русски, для сводки Claude."""


Get = Callable[[str, str | None], bytes]


def _get(url: str, token: str | None) -> bytes:
    """GET с токеном (только к API); ошибки — TmdbError с понятным текстом."""
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=TIMEOUT) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise TmdbError("TMDB отказал (401): токен TMDB_TOKEN не подходит") from e
        raise TmdbError(f"TMDB ответил {e.code} на {url.split('?')[0]}") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise TmdbError(f"нет доступа к {urllib.parse.urlparse(url).hostname}: {e} — откройте домен в сети окружения") from e


def _api(get: Get, token: str, path: str, **query) -> dict:
    url = f"{API}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    return json.loads(get(url, token))


def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", " ", str(text).lower().replace("ё", "е")).strip()


def _title(get: Get, token: str, film: str) -> dict:
    """Фильм или сериал: из результатов поиска — точное название (своё или оригинальное), иначе — первый."""
    found = [r for r in _api(get, token, "/search/multi", query=film, language="ru-RU").get("results") or []
             if r.get("media_type") in ("movie", "tv")]
    if not found:
        raise TmdbError(f"TMDB не нашёл «{film}» — кадры из фильма загрузите сами")
    want = _norm(film)
    names = lambda r: [_norm(r.get(k) or "") for k in ("title", "name", "original_title", "original_name")]
    best = next((r for r in found if want in names(r)), found[0])
    return {"kind": best["media_type"], "id": best["id"], "name": best.get("title") or best.get("name") or film,
            "original": best.get("original_title") or best.get("original_name") or ""}


def _person(get: Get, token: str, title: dict, character: dict) -> dict | None:
    """Актёр: имя от Павла — поиском; иначе — по имени персонажа в ролях; не нашёлся — None (только кадры фильма)."""
    if character.get("actor"):
        people = _api(get, token, "/search/person", query=character["actor"], language="ru-RU").get("results") or []
        return {"id": people[0]["id"], "name": people[0]["name"]} if people else None
    name = character.get("name")
    if not name:
        return None
    wanted = {_norm(name)}
    if _norm(name) in (_norm(title["name"]), _norm(title["original"])) and title["original"]:
        wanted.add(_norm(title["original"]))  # «Локи» в сериале «Локи» — в ролях он Loki
    path = f"/tv/{title['id']}/aggregate_credits" if title["kind"] == "tv" else f"/movie/{title['id']}/credits"
    for member in _api(get, token, path).get("cast") or []:
        roles = [r.get("character") or "" for r in member.get("roles") or []] or [member.get("character") or ""]
        if any(w and w in _norm(role) for role in roles for w in wanted):
            return {"id": member["id"], "name": member["name"]}
    return None


def _stills(get: Get, token: str, title: dict, person: dict | None) -> list[str]:
    """Кадры: сначала с актёром из этого фильма, потом кадры фильма без надписей, потом с надписями — лучшие по оценке."""
    picked: list[str] = []
    if person:
        tagged = _api(get, token, f"/person/{person['id']}/tagged_images").get("results") or []
        picked += [x["file_path"] for x in tagged if x.get("image_type") == "backdrop" and x.get("media_type") == title["kind"]
                   and (x.get("media") or {}).get("id") == title["id"]]
    images = _api(get, token, f"/{title['kind']}/{title['id']}/images", include_image_language="null,en,ru")
    backdrops = sorted(images.get("backdrops") or [], key=lambda b: (b.get("iso_639_1") is not None, -(b.get("vote_average") or 0)))
    picked += [b["file_path"] for b in backdrops if b["file_path"] not in picked]
    return picked[:STILLS]


def _photos(get: Get, token: str, person: dict | None) -> list[str]:
    if not person:
        return []
    profiles = _api(get, token, f"/person/{person['id']}/images").get("profiles") or []
    return [p["file_path"] for p in sorted(profiles, key=lambda p: -(p.get("vote_average") or 0))][:PHOTOS]


def find(job: Job, token: str | None = None, get: Get = _get) -> dict:
    """Ищет и скачивает кадры разбора персонажа задачи → `found/tmdb.json`: `{title, person, files: [{file, kind:
    still|photo, source, width, height}], sheet}`."""
    meta = job.read("job.json")
    character = meta.get("character") or {}
    if meta.get("format") != "character" or not character.get("film"):
        raise TmdbError("задача — не разбор персонажа (нет job.json.character.film): искать нечего")
    token = token or os.environ.get("TMDB_TOKEN")
    if not token:
        raise TmdbError("нет TMDB_TOKEN в окружении рутины — кадры из фильма загрузите сами")
    title = _title(get, token, character["film"])
    person = _person(get, token, title, character)
    plan = [("still", p) for p in _stills(get, token, title, person)] + [("photo", p) for p in _photos(get, token, person)]
    out = job.path("found")
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("tmdb-*.jpg"):
        old.unlink()
    files = []
    for n, (kind, source) in enumerate(plan, 1):
        data = get(f"{IMG}/{SIZES[kind]}{source}", None)  # картинки — с CDN, без токена
        path = out / f"tmdb-{n}.jpg"
        path.write_bytes(data)
        width, height = _size(path)
        files.append({"file": f"found/tmdb-{n}.jpg", "kind": kind, "source": source, "width": width, "height": height})
    found = {"title": {k: title[k] for k in ("kind", "id", "name")}, "person": person, "files": files,
             "sheet": _sheet(job, files)}
    job.path("found/tmdb.json").write_text(json.dumps(found, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return found


def _size(path: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as im:
        return im.size


def _sheet(job: Job, files: list[dict]) -> str | None:
    """Лист кадров для Claude: по 4 в ряд, у каждого — номер (tmdb-<n>)."""
    if not files:
        return None
    from PIL import Image, ImageDraw

    cell, cols = 270, 4
    rows = (len(files) + cols - 1) // cols
    sheet = Image.new("RGB", (cell * cols, cell * rows), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    for i, f in enumerate(files):
        with Image.open(job.path(f["file"])) as im:
            im = im.convert("RGB")
            im.thumbnail((cell - 8, cell - 8))
            x, y = (i % cols) * cell, (i // cols) * cell
            sheet.paste(im, (x + (cell - im.width) // 2, y + (cell - im.height) // 2))
        draw.rectangle((x + 4, y + 4, x + 44, y + 26), fill=(0, 0, 0))
        draw.text((x + 10, y + 8), str(i + 1), fill=(255, 220, 60))
    path = job.path("look/found.png")
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)
    return "look/found.png"


def summary(found: dict) -> str:
    """Сводка `vm tmdb` для Claude."""
    title, person = found["title"], found.get("person")
    lines = [f"TMDB: «{title['name']}» ({'сериал' if title['kind'] == 'tv' else 'фильм'}, id {title['id']}); "
             + (f"актёр — {person['name']}" if person else "актёра не нашёл — только кадры фильма")]
    names = {"still": "кадр", "photo": "фото"}
    lines += [f"  {f['file']} — {names[f['kind']]} {f['width']}×{f['height']}" for f in found["files"]]
    if found.get("sheet"):
        lines.append(f"Лист с номерами — {found['sheet']}: посмотри его и ставь подходящие как перебивки (src — путь выше)")
    return "\n".join(lines)
