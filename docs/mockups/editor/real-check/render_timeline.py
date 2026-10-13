"""Таймлайн со страницы проверки → edit.json тестовой задачи → vm render → копия для просмотра.

python3 render_timeline.py <timeline.json> <тестовая задача> <задача рутины> <work> <выход web.mp4>
Очистка голоса (фаза 6 ещё не в движке) — как в дизайне: голос = исходный·10^(−A/20) + чистый·(1 − 10^(−A/20)),
дорожка source.mp4 заменяется смешанным голосом, видео копируется без перекодирования.
"""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

tl_path, job, src_job, work, web_out = (Path(a).resolve() for a in sys.argv[1:6])
tl = json.loads(tl_path.read_text())
L = 30.0
routine = json.loads((src_job / "edit.json").read_text())


def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


# слова: исправленный текст Claude из монтажа рутины; правки субтитров со страницы — по словам группы
words = [dict(w) for w in routine["words"] if w["t1"] <= L]
for e in tl.get("words", []):
    idx = [i for i in e["idx"] if 0 <= i < len(words)]
    toks = e["text"].split()
    if not idx or not toks:
        continue
    # токены раздаём словам группы по порядку; лишние — последнему слову, недостающим — пусто нельзя: склеиваем
    per = [[] for _ in idx]
    for k, tok in enumerate(toks):
        per[min(k * len(idx) // len(toks), len(idx) - 1)].append(tok)
    for i, part in zip(idx, per):
        words[i]["text"] = " ".join(part) if part else "…"

keep = [[float(a), float(b)] for a, b in tl["keep"]]
assert all(b > a for a, b in keep) and all(keep[i][1] <= keep[i + 1][0] + 1e-6 for i in range(len(keep) - 1)), "куски не по порядку"
style = json.loads(json.dumps(routine["style"]))
style["colors"].update({"text": tl["colors"]["text"], "accent": tl["colors"]["accent"], "bar": tl["colors"]["bar"]})
edit = {
    "speed": tl["speed"],
    "keep": keep,
    "words": words,
    "hook": tl["hook"],
    "cta": None,
    "inserts": [],
    "accents": [{"t0": a["t0"], "t1": max(a["t1"], a["t0"] + 0.3), "lines": [{"text": l["text"], **({"color": "accent"} if l.get("color") == "accent" else {})} for l in a["lines"]],
                 "x": 540, "y": a["y"], **({"anim": a["anim"]} if a.get("anim") else {})} for a in tl["accents"]],
    "looks": [k for k in routine.get("looks", []) if k["t0"] < L],
    "zooms": [z for z in routine["zooms"] if z["t"] < L],
    "transitions": [],
    "face": routine["face"],
    "music": None if tl["music"]["muted"] else {"file": routine["music"]["file"], "gainDb": tl["music"]["gainDb"]},
    "hold": 0,
    "style": style,
}
for k in ("words",):
    assert edit[k], k

# голос: исходник source.mp4 хранится рядом; при очистке — смешанный голос вместо исходного
orig = job / "source-orig.mp4"
src = job / "source.mp4"
if not orig.exists():
    shutil.copy(src, orig)
if tl["voice"]["clean"]:
    lim = 10 ** (-tl["voice"]["strengthDb"] / 20)
    ff("-i", str(work / "voice.wav"), "-i", str(work / "clean.wav"), "-filter_complex",
       f"[0:a]volume={lim:.6f}[a];[1:a]volume={1 - lim:.6f}[b];[a][b]amix=inputs=2:normalize=0,aformat=channel_layouts=stereo[v]",
       "-map", "[v]", "-c:a", "pcm_s16le", str(work / "mixed.wav"))
    ff("-i", str(orig), "-i", str(work / "mixed.wav"), "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
       "-shortest", str(src))
else:
    shutil.copy(orig, src)

(job / "edit.json").write_text(json.dumps(edit, ensure_ascii=False, indent=1))
repo = Path("/home/user/video.edit")
env = {"PYTHONPATH": str(repo / "engine"), "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/node22/bin", "HOME": "/root",
       "PLAYWRIGHT_BROWSERS_PATH": "/opt/pw-browsers", "VM_REPO_ROOT": str(repo)}
t = time.time()
for cmd in (["validate"], ["render"]):
    r = subprocess.run(["python3", "-m", "vm", *cmd, str(job)], cwd=repo, env={**__import__("os").environ, **env}, capture_output=True, text=True)
    print("$ vm", *cmd, "→", r.returncode)
    print((r.stdout + r.stderr)[-3000:])
    if r.returncode:
        sys.exit(1)
final = job / "out" / "final.mp4"
ff("-i", str(final), "-c:v", "libx264", "-crf", "25", "-preset", "medium", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(web_out))
print(f"render {time.time() - t:.0f} s; final {final.stat().st_size / 1e6:.1f} MB; web {web_out.stat().st_size / 1e6:.1f} MB")
