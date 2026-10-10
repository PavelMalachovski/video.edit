#!/usr/bin/env python3
"""Финальная сборка ролика 9:16:
  * вертикальный кадр 1080x1920 (не вертикальный исходник — по центру на размытом фоне);
  * СУБТИТРЫ (всегда): по 2–3 слова, произносимое слово подсвечивается;
  * ШКАЛА ВРЕМЕНИ (всегда): полоса, которая заполняется до конца ролика;
  * по желанию: заголовок, анимированные вставки (PNG-кадры из overlay/render.js),
    стоп-кадр в конце, плавное затухание; звук выравнивается по громкости.

    python3 finish.py edited.mp4 --subs subs.json -o final.mp4 [--title ...] [--overlay frames/] [--hold 1]

subs.json — [{start, end, text}] во времени входного видео (transcribe.py).
"""
import argparse, json, os, re, subprocess, sys, tempfile

ap = argparse.ArgumentParser()
ap.add_argument('video')
ap.add_argument('--subs', required=True, help='subs.json (transcribe.py), текст уже исправлен')
ap.add_argument('-o', '--out', default='final.mp4')
ap.add_argument('--title', help='заголовок в плашке вверху')
ap.add_argument('--title2', help='вторая строка под заголовком')
ap.add_argument('--title-until', type=float, help='убрать заголовок на этой секунде (по умолчанию — весь ролик)')
ap.add_argument('--overlay', help='папка с кадрами вставок f0000.png… (30 fps, 1080x1920, с прозрачностью)')
ap.add_argument('--hold', type=float, default=0.0, help='стоп-кадр в конце, с')
ap.add_argument('--words', type=int, default=3, help='слов в субтитре одновременно')
ap.add_argument('--sub-size', type=int, default=84)
ap.add_argument('--sub-margin', type=int, help='отступ субтитров от низа кадра, px (по умолчанию — авто)')
ap.add_argument('--sub-color', default='FFD700', help='цвет подсветки слова, RRGGBB')
ap.add_argument('--bar-color', default='FFD700', help='цвет шкалы времени, RRGGBB')
ap.add_argument('--bar-pos', choices=['bottom', 'top'], default='bottom')
ap.add_argument('--bar-height', type=int, default=14)
ap.add_argument('--fg-y', type=int, help='верх кадра при размытом фоне, px (по умолчанию — по центру)')
ap.add_argument('--denoise', action='store_true', help='подавить фоновый шум (тихая запись с телефона)')
ap.add_argument('--no-fade', action='store_true')
args = ap.parse_args()

W, H, FPS = 1080, 1920, 30
S = tempfile.mkdtemp(prefix='finish_')


def probe():
    j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                                   'stream=width,height:stream_side_data=rotation:format=duration', '-of', 'json',
                                   args.video], capture_output=True, text=True).stdout)
    st = j['streams'][0]
    w, h = st['width'], st['height']
    rot = next((abs(int(d.get('rotation', 0))) for d in st.get('side_data_list', []) if 'rotation' in d), 0)
    if rot in (90, 270):
        w, h = h, w
    return w, h, float(j['format']['duration'])


w, h, SRC_DUR = probe()
DUR = SRC_DUR + args.hold
T_END = min(DUR, args.title_until) if args.title_until else DUR
T_FAD = 400 if args.title_until else 0
vertical = abs(w / h - W / H) < 0.03
if vertical:
    fg_h, fg_y = H, 0
    layout = f'[0:v]scale={W}:{H},setsar=1[base0];'
else:
    fg_h = int(round(W * h / w / 2)) * 2
    fg_y = args.fg_y if args.fg_y is not None else (H - fg_h) // 2
    layout = (f'[0:v]scale={W}:{fg_h},setsar=1,split[fg][fgb];'
              f'[fgb]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},'
              f'gblur=sigma=45,eq=brightness=-0.12:saturation=1.2[bgb];'
              f'[bgb][fg]overlay=0:{fg_y}[base0];')
sub_margin = args.sub_margin
if sub_margin is None:
    sub_margin = 430 if vertical else max(230, H - (fg_y + fg_h) - 170)
if args.bar_pos == 'bottom':
    sub_margin = max(sub_margin, args.bar_height + 60)


def ts(t):
    cs = int(round(max(0, t) * 100))
    return f'{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}'


def bgr(rgb):
    return f'&H00{rgb[4:6]}{rgb[2:4]}{rgb[0:2]}'.upper()


subs = [s for s in json.load(open(args.subs, encoding='utf-8')) if s['text'].strip()]
subs.sort(key=lambda s: s['start'])
events = []
for k, s in enumerate(subs):
    a, b = float(s['start']), float(s['end'])
    nxt = float(subs[k + 1]['start']) if k + 1 < len(subs) else SRC_DUR
    shown = max(b, min(nxt, b + 0.5))                      # не мигать между фразами
    words = s['text'].split()
    n = max(1, -(-len(words) // args.words))
    chunks = [words[i * len(words) // n:(i + 1) * len(words) // n] for i in range(n)]
    total = sum(len(x) + 1 for x in words)
    cur = a
    for ci, ch in enumerate(chunks):
        wd = [(b - a) * (len(x) + 1) / total for x in ch]
        end = cur + sum(wd)
        kara = ' '.join(f'{{\\kf{max(1, round(d * 100))}}}{x}' for x, d in zip(ch, wd))
        events.append((cur, shown if ci == len(chunks) - 1 else end, kara))
        cur = end

hl = bgr(args.sub_color)
ass = [f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Montserrat ExtraBold,{args.sub_size},{hl},&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,2,60,60,{sub_margin},1
Style: Title,Montserrat ExtraBold,66,&H00111111,&H00111111,{hl},{hl},-1,0,0,0,100,100,0,0,3,18,0,8,60,60,150,1
Style: Title2,Montserrat Bold,50,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,2,8,60,60,262,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"""]
if args.title:
    ass.append(f'Dialogue: 1,{ts(0)},{ts(T_END)},Title,,0,0,0,,{{\\fad(250,{T_FAD})}}{args.title}')
if args.title2:
    ass.append(f'Dialogue: 1,{ts(0.3)},{ts(T_END)},Title2,,0,0,0,,{{\\fad(300,{T_FAD})}}{args.title2}')
for a, b, kara in events:
    ass.append(f'Dialogue: 0,{ts(a)},{ts(b)},Sub,,0,0,0,,{{\\fscx85\\fscy85\\t(0,80,\\fscx100\\fscy100)}}{kara}')
ass_path = os.path.join(S, 'subs.ass')
open(ass_path, 'w', encoding='utf-8').write('\n'.join(ass) + '\n')

with open(os.path.splitext(args.out)[0] + '.srt', 'w', encoding='utf-8') as f:
    def srt(t):
        ms = int(round(t * 1000))
        return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'
    for i, (a, b, kara) in enumerate(events, 1):
        f.write(f"{i}\n{srt(a)} --> {srt(b)}\n{re.sub(r'{[^}]*}', '', kara)}\n\n")

bh = args.bar_height
by = H - bh if args.bar_pos == 'bottom' else 0
inputs = ['-i', args.video]
g = layout + f'[base0]fps={FPS}' + (f',tpad=stop_mode=clone:stop_duration={args.hold}' if args.hold > 0 else '') + '[base];'
last = 'base'
if args.overlay:
    inputs += ['-framerate', str(FPS), '-i', os.path.join(args.overlay, 'f%04d.png')]
    g += f'[1:v]format=rgba[ov];[{last}][ov]overlay=0:0:eof_action=pass[withov];'
    last = 'withov'
esc = ass_path.replace('\\', '/').replace(':', '\\:').replace("'", "\\'")
g += (f"[{last}]ass='{esc}',"
      f'drawbox=x=0:y={by}:w=iw:h={bh}:color=black@0.35:t=fill[subbed];'       # дорожка: сколько осталось
      f'color=c=0x{args.bar_color}:s={W}x{bh}:r={FPS}[bar];'
      f"[subbed][bar]overlay=x='-W+W*t/{DUR:.3f}':y={by}:shortest=1")       # заполнение: сколько прошло
if not args.no_fade:
    g += f',fade=t=in:d=0.2,fade=t=out:st={max(0, DUR - 0.45):.3f}:d=0.45'
g += ',format=yuv420p[v];'
g += '[0:a]highpass=f=80,' + ('afftdn=nf=-30,' if args.denoise else '') + 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000'
if args.hold > 0:
    g += f',apad=pad_dur={args.hold}'
if not args.no_fade:
    g += f',afade=t=in:d=0.1,afade=t=out:st={max(0, DUR - 0.45):.3f}:d=0.45'
g += '[a]'
fg_file = os.path.join(S, 'graph.txt')
open(fg_file, 'w').write(g)
subprocess.run(['ffmpeg', '-v', 'error', '-y'] + inputs + ['-filter_complex_script', fg_file, '-map', '[v]', '-map', '[a]',
                '-t', f'{DUR:.3f}', '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart', args.out], check=True)
print(f'-> {args.out} ({DUR:.1f} c, {"вертикальный исходник" if vertical else "размытый фон"}, '
      f'{len(events)} субтитров) + {os.path.splitext(args.out)[0]}.srt')
