"""Фильтры кусков ролика (`edit.looks[].look`): ч/б стиля эталона и фильтры, которые Павел выбирает руками в редакторе.

`bw` — ч/б эталона: его рисует `render.BW` прямо в YUV (без цвета и темнее). Остальные — цепочки функций CSS filter
(Filter Effects 1): страница красит ими `<video>` в редакторе (web/lib/picture.ts, LOOK_CSS), а движок считает те же
функции в RGB 16 бит (`rgb_chain`), после каждой — в [0, 1], как браузер. Кадр финала = CSS-фильтр на кадре с лёгким
цветокором (`render.COLOR`), кадр редактора — тот же фильтр на прокси без цветокора, как и у кадров без фильтра.

Ни одна функция цепочки, кроме последней, не выводит цвет за [0, 1] (проверка — tests/test_looks.py): браузер, который
склеивает функции в одну матрицу и не режет цвет между ними, рисует то же.
"""
import math

KINDS = ("bw", "sepia", "warm", "cold", "film")  # порядок кнопок в редакторе (web/lib/edits.ts, LOOK_KINDS)
LOOKS: dict[str, tuple[tuple[str, float], ...]] = {
    "sepia": (("brightness", 0.74), ("sepia", 1), ("contrast", 1.1)),  # тёплое ч/б, как старое фото
    "warm": (("brightness", 0.89), ("sepia", 0.35), ("contrast", 1.08)),  # цвет теплее
    "cold": (("brightness", 0.74), ("grayscale", 1), ("sepia", 0.55), ("hue-rotate", 190), ("contrast", 1.12)),  # синеватое ч/б
    "film": (("contrast", 0.84), ("saturate", 0.72), ("sepia", 0.14), ("brightness", 1.03)),  # плёнка: мягче, теплее
}
DEPTH = 65535  # RGB 16 бит


def css_matrix(name: str, value: float) -> list[list[float]]:
    """Матрица функции CSS filter (Filter Effects 1, на значениях sRGB): grayscale, sepia, saturate, hue-rotate (градусы)."""
    if name == "grayscale":
        a = 1 - value
        return [[0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a],
                [0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a],
                [0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a]]
    if name == "sepia":
        a = 1 - value
        return [[0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a],
                [0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a],
                [0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a]]
    if name == "saturate":
        s = value
        return [[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
                [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
                [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]]
    if name == "hue-rotate":
        c, s = math.cos(math.radians(value)), math.sin(math.radians(value))
        return [[0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
                [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
                [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]]
    raise ValueError(f"не матричная функция CSS filter: {name}")


def css_filter(look: str) -> str:
    """Текст CSS filter фильтра `look` — так его пишет страница (LOOK_CSS)."""
    return " ".join(f"{name}({value:g}{'deg' if name == 'hue-rotate' else ''})" for name, value in LOOKS[look])


def _step(name: str, value: float) -> str:
    if name == "brightness":
        return f"colorchannelmixer=rr={value:g}:gg={value:g}:bb={value:g}"
    if name == "contrast":
        half = DEPTH / 2
        expr = f"clip((val-{half:g})*{value:g}+{half:g}\\,0\\,{DEPTH})"
        return f"lutrgb=r='{expr}':g='{expr}':b='{expr}'"
    m = css_matrix(name, value)
    keys = ("rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb")
    return "colorchannelmixer=" + ":".join(f"{k}={v:.6f}" for k, v in zip(keys, (x for row in m for x in row), strict=True))


def rgb_chain(look: str) -> str:
    """Фильтры ffmpeg для кадров фильтра `look`: YUV (BT.709, tv-диапазон) → RGB 16 бит → функции CSS по порядку
    (каждая режет цвет в [0, 1]) → обратно в yuv420p BT.709."""
    steps = ",".join(_step(name, value) for name, value in LOOKS[look])
    return (f"scale=in_color_matrix=bt709:in_range=tv,format=gbrp16le,{steps},"
            "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p")


def paint(windows: list[tuple[int, int, str]]) -> list[tuple[int, int, str]]:
    """Окна кусков `(первый кадр, после последнего, фильтр)` по порядку списка → окна без перекрытий: на общих кадрах —
    фильтр того, что позже; соседние окна одного фильтра — одно окно. По порядку кадров."""
    spans: list[tuple[int, int, str]] = []
    for a, b, look in windows:
        if b <= a:
            continue
        rest = []
        for x, y, k in spans:
            if x < a:
                rest.append((x, min(y, a), k))
            if y > b:
                rest.append((max(x, b), y, k))
        spans = [s for s in rest if s[1] > s[0]] + [(a, b, look)]
    out: list[tuple[int, int, str]] = []
    for x, y, k in sorted(spans):
        if out and out[-1][1] == x and out[-1][2] == k:
            out[-1] = (out[-1][0], y, k)
        else:
            out.append((x, y, k))
    return out
