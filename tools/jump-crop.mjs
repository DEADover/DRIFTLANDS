// jump-crop.mjs — crop + magnify a PNG so a defect can actually be READ.
// The jump/firework complaints are about things that occupy <150 px at 1920×1080;
// at full-frame scale they are unreadable. No new dependencies: playwright is
// already here for shoot.mjs, so we decode and rescale in a page canvas.
//
//   node tools/jump-crop.mjs in.png out.png X Y W H [SCALE]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [, , inp, out, X, Y, W, H, S] = process.argv;
if (!inp || !out) { console.error('usage: jump-crop.mjs in out x y w h [scale]'); process.exit(1); }
const scale = Number(S || 4);
const b64 = readFileSync(inp).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage();
const png = await page.evaluate(async ({ b64, x, y, w, h, s }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w * s; c.height = h * s;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * s, h * s);
  return c.toDataURL('image/png').split(',')[1];
}, { b64, x: +X, y: +Y, w: +W, h: +H, s: scale });
writeFileSync(out, Buffer.from(png, 'base64'));
await browser.close();
console.log('wrote', out, `${W}x${H} @${scale}x`);
