"""Находки CodeQL из SARIF (без загрузки в GitHub: для неё в настройках репозитория надо включать code scanning):
печатает каждую — уровень, правило, файл:строка, текст, путь данных от источника к месту — и выходит с 1, если есть
ошибки или предупреждения. Проверенные ложные срабатывания — в .github/codeql/accepted.json: правило, файл, кусок кода
на найденной строке и почему это не уязвимость; такая находка печатается как принятая и не роняет задание."""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
ACCEPTED = json.loads((ROOT / ".github/codeql/accepted.json").read_text(encoding="utf-8"))


def place(loc):
    where = loc.get("physicalLocation", {})
    return where.get("artifactLocation", {}).get("uri", "?"), where.get("region", {}).get("startLine", 0)


def source_line(file, line):
    try:
        return (ROOT / file).read_text(encoding="utf-8").splitlines()[line - 1]
    except (OSError, IndexError, UnicodeDecodeError):
        return ""


def accepted(rule, file, line):
    code = source_line(file, line)
    return next((a for a in ACCEPTED if a["rule"] == rule and a["file"] == file and a["code"] in code), None)


def flow(result):
    """Путь данных первой цепочки: источник → … → место находки (до 6 шагов)."""
    for code_flow in result.get("codeFlows", [])[:1]:
        for thread in code_flow.get("threadFlows", [])[:1]:
            steps = [place(s.get("location", {})) for s in thread.get("locations", [])]
            if len(steps) > 6:
                steps = [*steps[:3], ("…", 0), *steps[-2:]]
            return " → ".join(f"{f}:{n}" if n else f for f, n in steps)
    return ""


def message(result):
    """Текст находки со ссылками [что](n) → «что (файл:строка)»."""
    related = {r.get("id"): place(r) for r in result.get("relatedLocations", [])}

    def link(m):
        f, n = related.get(int(m[2]), ("?", 0))
        return f"{m[1]} ({f}:{n})"

    return re.sub(r"\[([^\]]+)\]\((\d+)\)", link, result.get("message", {}).get("text", ""))


found = 0
for path in sorted(pathlib.Path(sys.argv[1]).glob("*.sarif")):
    for run in json.loads(path.read_text(encoding="utf-8")).get("runs", []):
        rules = {r.get("id"): r for r in run.get("tool", {}).get("driver", {}).get("rules", [])}
        for result in run.get("results", []):
            rule = result.get("ruleId", "?")
            level = result.get("level") or rules.get(rule, {}).get("defaultConfiguration", {}).get("level", "warning")
            file, line = place(result.get("locations", [{}])[0])
            ok = accepted(rule, file, line)
            print(f"{'принято' if ok else level}: {rule} {file}:{line} — {message(result)}")
            if ok:
                print(f"    почему: {ok['why']}")
            elif trail := flow(result):
                print(f"    путь: {trail}")
            found += not ok and level in ("error", "warning")
print(f"находок (ошибки и предупреждения, кроме принятых): {found}")
sys.exit(1 if found else 0)
