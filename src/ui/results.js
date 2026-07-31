/**
 * RESULTS TABLE — the standings overlay.
 *
 * CONTRACT (called by core/race.js only):
 *   createResults({ onRestart, onClose, key }) -> {
 *     open(model), update(model), close(), dispose(), get isOpen
 *   }
 *
 * `model` is `race.model()`: { state, lap, lapsTotal, laps:[{n,time,drift}],
 * lapTime, lapDrift, totals:{time,drift,best,bestDrift}, bank, key }.
 *
 * Every drift figure in here — the per-lap column, the footer, the TOP mark and
 * the verdict — is the BANKED score from fx/feel.js, the same number the HUD
 * has been rolling up in the corner all race. This file does no arithmetic on
 * it beyond adding the column up.
 *
 * ---------------------------------------------------------------------------
 * TYPOGRAPHY IS INHERITED, NOT INVENTED.
 *
 * ui/hud.js's design law is "a caption on a landscape, never a cockpit": type
 * only, no boxes, no bevels, no gauges. This table obeys it — the same
 * Helvetica Neue stack, the same 9.5-10 px uppercase labels at 3.2 px tracking,
 * the same tabular-nums figures, the same `--s` scalar so it holds from 720p to
 * 4K, and the same 1 px dark contour plus soft glow so white type survives a
 * snowfield behind it. The only things that are NOT in the HUD's vocabulary are
 * the scrim (a full-screen table has to be legible over a moving picture) and
 * the one button, which exists because the race must not dead-end.
 *
 * It does not touch the HUD's DOM. It mounts its own root on document.body, so
 * the two overlays cannot interfere and hiding the HUD with H does not hide the
 * results.
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** 84.62 -> "1:24.62". Rally convention: minutes only when there are any. */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const cs = Math.round(sec * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const ss = m ? String(s).padStart(2, '0') : String(s);
  return `${m ? m + ':' : ''}${ss}.${String(c).padStart(2, '0')}`;
}

/**
 * 1234567 -> "1 234 567". THE score formatter — ui/hud.js imports this one
 * rather than keeping its own near-duplicate, which grouped with a different
 * character and so printed the same figure a different way. The separator is
 * U+2009 THIN SPACE: at the sizes these numbers are set at, a full space reads
 * as two numbers and a comma reads as a decimal point.
 */
export function fmtScore(n) {
  const s = String(Math.max(0, Math.round(n) | 0));
  let o = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) o += ' ';
    o += s[i];
  }
  return o;
}

export function createResults({ onRestart, onClose, key = 'L' } = {}) {
  if (typeof document === 'undefined') {
    return { open() {}, update() {}, close() {}, dispose() {}, get isOpen() { return false; } };
  }

  const root = document.createElement('div');
  root.id = 'raceResults';
  root.innerHTML = TEMPLATE.replace(/%KEY%/g, key);
  document.body.appendChild(root);

  const q = (s) => root.querySelector(s);
  const el = {
    panel: q('[data-panel]'),
    head: q('[data-head]'),
    sub: q('[data-sub]'),
    body: q('[data-body]'),
    footTime: q('[data-foottime]'),
    footDrift: q('[data-footdrift]'),
    verdict: q('[data-verdict]'),
    restart: q('[data-restart]'),
    hint: q('[data-hint]'),
  };

  el.restart.addEventListener('click', () => onRestart?.());
  root.addEventListener('click', (e) => { if (e.target === root) onClose?.(); });

  let open = false;

  const scale = () => {
    const h = window.innerHeight || 900;
    root.style.setProperty('--s', clamp(h / 900, 0.78, 1.55).toFixed(3));
  };

  function render(m) {
    scale();
    const finished = m.state === 'finished';
    el.head.textContent = finished ? 'STAGE COMPLETE' : 'LAP TIMES';
    el.sub.textContent = finished
      ? `${m.lapsTotal} LAPS`
      : m.state === 'staging'
        ? 'CROSS THE LINE TO START'
        : `LAP ${m.lap} OF ${m.lapsTotal}`;

    /**
     * THE FOOTER IS THE SUM OF THE COLUMN ABOVE IT — literally, accumulated as
     * the rows are printed rather than read from a separate total.
     *
     * It used to print `totals.drift`, which is the completed laps only, while
     * the column above it also carried a live row for the lap in progress. Open
     * the table mid-race and the figures did not add up on screen; and the drift
     * column disagreeing with its own total is precisely the class of bug this
     * whole pass exists to remove. Summing what was drawn cannot drift out of
     * step with what was drawn.
     */
    let sumT = 0, sumD = 0;
    const rows = [];
    for (let i = 0; i < m.lapsTotal; i++) {
      const lap = m.laps[i];
      const isBest = lap && m.totals.best === lap.n;
      const isBestD = lap && m.totals.bestDrift === lap.n && lap.drift > 0;
      // The lap in progress gets its own live row, dimmed, so the table always
      // has exactly `lapsTotal` rows and never jumps height as laps land.
      const running = !lap && m.state === 'running' && i === m.laps.length;
      if (lap) { sumT += lap.time; sumD += lap.drift; }
      else if (running) { sumT += m.lapTime; sumD += m.lapDrift; }
      const cls = ['row'];
      if (isBest) cls.push('best');
      if (!lap && !running) cls.push('void');
      if (running) cls.push('live');
      rows.push(
        `<div class="${cls.join(' ')}">` +
        `<u>${String(i + 1).padStart(2, '0')}</u>` +
        `<b>${lap ? fmtTime(lap.time) : running ? fmtTime(m.lapTime) : '—'}</b>` +
        `<span class="flag">${isBest ? 'BEST' : ''}</span>` +
        `<b class="d">${lap ? fmtScore(lap.drift) : running ? fmtScore(m.lapDrift) : '—'}</b>` +
        `<span class="flag d">${isBestD ? 'TOP' : ''}</span>` +
        `</div>`
      );
    }
    el.body.innerHTML = rows.join('');

    el.footTime.textContent = fmtTime(sumT);
    el.footDrift.textContent = fmtScore(sumD);

    if (finished) {
      const best = m.laps.find((l) => l.n === m.totals.best);
      el.verdict.innerHTML =
        `<i>BEST LAP</i><b>${best ? fmtTime(best.time) : '—'}</b>` +
        `<i>ON LAP</i><b>${m.totals.best || '—'}</b>` +
        `<i>DRIFT</i><b>${fmtScore(m.totals.drift)}</b>`;
      el.verdict.style.display = '';
      el.restart.style.display = '';
      el.hint.innerHTML = `<u>ENTER</u><s>restart</s><u>%KEY%</u><s>close</s>`.replace('%KEY%', key);
    } else {
      el.verdict.style.display = 'none';
      el.restart.style.display = 'none';
      el.hint.innerHTML = `<u>${key}</u><s>close &middot; the stage is paused</s>`;
    }
  }

  return {
    get isOpen() { return open; },
    open(m) { open = true; render(m); root.classList.add('on'); },
    update(m) { if (open) render(m); },
    close() { open = false; root.classList.remove('on'); },
    dispose() { root.remove(); },
  };
}

const TEMPLATE = `
<style>
  #raceResults {
    --s: 1;
    --sans: "Helvetica Neue", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    /* The HUD's contour, verbatim: one dark outline and two soft glows. It is
       what keeps white type readable over fresh snow or a pale gravel road. */
    --ink:
      1px 0 0 rgba(4,7,12,.62), -1px 0 0 rgba(4,7,12,.62),
      0 1px 0 rgba(4,7,12,.62), 0 -1px 0 rgba(4,7,12,.62),
      0 0 calc(3px * var(--s)) rgba(4,7,12,.7),
      0 calc(2px * var(--s)) calc(14px * var(--s)) rgba(4,7,12,.7);
    position: fixed; inset: 0; z-index: 20;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--sans); color: #fff;
    -webkit-font-smoothing: antialiased;
    opacity: 0; visibility: hidden; pointer-events: none;
    /* NO TRANSITION — see the same note in ui/hud.js. A wall-clock fade is
       caught halfway by any screenshot, and it was: the first capture of this
       table came back at about 20% opacity over a sunlit gravel road, which is
       to say illegible. A pause screen has no business easing in anyway.
       The scrim is heavy on purpose: this type sits over a moving picture whose
       brightest surface (the road) is close to white. */
    background: radial-gradient(ellipse at 50% 48%, rgba(6,9,14,.80) 0%, rgba(6,9,14,.94) 74%);
  }
  #raceResults.on { opacity: 1; visibility: visible; pointer-events: auto; }
  #raceResults * { text-shadow: var(--ink); }

  #raceResults .panel {
    min-width: calc(440px * var(--s));
    padding: calc(10px * var(--s));
    text-align: left;
  }

  #raceResults .head {
    font-size: calc(34px * var(--s)); font-weight: 700;
    letter-spacing: calc(-.6px * var(--s)); line-height: 1.05;
  }
  #raceResults .sub {
    margin-top: calc(7px * var(--s));
    font-size: calc(10px * var(--s)); letter-spacing: calc(3.6px * var(--s));
    font-weight: 700; text-transform: uppercase; opacity: .56;
  }
  #raceResults .rule {
    height: calc(1.5px * var(--s)); background: #fff; opacity: .7;
    margin: calc(18px * var(--s)) 0 calc(4px * var(--s));
  }
  #raceResults .rule.thin { opacity: .28; height: calc(1px * var(--s)); margin: calc(6px * var(--s)) 0; }

  /* One grid, so every column lines up between head, rows and footer. */
  #raceResults .row, #raceResults .cols, #raceResults .foot {
    display: grid;
    grid-template-columns:
      calc(44px * var(--s)) calc(132px * var(--s)) calc(52px * var(--s))
      1fr calc(46px * var(--s));
    align-items: baseline; gap: calc(6px * var(--s));
  }
  #raceResults .cols i, #raceResults .foot i {
    font-style: normal; font-size: calc(9.5px * var(--s));
    letter-spacing: calc(3.2px * var(--s)); font-weight: 700; opacity: .5;
  }
  #raceResults .cols { padding: calc(9px * var(--s)) 0 calc(3px * var(--s)); }
  #raceResults .cols .d, #raceResults .row .d, #raceResults .foot .d { text-align: right; }

  #raceResults .row {
    padding: calc(4px * var(--s)) 0;
  }
  #raceResults .row u {
    text-decoration: none; font-size: calc(12px * var(--s));
    letter-spacing: calc(1.6px * var(--s)); font-weight: 700; opacity: .58;
    font-variant-numeric: tabular-nums;
  }
  #raceResults .row b {
    font-size: calc(26px * var(--s)); font-weight: 700;
    letter-spacing: calc(-.9px * var(--s)); font-variant-numeric: tabular-nums;
  }
  #raceResults .row b.d { font-size: calc(19px * var(--s)); opacity: .82; }
  #raceResults .row .flag {
    font-size: calc(8.5px * var(--s)); letter-spacing: calc(2.4px * var(--s));
    font-weight: 700; color: #ffc44a; opacity: .95;
  }
  /* The best lap is the one thing in the table that is allowed a colour, and it
     is the HUD's own BIG SLIDE amber — nothing new enters the palette here. */
  #raceResults .row.best b:not(.d) { color: #ffc44a; }
  #raceResults .row.void b, #raceResults .row.void u { opacity: .22; }
  #raceResults .row.live b, #raceResults .row.live u { opacity: .55; }

  #raceResults .foot { padding-top: calc(7px * var(--s)); }
  #raceResults .foot b {
    font-size: calc(28px * var(--s)); font-weight: 700;
    letter-spacing: calc(-1px * var(--s)); font-variant-numeric: tabular-nums;
  }
  #raceResults .foot b.d { font-size: calc(21px * var(--s)); opacity: .86; }

  #raceResults .verdict {
    display: flex; align-items: baseline; gap: calc(9px * var(--s));
    flex-wrap: wrap; margin-top: calc(16px * var(--s));
  }
  #raceResults .verdict i {
    font-style: normal; font-size: calc(9.5px * var(--s));
    letter-spacing: calc(3.2px * var(--s)); font-weight: 700; opacity: .5;
  }
  #raceResults .verdict b {
    font-size: calc(17px * var(--s)); font-weight: 700;
    font-variant-numeric: tabular-nums; padding-right: calc(12px * var(--s));
  }

  #raceResults button {
    margin-top: calc(22px * var(--s));
    font: inherit; cursor: pointer; pointer-events: auto;
    font-size: calc(12px * var(--s)); font-weight: 800;
    letter-spacing: calc(2.6px * var(--s)); text-transform: uppercase;
    color: #10141b; background: #fff; border: 0; border-radius: 999px;
    padding: calc(13px * var(--s)) calc(34px * var(--s));
    text-shadow: none;
    transition: transform .13s ease, background .13s;
  }
  #raceResults button:hover { transform: translateY(-1px); }
  #raceResults button:active { transform: translateY(0) scale(.99); }

  #raceResults .hint {
    margin-top: calc(16px * var(--s));
    font-size: calc(10px * var(--s)); letter-spacing: calc(1.9px * var(--s));
    font-weight: 700; opacity: .6;
  }
  #raceResults .hint u { text-decoration: none; opacity: 1; }
  #raceResults .hint s {
    text-decoration: none; opacity: .62; font-weight: 600;
    padding: 0 calc(14px * var(--s)) 0 calc(8px * var(--s));
  }
</style>
<div class="panel" data-panel>
  <div class="head" data-head>LAP TIMES</div>
  <div class="sub" data-sub></div>
  <div class="rule"></div>
  <div class="cols"><i>LAP</i><i>TIME</i><i></i><i class="d">DRIFT</i><i></i></div>
  <div class="rule thin"></div>
  <div data-body></div>
  <div class="rule thin"></div>
  <div class="foot">
    <i>TOTAL</i><b data-foottime>—</b><i></i><b class="d" data-footdrift>—</b><i></i>
  </div>
  <div class="verdict" data-verdict></div>
  <button type="button" data-restart>Restart stage</button>
  <div class="hint" data-hint></div>
</div>`;
