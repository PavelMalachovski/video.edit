"""Звук финала одним графом `filter_complex` для ffmpeg: голос, музыка, звуки появления вставок.

Голос ускоряется так же, как картинка (`atempo`), выравнивается к −14 LUFS (`loudnorm`) и добивается тишиной до
конца ролика вместе со стоп-кадром — длина ровно `final_dur`. Музыка — с первого кадра до последнего: громкость
`gainDb`, под речью тише примерно на 3 дБ, вход 0,1 с, выход 1 с в самом конце; короткий трек повторяется, длинный
обрезается. Звук вставки — −13 дБ точно в момент её появления (время финала). Сумма не выходит за −1,5 дБ.
Файла нет или он не читается — его пропускаем и пишем в предупреждения: ролик без звука вставки лучше, чем никакого.
Метки графа начинаются с `a_` (кроме выхода `[aout]`), чтобы не столкнуться с метками картинки в той же команде.
"""
import math
import subprocess
from pathlib import Path

RATE = 48000
FORMAT = f"aresample={RATE},aformat=sample_fmts=fltp:sample_rates={RATE}:channel_layouts=stereo"
# loudnorm меряет громкость окнами по 3 с: на беззвучном голосе короче 3 с он выдаёт NaN (и портит музыку через
# приглушение), поэтому короткий голос сначала добивается тишиной до 3 с — лишнее потом отрезается
LOUDNORM = "apad=whole_dur=3,loudnorm=I=-14:TP=-1.5:LRA=11"
# loudnorm ставит последнему неполному куску метку времени как полному: перенумеровываем отсчёты по порядку,
# иначе обрезка по времени отрезала бы конец (звук выходил короче ролика на 0–100 мс)
RETIME = "asetpts=N/SR/TB"
# Тихая запись (дизайн, §5.9): loudnorm поднимает её шум вместе с голосом, поэтому до него — шумоподавление.
# Порог — интегральная громкость исходника; afftdn сам следит за уровнем шума (tn=1) и убирает до 12 дБ.
QUIET_LUFS = -30.0
DENOISE = "afftdn=nr=12:nf=-50:tn=1"
SFX_GAIN_DB = -13
FADE_IN = 0.1
FADE_OUT = 1.0
# Приглушение музыки под речью: сжатие от голоса почти до тишины, смешанное с исходной музыкой (mix). Под речью
# остаётся 1 − mix·(1 − g) ≈ 0,7 от громкости (g — остаток после сжатия, 0,05…0,2), то есть около −3 дБ. Голос для
# управления берётся уже после loudnorm — поэтому глубина почти не зависит от того, громко или тихо записана речь.
DUCK = "sidechaincompress=threshold=0.01:ratio=20:attack=10:release=250:knee=1:makeup=1:mix=0.33"
LIMIT = "alimiter=limit=0.84:level=false:latency=1"  # −1,5 дБ, без задержки звука
MIN_MUSIC = 0.5  # с — короче (или без длины) музыкальный файл считаем нечитаемым: повтор такого вешает ffmpeg


def _probe(path: Path) -> tuple[int | None, float | None]:
    """(каналов у первой звуковой дорожки, длина файла в с); не читается — (None, None)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels:format=duration",
             "-of", "default=nw=1", str(path)],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None, None
    fields = dict(line.split("=", 1) for line in out.split() if "=" in line)
    try:
        channels = int(fields["channels"]) if fields.get("channels") else None
    except ValueError:
        channels = None
    try:
        duration = float(fields["duration"])
    except (KeyError, ValueError):
        duration = None
    return channels, duration


def _source(channels: int) -> str:
    """Начало цепочки для файла: моно раскладывается в оба канала без потери громкости (ffmpeg по умолчанию
    ставит моно в стерео на −3 дБ), дальше — общий формат."""
    return ("pan=stereo|c0=c0|c1=c0," if channels == 1 else "") + FORMAT


def _num(v: float) -> str:
    return f"{v:.6f}"


def _label(name: str) -> str:
    return name if name.startswith("[") else f"[{name}]"


def audio_graph(
    voice: str,
    speed: float,
    final_dur: float,
    music: dict | None,
    sfx: list[tuple[float, Path]],
    inputs_offset: int,
    denoise: bool = False,
) -> tuple[list[str], str, list[str]]:
    """→ (аргументы `-i` для музыки и звуков, граф для `-filter_complex` с выходом `[aout]`, предупреждения).

    `voice` — метка голоса в графе (`[0:a]` или выход склейки); `final_dur` — длина ролика со стоп-кадром;
    `sfx` — `(время финала, файл)`; `inputs_offset` — номер первого добавленного входа; `denoise` — тихая
    запись: шумоподавление до выравнивания громкости."""
    if not 0.5 <= speed <= 100:
        raise ValueError(f"speed must be between 0.5 and 100 (atempo), got {speed!r}")
    if not final_dur > 0:
        raise ValueError(f"final_dur must be positive, got {final_dur!r}")
    end = _num(final_dur)
    inputs: list[str] = []
    warnings: list[str] = []
    chains: list[str] = []
    index = inputs_offset
    probed: dict[Path, tuple[int | None, float | None]] = {}

    def probe(path: Path) -> tuple[int | None, float | None]:
        if path not in probed:
            probed[path] = _probe(path) if path.is_file() else (None, None)
        return probed[path]

    def warn(text: str) -> None:
        if text not in warnings:
            warnings.append(text)

    tempo = f"atempo={speed:g}," if abs(speed - 1) > 1e-9 else ""
    clean = f"{DENOISE}," if denoise else ""
    chains.append(f"{_label(voice)}{tempo}{FORMAT},{clean}{LOUDNORM},{FORMAT},{RETIME},apad=whole_dur={end},atrim=end={end}[a_vo]")
    parts = ["[a_vo]"]

    if music:
        path = Path(music["file"])
        channels, length = probe(path)
        if channels and length and length >= MIN_MUSIC:
            loops = max(0, math.ceil(final_dur / length) - 1)
            inputs += ["-stream_loop", str(loops), "-i", str(path)]
            fade = min(FADE_OUT, final_dur)
            chains.append("[a_vo]asplit=2[a_vmix][a_vsc]")
            chains.append(
                f"[{index}:a]{_source(channels)},{RETIME},volume={float(music.get('gainDb', -18)):g}dB,atrim=end={end},"
                f"afade=t=in:st=0:d={min(FADE_IN, final_dur):g},afade=t=out:st={_num(final_dur - fade)}:d={_num(fade)}[a_mu]"
            )
            chains.append(f"[a_mu][a_vsc]{DUCK}[a_md]")
            parts = ["[a_vmix]", "[a_md]"]
            index += 1
        else:
            warn(f"музыка {path.name} не найдена или не читается — ролик без неё")

    for k, (t, file) in enumerate(sfx):
        path = Path(file)
        channels, _ = probe(path)
        if not channels:
            warn(f"звук {path.name} не найден или не читается — вставка без звука появления")
            continue
        inputs += ["-i", str(path)]
        delay = max(0, round(t * 1000))
        chains.append(f"[{index}:a]{_source(channels)},volume={SFX_GAIN_DB}dB,adelay=delays={delay}:all=1[a_s{k}]")
        parts.append(f"[a_s{k}]")
        index += 1

    if len(parts) == 1:
        chains.append("[a_vo]anull[aout]")
    else:
        chains.append(
            f"{''.join(parts)}amix=inputs={len(parts)}:normalize=0:duration=first,{LIMIT},{RETIME},atrim=end={end}[aout]"
        )
    return inputs, ";".join(chains), warnings
