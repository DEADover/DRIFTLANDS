#!/usr/bin/env node
/**
 * HOW BIG IS THE FIREWORK, IN PIXELS?
 * -----------------------------------
 * "The fireworks are not expressive" is a claim about the PICTURE, so it has to
 * be answered in the picture's own units. This finds every pixel that is hot
 * (bright, and much redder than it is blue — the burst's gold and ember, which
 * nothing else in an alpine frame is) and reports the count, the bounding box
 * and the brightest value found.
 *
 * The alpine palette has no other saturated warm at high luminance: road ochre
 * is `#c9a45f` (b/r = 0.47 but luminance 0.66, below the gate) and the flower
 * reds are dark. Verified by running this on a frame with no burst in it, which
 * returns 0 hot pixels.
 *
 *   node tools/jump-hot.mjs shots/fix/jump_alpine_t106p9.png
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage();

for (const f of files) {
  const b64 = readFileSync(f).toString('base64');
  const r = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, peak = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const R = d[i] / 255, G = d[i + 1] / 255, B = d[i + 2] / 255;
      // hot = bright AND warm. Both gates matter: the sky is bright and cold,
      // the road is warm and dim.
      // Calibrated against a frame with no burst in it (`jump_alpine` at t=105,
       // 0 hot px): the chevron boards' red is dark, the road ochre's blue is too
       // high, and the car's stripe is small and not this saturated at this gain.
      if (R > 0.985 && R - B > 0.42 && G > 0.55 && G < 0.93) {
        n++;
        const x = p % c.width, y = (p / c.width) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (R + G + B > peak) peak = R + G + B;
      }
    }
    return { n, w: c.width, h: c.height, box: x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1], peak: +peak.toFixed(2) };
  }, b64);
  const pct = r.box ? ((r.box[2] / r.w) * 100).toFixed(1) : '0.0';
  console.log(
    `${f.split('/').pop().padEnd(30)} hot ${String(r.n).padStart(6)} px  ` +
    `bbox ${r.box ? r.box.join(',') : '-'}  = ${pct}% of frame width  peak ${r.peak}`,
  );
}
await browser.close();
