"""Кадры из TMDB для разбора персонажа (`vm tmdb`, шаг analyze; решение Павла 30.10.2026 — свои перебивки Павла в
первую очередь, недостающее Claude находит сам).

По `job.json.character` (`film`, `name?`, `actor?`): фильм или сериал (поиск фильмов и сериалов на русском: точное
название, из одноимённых — самое популярное), актёр (имя от Павла — поиском, иначе — по имени персонажа в ролях:
роли в TMDB латиницей, имя Павла сравнивается вариантами транслитерации — Гермиона ≈ Hermione), кадры с актёром из этого фильма (`tagged_images`), кадры фильма без надписей (`backdrops`, лучшие по
оценке) и фото актёра (`profiles`); почти одинаковые картинки (та же в другом размере) — один раз. Скачивает их в `found/tmdb-<n>.jpg` (кадры — w780, фото — h632) и пишет
`found/tmdb.json` и лист `look/found.png` — Claude смотрит его и ставит кадры как перебивки (`src: found/tmdb-<n>.jpg`).
`found/` коммитится в ветку задачи: рендер берёт кадры от папки задачи, редактор — с ветки (`/api/jobs/[id]/file`).

Токен — `TMDB_TOKEN` (API Read Access Token, Bearer) в переменных окружения рутины; сеть — `api.themoviedb.org` и
`image.tmdb.org` (картинки — без токена). Бесплатный ключ TMDB — для некоммерческого использования.
"""
import http.client
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
MAX_FILES = 99  # found/tmdb-<n>.jpg — n в одну-две цифры (схема timeline.json, страница)
EPISODE = "original"  # кадры серий у TMDB — только w92, w185, w300 и original; w300 для кадра 1080 мал
SEASONS = 2  # кадры серий — из первых сезонов
TIMEOUT = 20


class TmdbError(RuntimeError):
    """Что не так с поиском — по-русски, для сводки Claude."""


Get = Callable[[str, str | None], bytes]


def _request(url: str, token: str | None) -> urllib.request.Request:
    """Запрос; токен — заголовком, который не уходит дальше при переадресации (urllib иначе понёс бы его на другой хост)."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    if token:
        req.add_unredirected_header("Authorization", f"Bearer {token}")
    return req


def _get(url: str, token: str | None) -> bytes:
    """GET с токеном (только к API); любые ошибки сети и ответа — TmdbError с понятным текстом."""
    try:
        with urllib.request.urlopen(_request(url, token), timeout=TIMEOUT) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise TmdbError("TMDB отказал (401): токен TMDB_TOKEN не подходит") from e
        raise TmdbError(f"TMDB ответил {e.code} на {url.split('?')[0]}") from e
    except (OSError, http.client.HTTPException) as e:  # URLError, тайм-аут, обрыв соединения, неполный ответ
        raise TmdbError(f"нет доступа к {urllib.parse.urlparse(url).hostname}: {e} — откройте домен в сети окружения") from e


def _api(get: Get, token: str, path: str, **query) -> dict:
    url = f"{API}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    try:
        data = json.loads(get(url, token))
    except ValueError as e:  # не JSON (страница ошибки прокси)
        raise TmdbError(f"TMDB ответил не JSON на {path}") from e
    if not isinstance(data, dict):
        raise TmdbError(f"TMDB ответил не тем на {path}")
    return data


def _norm(text: str) -> str:
    return re.sub(r"[^\w]+", " ", str(text).lower().replace("ё", "е")).strip()


def _title(get: Get, token: str, film: str) -> dict:
    """Фильм или сериал: среди фильмов и сериалов с точным названием (своим или оригинальным) — самый популярный
    («Локи» Marvel, а не одноимённое аниме); точного нет — самый популярный из первых результатов."""
    found = [{**r, "media_type": kind} for kind in ("movie", "tv")
             for r in (_api(get, token, f"/search/{kind}", query=film, language="ru-RU").get("results") or [])[:10]]
    if not found:
        raise TmdbError(f"TMDB не нашёл «{film}» — кадры из фильма загрузите сами")
    want = _norm(film)
    names = lambda r: [_norm(r.get(k) or "") for k in ("title", "name", "original_title", "original_name")]
    exact = [r for r in found if want in names(r)]
    best = max(exact or found, key=lambda r: r.get("popularity") or 0)
    return {"kind": best["media_type"], "id": best["id"], "name": best.get("title") or best.get("name") or film,
            "original": best.get("original_title") or best.get("original_name") or ""}


# кириллица → латиница вариантами: в ролях TMDB имена латиницей (Гермиона — Hermione, Гарри — Harry, Хагрид — Hagrid,
# Уолтер — Walter, Джек — Jack, Мэри — Mary); сочетания — раньше букв
_PAIRS = {"дж": ["j", "dzh"], "кс": ["x", "ks"]}
_LATIN = {"а": ["a"], "б": ["b"], "в": ["v", "w"], "г": ["g", "h"], "д": ["d"], "е": ["e", "a"], "ё": ["e", "yo"],
          "ж": ["zh", "j"], "з": ["z"], "и": ["i", "y", "ee"], "й": ["y", "i", ""], "к": ["k", "c"], "л": ["l"], "м": ["m"],
          "н": ["n"], "о": ["o", "a"], "п": ["p"], "р": ["r"], "с": ["s"], "т": ["t"], "у": ["u", "w", "oo"], "ф": ["f"],
          "х": ["h", "kh"], "ц": ["ts", "c"], "ч": ["ch"], "ш": ["sh"], "щ": ["sch"], "ъ": [""], "ы": ["y"], "ь": [""],
          "э": ["e", "a"], "ю": ["yu", "u"], "я": ["ya", "ia"]}
SIMILAR = 0.75  # имя похоже на роль: в среднем по словам имени (difflib) не меньше этого…
CLOSE = 0.8  # …и хоть одно слово — не меньше этого («Рон» — не «Baron»)
VARIANTS = 64  # вариантов транслитерации слова — не больше


def _latin(word: str) -> list[str]:
    """Слово как есть и его латинские варианты (не больше VARIANTS): роль бывает и кириллицей («Данила Багров»)."""
    out, i = [""], 0
    while i < len(word):
        pair = _PAIRS.get(word[i : i + 2])
        options = pair or _LATIN.get(word[i], [word[i]])
        out = [o + v for v in options for o in out][:VARIANTS]  # сначала первый вариант каждой буквы: он и вероятнее
        i += 2 if pair else 1
    return [word, *out]


def _similar(name: str, role: str) -> float:
    """Насколько роль похожа на имя персонажа: средняя похожесть слов имени (0, если не прошла CLOSE и SIMILAR)."""
    from difflib import SequenceMatcher

    words, parts = _norm(name).split(), _norm(role).split()
    if not words or not parts:
        return 0.0
    sims = [max(SequenceMatcher(None, v, p).ratio() for v in _latin(w) for p in parts) for w in words]
    mean = sum(sims) / len(sims)
    return mean if mean >= SIMILAR and max(sims) >= CLOSE else 0.0


def role_of(name: str, roles: list[str]) -> str | None:
    """Роль, в которой персонаж `name` (как его написал Павел, хоть кириллицей), — самая похожая; нет похожей — None."""
    best = max(roles, key=lambda r: _similar(name, r), default=None)
    return best if best is not None and _similar(name, best) > 0 else None


def _person(get: Get, token: str, title: dict, character: dict) -> dict | None:
    """Актёр: имя от Павла — поиском; иначе — по имени персонажа в ролях; не нашёлся — None (только кадры фильма)."""
    if character.get("actor"):
        people = _api(get, token, "/search/person", query=character["actor"], language="ru-RU").get("results") or []
        return {"id": people[0]["id"], "name": people[0]["name"]} if people else None
    name = character.get("name")
    if not name:
        return None
    path = f"/tv/{title['id']}/aggregate_credits" if title["kind"] == "tv" else f"/movie/{title['id']}/credits"
    best, score = None, 0.0
    for member in _api(get, token, path).get("cast") or []:  # самая похожая роль во всём составе; поровну — выше в титрах
        roles = [r.get("character") or "" for r in member.get("roles") or []] or [member.get("character") or ""]
        sim = max((_similar(name, r) for r in roles), default=0.0)
        if sim > score and member.get("id") and member.get("name"):
            best, score = {"id": member["id"], "name": member["name"]}, sim
    return best


def _episodes(get: Get, token: str, title: dict) -> list[str]:
    """Кадры серий сериала (`still_path` — настоящие кадры, а не рекламный арт): первые сезоны, по порядку серий."""
    if title["kind"] != "tv":
        return []
    seasons = [x.get("season_number") for x in _api(get, token, f"/tv/{title['id']}").get("seasons") or []]
    picked: list[str] = []
    for n in [n for n in seasons if isinstance(n, int) and n >= 1][:SEASONS]:  # 0 — спецвыпуски
        picked += [e["still_path"] for e in _api(get, token, f"/tv/{title['id']}/season/{n}").get("episodes") or []
                   if e.get("still_path")]
    return picked


def _stills(get: Get, token: str, title: dict, person: dict | None) -> list[tuple[str, str]]:
    """Кадры (путь, размер): сначала с актёром из этого фильма, потом кадры серий (у сериала), потом картинки фильма без
    надписей, потом с надписями — лучшие по оценке."""
    picked: list[tuple[str, str]] = []
    if person:
        tagged = _api(get, token, f"/person/{person['id']}/tagged_images").get("results") or []
        picked += [(x["file_path"], SIZES["still"]) for x in tagged if x.get("image_type") == "backdrop"
                   and x.get("media_type") == title["kind"] and (x.get("media") or {}).get("id") == title["id"]]
    picked += [(path, EPISODE) for path in _episodes(get, token, title)]
    images = _api(get, token, f"/{title['kind']}/{title['id']}/images", include_image_language="null,en,ru")
    backdrops = sorted(images.get("backdrops") or [], key=lambda b: (b.get("iso_639_1") is not None, -(b.get("vote_average") or 0)))
    seen = {p for p, _ in picked}
    picked += [(b["file_path"], SIZES["still"]) for b in backdrops if b["file_path"] not in seen]
    return picked  # все по порядку: повторы отсеет find


def _photos(get: Get, token: str, person: dict | None) -> list[tuple[str, str]]:
    if not person:
        return []
    profiles = _api(get, token, f"/person/{person['id']}/images").get("profiles") or []
    return [(p["file_path"], SIZES["photo"]) for p in sorted(profiles, key=lambda p: -(p.get("vote_average") or 0))]


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
    for old in [*job.path("found").glob("tmdb-*.jpg"), job.path("found/tmdb.json"), job.path("look/found.png")]:
        old.unlink(missing_ok=True)  # прошлый поиск: его список не должен указывать на новые файлы
    try:
        return _find(job, token, get, character)
    except (KeyError, TypeError, IndexError) as e:  # ответ не той формы
        raise TmdbError(f"TMDB ответил не тем, что ждали ({e!r})") from e


def find_more(job: Job, token: str | None = None, get: Get = _get) -> dict:
    """«Найти ещё кадры» из редактора: запрос Павла `stills.json` (`film`, `name?`, `actor?`, `at`) — тот же поиск, новые
    картинки — после найденных раньше (их номера не меняются: на них уже стоят перебивки), повторы прежних не
    скачиваются; `found/tmdb.json.request` — `at` запроса (по нему редактор видит, что поиск сделан). Любой задачи."""
    request = job.read("stills.json") if job.path("stills.json").exists() else None
    if not isinstance(request, dict) or not str(request.get("film") or "").strip():
        raise TmdbError("нет запроса stills.json с фильмом: искать нечего")
    character = {k: str(request[k]).strip() for k in ("film", "name", "actor") if str(request.get(k) or "").strip()}
    old = json.loads(job.path("found/tmdb.json").read_text(encoding="utf-8")) if job.path("found/tmdb.json").exists() else {}
    old.pop("error", None)
    files = [f for f in old.get("files") or [] if job.path(f.get("file", "")).is_file()]
    token = token or os.environ.get("TMDB_TOKEN")
    if not token:
        _mark(job, old, files, request.get("at"), "нет TMDB_TOKEN в окружении рутины")
        raise TmdbError("нет TMDB_TOKEN в окружении рутины — кадры из фильма загрузите сами")
    seen = []
    for f in files:
        try:
            seen.append(_print(job.path(f["file"]).read_bytes()))
        except (OSError, ValueError):
            continue
    try:
        return _find(job, token, get, character, files=files, seen=seen, request=request.get("at"))
    except (KeyError, TypeError, IndexError) as e:  # ответ не той формы
        _mark(job, old, files, request.get("at"), f"TMDB ответил не тем, что ждали ({e!r})")
        raise TmdbError(f"TMDB ответил не тем, что ждали ({e!r})") from e
    except TmdbError as e:
        _mark(job, old, files, request.get("at"), str(e))
        raise


def _mark(job: Job, old: dict, files: list[dict], at: str | None, why: str) -> None:
    """Поиск «ещё» сорвался: отметка запроса и почему — редактор перестаёт ждать; прежние кадры — те же."""
    job.path("found").mkdir(parents=True, exist_ok=True)
    marked = {**old, "files": files, "request": at, "error": why}
    job.path("found/tmdb.json").write_text(json.dumps(marked, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def _find(job: Job, token: str, get: Get, character: dict, files: list[dict] | None = None, seen: list[int] | None = None,
          request: str | None = None) -> dict:
    title = _title(get, token, character["film"])
    person = _person(get, token, title, character)
    out = job.path("found")
    out.mkdir(parents=True, exist_ok=True)
    files = list(files or [])  # найденные раньше («Найти ещё») — первыми, их номера те же
    seen = list(seen or [])  # отпечатки скачанного: та же картинка в другом размере или с другим языком — повтор
    for kind, candidates, limit in (("still", _stills(get, token, title, person), STILLS), ("photo", _photos(get, token, person), PHOTOS)):
        taken = 0
        for source, size in candidates[: 3 * limit]:  # повторы отсеиваются — кандидатов с запасом
            if taken == limit or len(files) >= MAX_FILES:
                break
            try:
                data = get(f"{IMG}/{size}{source}", None)  # картинки — с CDN, без токена
                mark = _print(data)
            except (TmdbError, OSError, ValueError):  # не скачалась или не картинка — без неё
                continue
            if any((mark ^ m).bit_count() <= TWIN for m in seen):
                continue
            seen.append(mark)
            taken += 1
            n = max([0, *(int(re.sub(r"\D", "", Path(f["file"]).stem) or 0) for f in files)]) + 1
            path = out / f"tmdb-{n}.jpg"
            width, height = _save(data, path)
            files.append({"file": f"found/tmdb-{n}.jpg", "kind": kind, "source": source, "width": width, "height": height})
    found = {"title": {k: title[k] for k in ("kind", "id", "name")}, "person": person, "files": files,
             "sheet": _sheet(job, files), **({"request": request} if request else {})}
    job.path("found/tmdb.json").write_text(json.dumps(found, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return found


TWIN = 24  # из 256 бит отпечатка: ближе — та же картинка


def _print(data: bytes) -> int:
    """Отпечаток картинки: 16×16 серых точек, бит — точка светлее средней (картинку в другом размере узнаёт)."""
    import io

    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:
        px = list(im.convert("L").resize((16, 16)).tobytes())
    mean = sum(px) / len(px)
    return sum(1 << i for i, v in enumerate(px) if v > mean)


LONGEST = 1280  # px — длинная сторона найденной картинки в ветке задачи (кадр серии в original бывает 4K)


def _save(data: bytes, path: Path) -> tuple[int, int]:
    """Картинка в `path` как есть или уменьшенная до LONGEST (JPEG) → её размер."""
    import io

    from PIL import Image

    with Image.open(io.BytesIO(data)) as im:
        if max(im.size) <= LONGEST:
            path.write_bytes(data)
            return im.size
        small = im.convert("RGB")
        small.thumbnail((LONGEST, LONGEST))
        small.save(path, "JPEG", quality=88)
        return small.size


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
