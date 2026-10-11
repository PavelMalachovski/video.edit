"""Эмодзи картинками. Шрифты ролика эмодзи не рисуют, а цветные шрифты эмодзи Safari понимает не все (COLRv1 и CBDT
у Noto — нет), поэтому шаблон ставит вместо эмодзи PNG из `template/emoji/` — одни и те же пиксели на превью и в
финале. Картинки и список `index.json` собирает `build` из шрифта Noto Color Emoji (SIL OFL 1.1).

Текст делится на куски «текст / эмодзи» одним правилом здесь и в `template/emoji.js` (общая фикстура
`tests/fixtures/emoji-runs.json`): в каждом месте — самая длинная последовательность из списка; селектор U+FE0F
внутри и сразу после неё не важен. Знак, который по умолчанию текст (©, ®, ™, ❤, цифры, #, *), — эмодзи только с
U+FE0F сразу после него; без него это буква шрифта.

    PYTHONPATH=engine python3 -m vm.emoji /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf template/emoji
"""
import json
import subprocess
import sys
from functools import cache
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FOLDER = REPO / "template" / "emoji"
VS16 = 0xFE0F  # «покажи как эмодзи»

# Свойства Юникода знает Node (`\p{…}`): что эмодзи, что по умолчанию картинка, полные последовательности (RGI).
# Полная запись: после знака, который по умолчанию текст, — FE0F (если дальше не оттенок кожи).
_NODE = r"""
const seqs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const E = /^\p{Emoji}$/u, P = /^\p{Emoji_Presentation}$/u, M = /^\p{Emoji_Modifier}$/u, RGI = /^\p{RGI_Emoji}$/v;
const ch = (cp) => String.fromCodePoint(cp);
const plain = (cp) => E.test(ch(cp)) && !P.test(ch(cp));
process.stdout.write(JSON.stringify(seqs.map((s) => {
  const full = s.map((cp, i) => ch(cp) + (plain(cp) && !(i + 1 < s.length && M.test(ch(s[i + 1]))) ? '️' : '')).join('');
  return { emoji: s.length === 1 && E.test(ch(s[0])), text: s.length === 1 && plain(s[0]), rgi: RGI.test(full) || RGI.test(s.map(ch).join('')) };
})));
"""


def key(seq) -> str:
    """Имя картинки: коды без FE0F через «-», строчными: `1f468-200d-1f469`."""
    return "-".join(f"{cp:x}" for cp in seq if cp != VS16)


def build(font: Path, out: Path) -> dict:
    """Картинки всех эмодзи шрифта (CBDT: PNG как есть) и `index.json` в `out` → сам index.

    Берутся одиночные эмодзи и стандартные (RGI) последовательности; у каждой — своя картинка, даже если глиф общий
    (флаг США и флаг Внешних малых островов США). `emoji` — имена картинок; `text` — одиночные знаки, которые эмодзи
    только с FE0F; `size`, `ppem`, `baseline` — размер картинки, кегль и базовая линия (px от верха) в шрифте."""
    from fontTools.ttLib import TTFont  # тяжёлый импорт — только для сборки

    with TTFont(font) as f:
        strike = f["CBDT"].strikeData[0]
        cmap = f.getBestCmap()
        glyph_cp = {g: cp for cp, g in cmap.items()}
        seqs: dict[tuple[int, ...], str] = {(cp,): g for cp, g in cmap.items() if g in strike}
        for lookup in f["GSUB"].table.LookupList.Lookup:
            if lookup.LookupType != 4:
                continue
            for sub in lookup.SubTable:
                for first, ligatures in sub.ligatures.items():
                    for lig in ligatures:
                        parts = [first, *lig.Component]
                        if all(p in glyph_cp for p in parts) and lig.LigGlyph in strike:
                            seqs.setdefault(tuple(glyph_cp[p] for p in parts), lig.LigGlyph)
        order = list(seqs)
        props = json.loads(subprocess.run(["node", "-e", _NODE], input=json.dumps(order), capture_output=True,
                                          text=True, check=True).stdout)
        kept = {s: p for s, p in zip(order, props, strict=True) if p["emoji"] or (len(s) > 1 and p["rgi"])}
        out.mkdir(parents=True, exist_ok=True)
        for s in kept:
            bitmap = strike[seqs[s]]
            bitmap.decompile()
            (out / f"{key(s)}.png").write_bytes(bitmap.imageData)
        sample = strike[seqs[next(iter(kept))]]
        size = [sample.metrics.width, sample.metrics.height]
        ppem = f["CBLC"].strikes[0].bitmapSizeTable.ppemY
        name = f["name"].getDebugName(4) or "Noto Color Emoji"
        version = (f["name"].getDebugName(5) or "").split(";")[0].removeprefix("Version ").strip()
    index = {
        "font": f"{name} {version}".strip(),
        "license": "SIL Open Font License 1.1 (LICENSE)",
        "size": size,
        "ppem": ppem,
        "baseline": sample.metrics.BearingY,
        "emoji": sorted(key(s) for s in kept),
        "text": sorted(key(s) for s, p in kept.items() if p["text"]),
    }
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    return index


# ---------- куски текста ----------


@cache
def _index(folder: Path) -> tuple[dict, frozenset[int]]:
    """(дерево последовательностей: код → узел, у конца — имя картинки под ключом None; знаки-текст)."""
    data = json.loads((folder / "index.json").read_text(encoding="utf-8"))
    trie: dict = {}
    for name in data["emoji"]:
        node = trie
        for part in name.split("-"):
            node = node.setdefault(int(part, 16), {})
        node[None] = name
    return trie, frozenset(int(k, 16) for k in data["text"])


def runs(text: str, folder: Path = FOLDER) -> list[tuple[str, ...]]:
    """Текст → куски `("text", строка)` и `("emoji", имя картинки, исходный текст)` по порядку (правило — в начале
    модуля)."""
    trie, plain = _index(folder)
    cps = [ord(c) for c in text]
    out: list[tuple[str, ...]] = []
    buf: list[str] = []
    i = 0
    while i < len(cps):
        node, j, depth, best = trie, i, 0, None  # best: (конец, имя картинки, кодов в последовательности)
        while j < len(cps):
            if cps[j] == VS16 and j > i:
                j += 1
                if None in node:
                    best = (j, node[None], depth)
                continue
            node = node.get(cps[j])
            if node is None:
                break
            j, depth = j + 1, depth + 1
            if None in node:
                best = (j, node[None], depth)
        if best and best[2] == 1 and cps[i] in plain and not (i + 1 < len(cps) and cps[i + 1] == VS16):
            best = None  # знак-текст без FE0F — буква шрифта
        if best is None:
            buf.append(text[i])
            i += 1
            continue
        if buf:
            out.append(("text", "".join(buf)))
            buf = []
        out.append(("emoji", best[1], text[i:best[0]]))
        i = best[0]
    if buf:
        out.append(("text", "".join(buf)))
    return out


def text_only(text: str, folder: Path = FOLDER) -> str:
    """Текст без эмодзи (только куски-текст)."""
    return "".join(part[1] for part in runs(text, folder) if part[0] == "text")


def found(text: str, folder: Path = FOLDER) -> list[str]:
    """Эмодзи текста, как они в нём записаны, по порядку."""
    return [part[2] for part in runs(text, folder) if part[0] == "emoji"]


def emoji_only(text: str, folder: Path = FOLDER) -> bool:
    """В тексте есть эмодзи и нет ничего, кроме эмодзи и пробелов."""
    parts = runs(text, folder)
    return any(p[0] == "emoji" for p in parts) and all(p[0] == "emoji" or not p[1].strip() for p in parts)


def text_default(char: str, folder: Path = FOLDER) -> bool:
    """Знак — эмодзи только с U+FE0F (❤, ©, ™): без него это буква шрифта."""
    return len(char) == 1 and ord(char) in _index(folder)[1]


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("python3 -m vm.emoji <NotoColorEmoji.ttf> <папка>")
    built = build(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"{len(built['emoji'])} картинок, {len(built['text'])} знаков-текста")
