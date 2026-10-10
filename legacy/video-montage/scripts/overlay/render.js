// Рисует кадры вставок: node render.js config.json <длительность_с> <папка_кадров>
// Кадры f0000.png… 1080x1920 с прозрачностью, 30 fps -> finish.py --overlay <папка>.
// Запуск: NODE_PATH=$(npm root -g) node render.js ...   (нужен playwright: npm i -g playwright)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const [cfgPath, durArg, outDir, ...only] = process.argv.slice(2);
if (!cfgPath || !durArg || !outDir) { console.error('usage: node render.js config.json DURATION OUTDIR [t1 t2 ... только эти моменты]'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.font = cfg.font || path.join(os.homedir(), '.fonts', 'Montserrat-ExtraBold.ttf');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 } });
  p.on('console', m => { if (m.type() === 'error') console.error('[overlay]', m.text()); });
  await p.goto('file://' + path.join(__dirname, 'overlay.html'));
  await p.evaluate(c => window.setup(c), cfg);
  fs.mkdirSync(outDir, { recursive: true });
  const times = only.length ? only.map(Number) : [...Array(Math.ceil(Number(durArg) * 30)).keys()].map(i => i / 30);
  for (let i = 0; i < times.length; i++) {
    const url = await p.evaluate(t => { draw(t); return document.getElementById('c').toDataURL('image/png'); }, times[i]);
    fs.writeFileSync(path.join(outDir, `f${String(i).padStart(4, '0')}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  await b.close();
  console.log(`${times.length} кадров -> ${outDir}`);
})();
