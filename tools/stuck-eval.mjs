#!/usr/bin/env node
/**
 * Throwaway page-eval harness: `node tools/stuck-eval.mjs file.js` boots the
 * real build headless and runs the file's default-exported body in the page
 * with `g = window.__GAME` in scope. Everything printed comes back as JSON.
 * Used only while diagnosing; the durable measurement lives in stuck-test.mjs.
 */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const av = process.argv.slice(2);
let base = 'http://127.0.0.1:5222', file = null;
for (let i = 0; i < av.length; i++) {
  if (av[i] === '--base') base = av[++i]; else file = av[i];
}
const src = await readFile(file, 'utf8');

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/?shot=hero_alpine&hud=0`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction('window.__SHOT_READY === true', null, { timeout: 180000 });

const out = await page.evaluate(async (body) => {
  const g = window.__GAME;
  const fn = new Function('g', `return (async () => { ${body} })()`);
  return await fn(g);
}, src);
await browser.close();
if (errors.length) console.error('PAGE ERRORS:', errors.slice(0, 5));
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
