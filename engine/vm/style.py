"""Итоговый стиль ролика: `spec` варианта, выбранного Павлом на превью, с его шрифтом, рукописным, тремя цветами
(текст, подсветка, шкала), высотой и размером субтитров и хука, если он их поменял (`subY`, `hookY`, `subSize`,
`hookSize`); остальное — как у варианта. То же правило — у страницы (web/lib/style.ts): превью и
финал рисуются одним `spec`. Общая фикстура — tests/fixtures/style-merge.json.

Размер вставок (`answers.insertSizes`) — не стиль: `sized_inserts` меняет ширину вставок edit.json так же, как
страница на превью (web/lib/style.ts, sizedInserts; общая фикстура — tests/fixtures/insert-sizes.json)."""
import copy
import math

CHOSEN_COLORS = ("text", "accent", "bar")
ADJUSTED = {"subY": ("subtitles", "y"), "hookY": ("hook", "y"), "subSize": ("subtitles", "size"), "hookSize": ("hook", "size")}


SAFE_X = (60, 890)  # безопасная зона по горизонтали, px кадра (как в qa.py и template/overlay.js)


def insert_key(insert: dict) -> str | None:
    """Ключ вставки для размера Павла: её question («добавь сюда»), иначе src; ни того ни другого — None."""
    return insert.get("question") or insert.get("src") or None


def sized_inserts(inserts: list[dict], sizes: dict[str, float]) -> list[dict]:
    """Вставки с шириной, которую Павел выбрал на превью (`answers.insertSizes`): центр по горизонтали и верх
    остаются, вставка не выходит из безопасной зоны. Вставки без размера (и fullscreen — без x, w) — как были."""
    out = []
    for insert in inserts:
        key = insert_key(insert)
        w = sizes.get(key) if key else None
        if w is None or "w" not in insert or "x" not in insert:
            out.append(dict(insert))
            continue
        x = insert["x"] + (insert["w"] - w) / 2
        x = min(max(x, SAFE_X[0]), SAFE_X[1] - w)
        out.append({**insert, "x": math.floor(x + 0.5), "w": w})  # округление как Math.round на странице
    return out


def final_style(styles: dict, answers: dict) -> dict:
    """styles.json и answers.json → StyleSpec для `edit.json.style`."""
    choice = answers["style"]
    variant = next((v for v in styles["variants"] if v["id"] == choice["variant"]), None)
    if variant is None:
        raise ValueError(f"styles.json: нет варианта {choice['variant']}, который выбран в answers.json")
    spec = copy.deepcopy(variant["spec"])
    spec["font"], spec["hand"] = choice["font"], choice["hand"]
    spec["colors"] = {**spec["colors"], **{key: choice["colors"][key] for key in CHOSEN_COLORS}}
    for key, (part, field) in ADJUSTED.items():
        if key in choice:
            spec[part][field] = choice[key]
    return spec
