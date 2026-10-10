// Вставки слоя: картинки (прямоугольные и PNG без фона), бейдж, стикер и анимация (танцующая пара).
// Бейдж, стикер и пара перенесены из legacy/video-montage/scripts/overlay/overlay.html (DRAW.badge,
// sticker, bachata) — без наклонов, покачивания и «пружины»: по правилам вставки не поворачиваются,
// а появляются резко (85 мс в кадрах, здесь — по `anim` 0..1).
//
//   InsertState = {kind: "image"|"badge"|"sticker"|"anim", src?, text?, title?, x, y, w,
//                  anim /* 0..1 — прогресс появления */, t /* с от начала показа, для anim */, params?}
//   x, y — левый верхний угол вставки в кадре, w — её ширина; высоту задаёт содержимое.
//   src — адрес картинки (относительно overlay.html или полный).

/** Плавное замедление появления: быстро в начале, мягко в конце. */
export function ease(x) {
  const v = Math.min(1, Math.max(0, Number(x) || 0));
  return 1 - (1 - v) ** 3;
}

const FRAME_COLOR = '#111111';
const PHOTO_EXT = { x: 10, top: 8, bottom: 12 }; // тень 0 2px 10px вокруг прямоугольной картинки
const CUTOUT_EXT = { x: 1, top: 1, bottom: 1 }; // контур 1 px по силуэту
const CARD_SHADOW = { blur: 24, dy: 8, color: 'rgba(0, 0, 0, 0.3)' };
const CARD_EXT = { x: CARD_SHADOW.blur, top: CARD_SHADOW.blur - CARD_SHADOW.dy, bottom: CARD_SHADOW.blur + CARD_SHADOW.dy };
const MARGIN = 48; // поле холста вокруг карточки — под тень

// ---------- картинки ----------

const images = new Map();

/** Загруженная картинка по адресу; не загрузилась — ошибка с адресом (пропускать вставку нельзя). */
function picture(src) {
  if (!images.has(src)) {
    const loading = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`картинка вставки не загрузилась: ${src}`));
      img.src = src;
    });
    loading.catch(() => images.delete(src));
    images.set(src, loading);
  }
  return images.get(src);
}

async function photo(ins) {
  if (!ins.src) throw new Error('у вставки-картинки нет src');
  const loaded = await picture(ins.src);
  const w = ins.w;
  const h = Math.round((w * loaded.naturalHeight) / loaded.naturalWidth);
  const img = document.createElement('img');
  img.src = loaded.src;
  img.alt = '';
  img.draggable = false;
  Object.assign(img.style, { display: 'block', width: `${w}px`, height: `${h}px`, boxSizing: 'border-box' });
  const cutout = Boolean(ins.params?.cutout);
  if (cutout) {
    const line = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => `drop-shadow(${dx}px ${dy}px 0 ${FRAME_COLOR})`).join(' ');
    img.style.filter = line;
  } else {
    Object.assign(img.style, { border: `1px solid ${FRAME_COLOR}`, borderRadius: '10px', boxShadow: '0 2px 10px rgba(0, 0, 0, 0.08)' });
  }
  await img.decode();
  return { node: img, w, h, ext: cutout ? CUTOUT_EXT : PHOTO_EXT, offset: 0 };
}

// ---------- карточки на холсте ----------

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

function fontOf(main, size) {
  return `${main.weight} ${size}px "${main.family}"`;
}

function wrap(ctx, text, maxW) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** Холст под карточку `w×h` с полями под тень; рисовать — от (0, 0) карточки. */
function canvasFor(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w + 2 * MARGIN);
  canvas.height = Math.ceil(h + 2 * MARGIN);
  Object.assign(canvas.style, { display: 'block', position: 'absolute', left: `${-MARGIN}px`, top: `${-MARGIN}px` });
  const ctx = canvas.getContext('2d');
  ctx.translate(MARGIN, MARGIN);
  return { canvas, ctx };
}

/** Карточка-стикер: градиент, белая рамка, тень, блик; `inner` рисует содержимое внутри. */
function card(ctx, w, h, { colors, title, titleSize, main }, inner) {
  const [c1, c2] = colors ?? ['#FF3D71', '#FF9F43'];
  ctx.save();
  ctx.shadowColor = CARD_SHADOW.color;
  ctx.shadowBlur = CARD_SHADOW.blur;
  ctx.shadowOffsetY = CARD_SHADOW.dy;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, c1);
  g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 42);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#FFFFFF';
  ctx.stroke();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - 8, 38);
  ctx.clip();
  const shine = ctx.createRadialGradient(w / 2, h * 0.62, 10, w / 2, h * 0.62, w * 0.62);
  shine.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
  shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, w, h);
  inner?.();
  ctx.restore();
  if (title) {
    ctx.font = fontOf(main, titleSize ?? 58);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.strokeText(title, w / 2, 82);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(title, w / 2, 82);
  }
  ctx.restore();
}

function sticker(ins, main) {
  const w = ins.w;
  const size = ins.params?.textSize ?? 44;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = fontOf(main, size);
  const lines = wrap(probe, ins.text ?? '', w - 60);
  const lh = size * 1.2;
  const top = ins.title ? 110 : 30;
  const h = Math.round(top + lines.length * lh + 30);
  const { canvas, ctx } = canvasFor(w, h);
  card(ctx, w, h, { colors: ins.params?.colors, title: ins.title, titleSize: ins.params?.titleSize, main }, () => {
    ctx.font = fontOf(main, size);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, top + i * lh));
  });
  return { node: canvas, w, h, ext: CARD_EXT, offset: MARGIN };
}

async function badge(ins, main) {
  const icon = ins.src ? await picture(ins.src) : null;
  const height = ins.params?.height ?? 132;
  const tile = height - 32;
  const pad = 16;
  const gap = 22;
  const start = icon ? pad + tile + gap : 40;
  const probe = document.createElement('canvas').getContext('2d');
  // текст — крупно, но так, чтобы плашка уложилась в ширину вставки
  let size = Math.round(height * 0.53);
  probe.font = fontOf(main, size);
  while (size > 12 && start + probe.measureText(ins.text ?? '').width + 38 > ins.w) {
    size -= 1;
    probe.font = fontOf(main, size);
  }
  const w = Math.min(ins.w, Math.ceil(start + probe.measureText(ins.text ?? '').width + 38));
  const h = height;
  const cols = ins.params?.colors ?? ['#7C4DFF', '#4F46E5', '#3B5BDB'];
  const { canvas, ctx } = canvasFor(w, h);
  ctx.save();
  ctx.shadowColor = CARD_SHADOW.color;
  ctx.shadowBlur = CARD_SHADOW.blur;
  ctx.shadowOffsetY = CARD_SHADOW.dy;
  const g = ctx.createLinearGradient(0, 0, w, h);
  cols.forEach((col, i) => g.addColorStop(i / Math.max(1, cols.length - 1), col));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, h / 2);
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.stroke();
  if (icon) {
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.roundRect(pad, (h - tile) / 2, tile, tile, tile * 0.28);
    ctx.fill();
    const m = tile * 0.14;
    const k = Math.min((tile - 2 * m) / icon.naturalWidth, (tile - 2 * m) / icon.naturalHeight);
    const iw = icon.naturalWidth * k;
    const ih = icon.naturalHeight * k;
    ctx.drawImage(icon, pad + (tile - iw) / 2, (h - ih) / 2, iw, ih);
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.font = fontOf(main, size);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(ins.text ?? '', start, h / 2 + 3);
  ctx.restore();
  return { node: canvas, w, h, ext: CARD_EXT, offset: MARGIN };
}

// ---------- танцующая пара (базовый шаг бачаты) ----------

const BEAT = 60 / 128;
const FA = [-1, -1, -2, -2, -2, -1, -1, 0];
const FB = [0, -1, -1, -2, -1, -1, 0, 0];
const SKIN = '#F1BE94';
const SKIN2 = '#E3A97E';

function foot(cnt, steps) {
  const n = ((Math.floor(cnt) % 8) + 8) % 8;
  const f = cnt - Math.floor(cnt);
  const prev = steps[(n + 7) % 8];
  const cur = steps[n];
  const k = clamp(f / 0.7, 0, 1);
  return [prev + (cur - prev) * easeInOut(k), cur !== prev ? Math.sin(Math.PI * k) : 0];
}

/** Колено ноги длиной L от бедра к ступне, сгиб — в сторону dir (два звена). */
function knee(hx, hy, fx, fy, L, dir) {
  const dx = fx - hx;
  const dy = fy - hy;
  const d = Math.hypot(dx, dy) || 1;
  const h = d < 2 * L ? Math.sqrt(L * L - (d / 2) ** 2) : 0;
  const mx = (hx + fx) / 2;
  const my = (hy + fy) / 2;
  return [mx + dir * (-dy / d) * h * -1, my + dir * (dx / d) * h * -1];
}

function line(ctx, pts, w, col) {
  ctx.lineWidth = w;
  ctx.strokeStyle = col;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function disc(ctx, x, y, r, col) {
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 7);
  ctx.fill();
}

function arm(ctx, from, ctrl, to, col, w) {
  ctx.strokeStyle = col;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.quadraticCurveTo(ctrl[0], ctrl[1], to[0], to[1]);
  ctx.stroke();
}

function person(ctx, cx, gy, o) {
  const { s, facing: dir } = o;
  const hip = [cx + o.hipDX, gy - 148 * s + o.dy];
  const neck = [cx + o.hipDX * 0.25 + dir * 5 * s, hip[1] - 108 * s];
  const head = [neck[0] + dir * 5 * s, neck[1] - 30 * s];
  const fa = [cx + o.fa - 13 * s, gy - o.la];
  const fb = [cx + o.fb + 13 * s, gy - o.lb];
  const L = 78 * s;
  const ka = knee(hip[0] - 7 * s, hip[1], fa[0], fa[1], L, dir);
  const kb = knee(hip[0] + 7 * s, hip[1], fb[0], fb[1], L, dir);
  const legCol = o.woman ? SKIN : '#2C2C40';
  const legW = o.woman ? 11 * s : 19 * s;
  for (const [k, f, hx] of [[ka, fa, -7], [kb, fb, 7]]) {
    line(ctx, [[hip[0] + hx * s, hip[1]], k, f], legW, legCol);
    ctx.fillStyle = o.woman ? '#B0102E' : '#111111';
    ctx.beginPath();
    ctx.ellipse(f[0] + dir * 7 * s, f[1] + 2, 13 * s, 6 * s, 0, 0, 7);
    ctx.fill();
  }
  if (o.woman) {
    // юбка, качается с запаздыванием
    const sw = o.swing;
    const wy = hip[1] - 14 * s;
    const hy = hip[1] + 62 * s;
    ctx.fillStyle = '#E11D48';
    ctx.beginPath();
    ctx.moveTo(hip[0] - 17 * s, wy);
    ctx.quadraticCurveTo(hip[0] - 30 * s + sw * 0.4, hip[1] + 20 * s, hip[0] - 46 * s + sw, hy);
    for (let i = 1; i <= 4; i++) {
      const x = hip[0] - 46 * s + sw + i * 23 * s;
      const y = hy + (i % 2 ? 9 : -2) * s;
      ctx.quadraticCurveTo(x - 11 * s, y + 8 * s, x, hy);
    }
    ctx.quadraticCurveTo(hip[0] + 30 * s + sw * 0.4, hip[1] + 20 * s, hip[0] + 17 * s, wy);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.beginPath();
    ctx.moveTo(hip[0] - 4 * s, wy + 6 * s);
    ctx.quadraticCurveTo(hip[0] - 10 * s + sw * 0.5, hip[1] + 30 * s, hip[0] - 20 * s + sw, hy - 2 * s);
    ctx.lineTo(hip[0] - 8 * s + sw, hy);
    ctx.closePath();
    ctx.fill();
    line(ctx, [hip, neck], 30 * s, '#E11D48');
  } else {
    line(ctx, [hip, neck], 44 * s, '#17172A');
  }
  line(ctx, [neck, [neck[0] + dir * 2, neck[1] - 14 * s]], 12 * s, SKIN2);
  disc(ctx, head[0], head[1], (o.woman ? 17 : 19) * s, SKIN);
  ctx.fillStyle = o.woman ? '#3B2416' : '#1E1A18';
  ctx.beginPath();
  ctx.arc(head[0] - dir * 2 * s, head[1] - 2 * s, (o.woman ? 18 : 20) * s, Math.PI * 1.02, Math.PI * 1.98);
  ctx.fill();
  if (o.woman) {
    // пучок и хвост
    const bx = head[0] - dir * 17 * s;
    const by = head[1] - 6 * s;
    disc(ctx, bx, by, 9 * s, '#3B2416');
    ctx.strokeStyle = '#3B2416';
    ctx.lineWidth = 9 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo(bx - dir * 14 * s, by + 18 * s, bx - dir * 10 * s + o.swing * 0.5, by + 40 * s);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.ellipse(head[0] - dir * 8 * s, head[1] - 4 * s, 14 * s, 12 * s, 0, 0, 7);
    ctx.fill();
  }
  return { neck, head };
}

function couple(ctx, t, cx, gy, s) {
  const cnt = t / BEAT;
  const f = cnt - Math.floor(cnt);
  const n = ((Math.floor(cnt) % 8) + 8) % 8;
  const U = 13 * s;
  const [a, la] = foot(cnt, FA);
  const [b, lb] = foot(cnt, FB);
  const [a2] = foot(cnt - 0.25, FA);
  const [b2] = foot(cnt - 0.25, FB);
  const body = ((a + b) / 2) * U;
  const lag = ((a2 + b2) / 2) * U;
  const tap = n === 3 || n === 7 ? Math.sin(Math.PI * f) : 0;
  const dy = 4 * s * Math.sin(Math.PI * f) ** 2 - 6 * s * tap;
  const hipDX = 7 * s * Math.sin(Math.PI * cnt);
  const swing = (lag - body) * 1.4 + 4 * s * Math.sin(Math.PI * cnt + 1);
  const base = { s, dy, hipDX, fa: a * U, fb: b * U, la: la * 11 * s, lb: lb * 11 * s };
  ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
  ctx.beginPath();
  ctx.ellipse(cx + body, gy + 6, 105 * s, 13 * s, 0, 0, 7);
  ctx.fill();
  const m = person(ctx, cx - 31 * s + body, gy, { ...base, facing: 1, woman: false });
  const w = person(ctx, cx + 31 * s + body, gy, { ...base, facing: -1, woman: true, s: s * 0.94, swing });
  const top = [cx + body + hipDX * 0.3, Math.min(m.head[1], w.head[1]) - 46 * s]; // сцепленные руки
  arm(ctx, [m.neck[0] + 4 * s, m.neck[1] + 6 * s], [m.neck[0] - 4 * s, top[1] + 20 * s], top, '#17172A', 11 * s);
  arm(ctx, [w.neck[0] - 3 * s, w.neck[1] + 6 * s], [w.neck[0] + 8 * s, top[1] + 22 * s], top, SKIN, 9 * s);
  disc(ctx, top[0], top[1], 7 * s, SKIN);
  arm(ctx, [m.neck[0] + 6 * s, m.neck[1] + 14 * s], [w.neck[0] - 6 * s, m.neck[1] + 60 * s], [w.neck[0] + 14 * s, w.neck[1] + 48 * s], '#17172A', 11 * s);
  disc(ctx, w.neck[0] + 14 * s, w.neck[1] + 48 * s, 6 * s, SKIN);
  arm(ctx, [w.neck[0] - 6 * s, w.neck[1] + 10 * s], [m.neck[0] + 14 * s, w.neck[1] - 6 * s], [m.neck[0] - 8 * s, m.neck[1] + 6 * s], SKIN, 9 * s);
}

/** Ноты над парой — нарисованы линиями, чтобы не зависеть от шрифтов с ♪. */
function notes(ctx, t, x, y, w, h) {
  for (let i = 0; i < 4; i++) {
    const p = (t * 0.45 + i * 0.25) % 1;
    const nx = x + w * (0.12 + 0.76 * ((i * 0.37) % 1)) + 10 * Math.sin(t * 2 + i);
    const ny = y + h * (0.62 - 0.42 * p);
    const alpha = (Math.sin(Math.PI * p) * 0.85).toFixed(3);
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(nx, ny, 9, 7, -0.4, 0, 7);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(nx + 8, ny - 2);
    ctx.lineTo(nx + 8, ny - 34);
    ctx.lineTo(nx + 20, ny - 26);
    ctx.stroke();
  }
}

const ANIMS = {
  bachata(ins, main) {
    const w = ins.w;
    const h = Math.round((w * 500) / 384);
    const { canvas, ctx } = canvasFor(w, h);
    const t = Math.max(0, Number(ins.t) || 0);
    card(ctx, w, h, { colors: ins.params?.colors, title: ins.title, titleSize: ins.params?.titleSize, main }, () => {
      notes(ctx, t, 0, 90, w, h - 90);
      // с заголовком пара мельче, чтобы поднятые руки не заходили на него
      couple(ctx, t, w / 2, h - 34, (ins.params?.scale ?? (ins.title ? 0.95 : 1.1)) * (w / 384));
    });
    return { node: canvas, w, h, ext: CARD_EXT, offset: MARGIN };
  },
};

// ---------- вход ----------

async function content(ins, main) {
  switch (ins.kind) {
    case 'image':
      return photo(ins);
    case 'badge':
      return badge(ins, main);
    case 'sticker':
      return sticker(ins, main);
    case 'anim': {
      const name = ins.params?.name ?? 'bachata';
      const draw = ANIMS[name];
      if (!draw) throw new Error(`неизвестная анимация вставки: ${name}`);
      return draw(ins, main);
    }
    default:
      throw new Error(`вставку вида «${ins.kind}» шаблон не рисует${ins.kind === 'fullscreen' ? ' (fullscreen монтирует ffmpeg)' : ''}`);
  }
}

/**
 * Рисует вставки в слой `root` поверх кадра (под субтитрами и хуком).
 * → рамки вставок {x, y, w, h} в px кадра — как у показанной целиком вставки, вместе с тенью и контуром.
 */
export async function drawInserts(root, inserts, { main }) {
  const made = await Promise.all((inserts ?? []).map((ins) => content(ins, main)));
  root.replaceChildren();
  return made.map((m, i) => {
    const ins = inserts[i];
    const k = ease(ins.anim ?? 1);
    const wrap = document.createElement('div');
    wrap.className = 'ins';
    wrap.dataset.i = String(i);
    Object.assign(wrap.style, {
      position: 'absolute',
      left: `${ins.x}px`,
      top: `${ins.y}px`,
      width: `${m.w}px`,
      height: `${m.h}px`,
      opacity: String(k),
      transform: `scale(${0.965 + 0.035 * k})`,
      transformOrigin: '50% 50%',
    });
    wrap.append(m.node);
    root.append(wrap);
    const x = Math.floor(ins.x - m.ext.x);
    const y = Math.floor(ins.y - m.ext.top);
    return { x, y, w: Math.ceil(ins.x + m.w + m.ext.x) - x, h: Math.ceil(ins.y + m.h + m.ext.bottom) - y };
  });
}
