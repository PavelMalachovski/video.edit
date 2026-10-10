"""Папка задачи jobs/<id>/: JSON-файлы с проверкой по схемам, атомарная запись, статус."""
import json
import os
import uuid
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

SCHEMAS_DIR = Path(__file__).parent / "schemas"
MAX_PROBLEMS = 10  # столько ошибок показываем в сообщении
MAX_LINE = 240  # длинные значения в сообщении обрезаем


@cache
def _schemas() -> dict[str, dict]:
    """Схемы по имени файла данных: status.json -> schemas/status.json."""
    return {p.name: json.loads(p.read_text(encoding="utf-8")) for p in sorted(SCHEMAS_DIR.glob("*.json"))}


@cache
def _validators() -> dict[str, Draft202012Validator]:
    # схемы ссылаются друг на друга ($ref: styles.json#/$defs/StyleSpec) — даём им общий реестр
    registry = Registry().with_resources((s["$id"], Resource.from_contents(s)) for s in _schemas().values())
    return {name: Draft202012Validator(s, registry=registry) for name, s in _schemas().items()}


def states() -> tuple[str, ...]:
    """Допустимые значения status.state (берутся из схемы, чтобы не разъезжались)."""
    return tuple(_schemas()["status.json"]["properties"]["state"]["enum"])


def _field(parts) -> str:
    """['variants', 1, 'id'] -> 'variants[1].id'."""
    out = ""
    for part in parts:
        out += f"[{part}]" if isinstance(part, int) else (f".{part}" if out else str(part))
    return out or "<root>"


def _brief(value: Any) -> str:
    if isinstance(value, list):
        return f"<list of {len(value)}>"
    if isinstance(value, dict):
        return f"<object with {len(value)} keys>"
    return repr(value)[:40] + "…"


def _message(err) -> str:
    if err.validator in ("minItems", "maxItems"):
        bound = "least" if err.validator == "minItems" else "most"
        return f"expected at {bound} {err.validator_value} items, got {len(err.instance)}"
    # jsonschema начинает сообщение с самого значения; длинное (целый вариант стиля) заменяем кратким описанием,
    # иначе причина уехала бы в конец и пропала при обрезке
    message, shown = err.message, repr(err.instance)
    if len(shown) > 60 and message.startswith(shown):
        message = _brief(err.instance) + message[len(shown):]
    return message


def _problems(validator: Draft202012Validator, data: Any) -> list[str]:
    errors = sorted(validator.iter_errors(data), key=lambda e: [str(p) for p in e.absolute_path])
    lines = []
    for err in errors:
        if err.validator == "required":  # путь отсутствующего поля, а не его родителя
            missing = [key for key in err.validator_value if key not in err.instance]
            lines += [f"{_field([*err.absolute_path, key])}: required field is missing" for key in missing]
        else:
            lines.append(f"{_field(err.absolute_path)}: {_message(err)}")
    lines = [line if len(line) <= MAX_LINE else line[:MAX_LINE] + "…" for line in dict.fromkeys(lines)]
    if len(lines) > MAX_PROBLEMS:
        lines = lines[:MAX_PROBLEMS] + [f"… and {len(lines) - MAX_PROBLEMS} more"]
    return lines


def _check(name: str, data: Any) -> None:
    """ValueError с путями полей, если у файла есть схема и данные ей не соответствуют."""
    validator = _validators().get(Path(name).name)
    if validator is None:
        return
    problems = _problems(validator, data)
    if problems:
        raise ValueError(f"{name}: invalid data\n" + "\n".join(f"  {line}" for line in problems))


def validate(name: str, data: Any) -> None:
    """Данные файла `name` по его схеме (edit.json → schemas/edit.json); не так — ValueError с путями полей."""
    _check(name, data)


def _atomic_write(path: Path, text: str) -> None:
    """tmp рядом + rename: читатель видит старый файл или новый целиком, но не половину."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "xb") as f:
            f.write(text.encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


class Job:
    """Папка задачи. id — имя папки; все файлы задачи читаются и пишутся через неё."""

    def __init__(self, root: Path | str):
        self.root = Path(root).resolve()

    @property
    def id(self) -> str:
        return self.root.name

    def path(self, rel: str) -> Path:
        return self.root / rel

    def read(self, name: str) -> Any:
        """JSON-файл задачи; битый JSON — ValueError с именем файла (его мог написать Claude руками)."""
        try:
            return json.loads(self.path(name).read_text(encoding="utf-8"))
        except json.JSONDecodeError as err:
            raise ValueError(f"{name}: не JSON — {err}") from None

    def write(self, name: str, data: Any) -> None:
        """Пишет JSON атомарно. Если у файла есть схема (status.json -> schemas/status.json) —
        сначала проверяет её: невалидные данные -> ValueError, файл не трогается.
        Файлы без схемы (words.json, cuts.json, job.json) пишутся как есть."""
        text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        _check(name, json.loads(text))  # проверяем ровно то, что ляжет в файл (кортежи там — списки)
        _atomic_write(self.path(name), text)


def _now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def set_status(
    job: Job,
    *,
    state: str,
    phase: str,
    message: str,
    needs: str | None = None,
    progress: float | None = None,
    error: str | None = None,
) -> dict:
    """Пишет status.json (страница видит по нему прогресс) и возвращает записанное.
    Пустые needs/progress/error в файл не попадают; `at` — текущее время, ISO UTC."""
    status = {"state": state, "phase": phase, "message": message, "at": _now_iso()}
    optional = {"needs": needs, "progress": progress, "error": error}
    status.update({key: value for key, value in optional.items() if value is not None})
    job.write("status.json", status)
    return status
