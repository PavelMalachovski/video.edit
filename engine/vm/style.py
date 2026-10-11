"""Итоговый стиль ролика: `spec` варианта, выбранного Павлом на превью, с его шрифтом, рукописным, тремя цветами
(текст, подсветка, шкала) и высотой субтитров, если он их перетащил (`subY`); остальное — как у варианта. То же правило — у страницы (web/lib/style.ts): превью и
финал рисуются одним `spec`. Общая фикстура — tests/fixtures/style-merge.json."""
import copy

CHOSEN_COLORS = ("text", "accent", "bar")


def final_style(styles: dict, answers: dict) -> dict:
    """styles.json и answers.json → StyleSpec для `edit.json.style`."""
    choice = answers["style"]
    variant = next((v for v in styles["variants"] if v["id"] == choice["variant"]), None)
    if variant is None:
        raise ValueError(f"styles.json: нет варианта {choice['variant']}, который выбран в answers.json")
    spec = copy.deepcopy(variant["spec"])
    spec["font"], spec["hand"] = choice["font"], choice["hand"]
    spec["colors"] = {**spec["colors"], **{key: choice["colors"][key] for key in CHOSEN_COLORS}}
    if "subY" in choice:
        spec["subtitles"]["y"] = choice["subY"]
    return spec
