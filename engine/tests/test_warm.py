"""Прогрев файлов окружения (`vm.warm`): пока `vm fetch` качает видео, отдельный процесс читает то, что шаг прочтёт позже.
Диск сессии — снимок окружения: файл, которого сессия ещё не читала, приходит по сети при первом чтении (~11 МБ/с у
моделей в ~/.cache/vm) — Whisper и GigaAM читались бы почти 2 минуты прямо во время распознавания."""
import subprocess
import sys

from vm import asr, warm


def environment(tmp_path, monkeypatch):
    """Кэш моделей и браузеры, как их ставит setup/cloud-setup.sh, — маленькими файлами."""
    cache, browsers = tmp_path / "cache", tmp_path / "pw"
    models = {
        asr.WHISPER: ["turbo-encoder.int8.onnx", "turbo-decoder.int8.onnx", "turbo-tokens.txt"],
        asr.GIGAAM: ["encoder.int8.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"],
        asr.PARAKEET: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"],
    }
    for folder, names in models.items():
        (cache / folder).mkdir(parents=True)
        for name in names:
            (cache / folder / name).write_bytes(b"m" * 100)
    (cache / asr.SILERO).write_bytes(b"v" * 10)
    (cache / "rvm_mobilenetv3_fp32.onnx").write_bytes(b"r" * 10)
    shell = browsers / "chromium_headless_shell-1194" / "chrome-linux"
    shell.mkdir(parents=True)
    (shell / "headless_shell.real").write_bytes(b"c" * 1000)
    (shell / "locales").mkdir()
    (shell / "locales" / "ru.pak").write_bytes(b"p")
    monkeypatch.setenv("VM_CACHE", str(cache))
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(browsers))
    for env in ("ASR_MODEL", "ASR_REF_MODEL", "PARAKEET_MODEL", "VAD_MODEL", "MATTE_MODEL"):
        monkeypatch.delenv(env, raising=False)
    return cache, browsers


def where(paths, cache, browsers) -> list[str]:
    """Пути по порядку: папка модели в кэше, `browser` — файлы Chromium; прочее (библиотеки Python, node) — мимо."""
    out = []
    for path in paths:
        if cache in path.parents:
            name = path.relative_to(cache).parts[0]
        elif browsers in path.parents:
            name = "browser"
        else:
            continue
        if not out or out[-1] != name:
            out.append(name)
    return out


def test_the_analysis_warms_whisper_first_then_the_word_model_vad_and_the_browser(tmp_path, monkeypatch):
    """Анализ: Whisper слушает первым, потом модель слов (русская — GigaAM), VAD; Chromium — для `vm preview` в конце;
    Parakeet (не русский ролик) — последним."""
    cache, browsers = environment(tmp_path, monkeypatch)
    assert where(warm.paths(analyze=True), cache, browsers) == [asr.WHISPER, asr.GIGAAM, asr.SILERO, "browser", asr.PARAKEET]


def test_a_render_warms_the_browser_and_the_matte_model_only(tmp_path, monkeypatch):
    cache, browsers = environment(tmp_path, monkeypatch)
    assert where(warm.paths(analyze=False), cache, browsers) == ["browser", "rvm_mobilenetv3_fp32.onnx"]


def test_warm_reads_every_file_and_skips_what_is_missing(tmp_path, monkeypatch):
    _, browsers = environment(tmp_path, monkeypatch)
    paths = warm.paths(analyze=False)
    assert warm.warm([*paths, tmp_path / "нет такого"]) == sum(p.stat().st_size for p in paths)
    assert (browsers / "chromium_headless_shell-1194" / "chrome-linux" / "locales" / "ru.pak") in paths, "файлы папок — все"


def test_start_runs_the_warm_up_on_its_own_and_returns_at_once(monkeypatch):
    """Свой процесс в своей сессии ОС: переживает конец `vm fetch`; VM_WARM=0 (тесты) — не запускается."""
    started = []

    class Popen:
        def __init__(self, cmd, **kw):
            started.append((cmd, kw))

    monkeypatch.setattr(subprocess, "Popen", Popen)
    monkeypatch.setenv("VM_WARM", "1")
    warm.start(analyze=True)
    warm.start(analyze=False)
    assert [cmd for cmd, _ in started] == [[sys.executable, "-m", "vm.warm", "--analyze"], [sys.executable, "-m", "vm.warm"]]
    assert all(kw["start_new_session"] and kw["stdout"] == subprocess.DEVNULL for _, kw in started)
    monkeypatch.setenv("VM_WARM", "0")
    warm.start(analyze=True)
    assert len(started) == 2
