"""Звук финала одним графом `filter_complex` для ffmpeg: голос, музыка, звуки появления вставок.

Голос ускоряется так же, как картинка (`atempo`), выравнивается к −14 LUFS (`loudnorm`) и добивается тишиной до
конца ролика вместе со стоп-кадром. Музыка — с первого кадра до последнего: громкость `gainDb`, под речью тише
примерно на 3 дБ, вход 0,1 с, выход 1 с в самом конце; короткий трек зацикливается, длинный обрезается. Звук
вставки — −13 дБ точно в момент её появления (время финала). Файла нет — его пропускаем и пишем в предупреждения:
ролик без звука вставки лучше, чем никакого.
"""
import subprocess
from pathlib import Path

RATE = 48000
FORMAT = f"aresample={RATE},aformat=sample_fmts=fltp:sample_rates={RATE}:channel_layouts=stereo"
LOUDNORM = "loudnorm=I=-14:TP=-1.5:LRA=11"
SFX_GAIN_DB = -13
FADE_IN = 0.1
FADE_OUT = 1.0
# Приглушение музыки под речью: сжатие от голоса почти до тишины, смешанное с исходной музыкой (mix). Под речью
# остаётся 1 − mix·(1 − g) ≈ 0,7 от громкости (g — остаток после сжатия, 0,05…0,2), то есть около −3 дБ,
# и эта глубина почти не зависит от того, громко или тихо говорят.
DUCK = "sidechaincompress=threshold=0.01:ratio=20:attack=10:release=250:knee=1:makeup=1:mix=0.33"


def _channels(path: Path) -> int | None:
    """Сколько каналов у первой звуковой дорожки файла; не читается — None."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", str(path)],
            check=True, capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        return int(out.split(",")[0]) if out else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def _source(path: Path) -> str:
    """Начало цепочки для файла: моно раскладывается в оба канала без потери громкости (ffmpeg по умолчанию
    ставит моно в стерео на −3 дБ), дальше — общий формат."""
    return ("pan=stereo|c0=c0|c1=c0," if _channels(path) == 1 else "") + FORMAT


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
) -> tuple[list[str], str, list[str]]:
    """→ (аргументы `-i` для музыки и звуков, граф для `-filter_complex` с выходом `[aout]`, предупреждения).

    `voice` — метка голоса в графе (`[0:a]` или выход склейки); `final_dur` — длина ролика со стоп-кадром;
    `sfx` — `(время финала, файл)`; `inputs_offset` — номер первого добавленного входа."""
    if not speed > 0:
        raise ValueError(f"speed must be positive, got {speed!r}")
    end = _num(final_dur)
    inputs: list[str] = []
    warnings: list[str] = []
    chains: list[str] = []
    index = inputs_offset

    tempo = f"atempo={speed:g}," if abs(speed - 1) > 1e-9 else ""
    chains.append(f"{_label(voice)}{tempo}{FORMAT},{LOUDNORM},{FORMAT},apad=whole_dur={end},atrim=end={end}[vo]")
    parts = ["[vo]"]

    if music:
        path = Path(music["file"])
        if path.is_file() and _channels(path):
            inputs += ["-stream_loop", "-1", "-i", str(path)]
            fade_out = _num(max(0.0, final_dur - FADE_OUT))
            chains.append("[vo]asplit=2[vmix][vsc]")
            chains.append(
                f"[{index}:a]{_source(path)},volume={float(music.get('gainDb', -18)):g}dB,atrim=end={end},"
                f"afade=t=in:st=0:d={FADE_IN},afade=t=out:st={fade_out}:d={FADE_OUT}[mu]"
            )
            chains.append(f"[mu][vsc]{DUCK}[md]")
            parts = ["[vmix]", "[md]"]
            index += 1
        else:
            warnings.append(f"музыка не найдена или не читается, ролик без неё: {path}")

    for k, (t, file) in enumerate(sfx):
        path = Path(file)
        if not (path.is_file() and _channels(path)):
            warnings.append(f"звук вставки не найден или не читается, вставка без звука: {path}")
            continue
        inputs += ["-i", str(path)]
        delay = max(0, round(t * 1000))
        chains.append(f"[{index}:a]{_source(path)},volume={SFX_GAIN_DB}dB,adelay=delays={delay}:all=1[s{k}]")
        parts.append(f"[s{k}]")
        index += 1

    if len(parts) == 1:
        chains.append("[vo]anull[aout]")
    else:
        chains.append(f"{''.join(parts)}amix=inputs={len(parts)}:normalize=0:duration=first,atrim=end={end}[aout]")
    return inputs, ";".join(chains), warnings
