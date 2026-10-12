"""Находки CodeQL из SARIF (без загрузки в GitHub: для неё в настройках репозитория надо включать code scanning):
печатает каждую — уровень, правило, файл:строка, текст — и выходит с 1, если есть ошибки или предупреждения."""
import json
import pathlib
import sys

found = 0
for path in sorted(pathlib.Path(sys.argv[1]).glob("*.sarif")):
    for run in json.loads(path.read_text(encoding="utf-8")).get("runs", []):
        rules = {r.get("id"): r for r in run.get("tool", {}).get("driver", {}).get("rules", [])}
        for result in run.get("results", []):
            rule = result.get("ruleId", "?")
            level = result.get("level") or rules.get(rule, {}).get("defaultConfiguration", {}).get("level", "warning")
            where = result.get("locations", [{}])[0].get("physicalLocation", {})
            file = where.get("artifactLocation", {}).get("uri", "?")
            line = where.get("region", {}).get("startLine", "?")
            print(f"{level}: {rule} {file}:{line} — {result.get('message', {}).get('text', '')}")
            found += level in ("error", "warning")
print(f"находок (ошибки и предупреждения): {found}")
sys.exit(1 if found else 0)
