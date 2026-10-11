"""Итоговый стиль ролика: `spec` варианта, выбранного Павлом на превью, с его шрифтом, рукописным, тремя цветами
(текст, подсветка, шкала), высотой и размером субтитров и хука, если он их поменял (`subY`, `hookY`, `subSize`,
`hookSize`); остальное — как у варианта. То же правило — у страницы (web/lib/style.ts): превью и
финал рисуются одним `spec`. Общая фикстура — tests/fixtures/style-merge.json."""
import copy

CHOSEN_COLORS = ("text", "accent", "bar")
ADJUSTED = {"subY": ("subtitles", "y"), "hookY": ("hook", "y"), "subSize": ("subtitles", "size"), "hookSize": ("hook", "size")}


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
