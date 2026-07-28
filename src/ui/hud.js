/**
 * HUD — owned by the hud/audio builder.
 *
 * Design law: the HUD is a *caption* on a landscape, never a cockpit. Type only.
 * No boxes, no bevels, no gauges, no gradients-as-decoration. Four corners of
 * quiet text, one loud number, and one moment of celebration when a slide lands.
 *
 * CONTRACT (called by game.js — do not widen without telling the lead):
 *   new Hud(rootEl)
 *   setPlace(name)                       -> plays the title card
 *   update(vehicle, driftScore, ctx)     -> ctx = { surface, feel }
 *   setVisible(on)
 *
 * Everything animates off a DETERMINISTIC clock (game.simTime) rather than
 * wall-clock CSS transitions, so a capture preset renders the exact same frame
 * every time. Nothing here uses Math.random().
 *
 * Screenshot mode: press H to hide the entire overlay. M toggles the route
 * ribbon. Both are pure view state; nothing else observes them.
 */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const seg = (t, a, b) => clamp01((t - a) / (b - a));
const easeOut = (x) => 1 - Math.pow(1 - x, 3);
const easeOutExpo = (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -9 * x));
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const lerp = (a, b, x) => a + (b - a) * x;

/** Grades a finished slide. Thresholds are on the raw game drift score. */
const TIERS = [
  { min: 0, name: 'SLIDE', col: '#ffe0a3' },
  { min: 320, name: 'BIG SLIDE', col: '#ffc44a' },
  { min: 760, name: 'HUGE SLIDE', col: '#ff9f3d' },
  { min: 1500, name: 'SUBLIME', col: '#ff6f45' },
];
const tierOf = (s) => {
  let t = TIERS[0];
  for (const c of TIERS) if (s >= c.min) t = c;
  return t;
};

const CHAIN_WINDOW = 2.6;   // seconds between slides that still counts as a chain
const PAYOUT_MIN = 110;     // below this a slide is not worth announcing
const TRACE_SPAN = 420;     // metres across the route ribbon

export class Hud {
  constructor(root) {
    this.root = root;
    root.innerHTML = TEMPLATE;

    const q = (s) => root.querySelector(s);
    this.el = {
      hud: q('[data-hud]'),
      place: q('[data-place]'),
      pOver: q('[data-pover]'),
      pRule: q('[data-prule]'),
      pMask: q('[data-pmask]'),
      pInner: q('[data-pinner]'),
      pSub: q('[data-psub]'),
      total: q('[data-total]'),
      best: q('[data-best]'),
      statWrap: q('[data-stats]'),
      trace: q('[data-trace]'),
      gears: q('[data-gears]'),
      rev: q('[data-rev]'),
      speed: q('[data-speed]'),
      drift: q('[data-drift]'),
      grade: q('[data-grade]'),
      score: q('[data-score]'),
      mult: q('[data-mult]'),
      pips: q('[data-pips]'),
      bank: q('[data-bank]'),
      help: q('[data-help]'),
      traceWrap: q('.traceWrap'),
      odo: q('[data-odo]'),
    };

    // gear numerals — a ladder of digits reads instantly and stays typographic
    this.gearTicks = [];
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('i');
      d.textContent = String(i + 1);
      this.el.gears.appendChild(d);
      this.gearTicks.push(d);
    }
    // chain pips
    this.pipEls = [];
    for (let i = 0; i < 8; i++) {
      const d = document.createElement('i');
      this.el.pips.appendChild(d);
      this.pipEls.push(d);
    }

    this.ctx2d = this.el.trace.getContext('2d');
    this.trace = [];
    this._traceAccum = 0;
    this._traceFrame = 0;

    // ---- animation / scoring state ----
    this.enterT = -999;
    this.placeName = '';
    this.subText = '';
    this.chain = 0;
    this.lastEnd = -999;
    this.peak = 0;
    this.wasDrift = false;
    this.payT0 = -999;
    this.payBase = 0;
    this.payMult = 1;
    this.payTotal = 0;
    this.total = 0;
    this.best = 0;
    this.shownTotal = 0;
    this.shownBest = 0;
    this.liveShown = 0;
    this.visible = true;
    this.showTrace = true;
    this.lastT = 0;
    this.lastGear = 1;
    this.shiftT = -999;
    this._scale = 0;

    // Demo script for the HUD-review capture presets (see presets.js). Real
    // gameplay never touches this — it only fires for shot ids prefixed
    // `huddemo_`, which exist purely so the drift readout can be art-directed
    // before the vehicle can produce a real 25-degree slide.
    this.demo = null;
    try {
      const shot = new URLSearchParams(location.search).get('shot') || '';
      if (shot.startsWith('huddemo')) this.demo = shot;
    } catch { /* no window.location — fine */ }

    this._onKey = (e) => {
      if (e.code === 'KeyH') this.setVisible(!this.visible);
      else if (e.code === 'KeyM') this.showTrace = !this.showTrace;
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', this._onKey);
    this._resize();
  }

  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this._onKey);
  }

  /** Deterministic clock: sim time when the game exposes it, wall clock otherwise. */
  _clock() {
    const g = typeof window !== 'undefined' ? window.__GAME : null;
    if (g && Number.isFinite(g.simTime)) return g.simTime;
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  /** One scalar keeps the whole overlay proportional from 720p to 4K. */
  _resize() {
    const h = (typeof window !== 'undefined' && window.innerHeight) || 900;
    const s = Math.max(0.78, Math.min(1.55, h / 900));
    if (Math.abs(s - this._scale) < 0.01) return;
    this._scale = s;
    this.el.hud.style.setProperty('--s', s.toFixed(3));
    const c = this.el.trace;
    const px = Math.round(168 * s);
    c.style.width = px + 'px';
    c.style.height = px + 'px';
    c.width = px * 2;
    c.height = px * 2;
  }

  // ---------------------------------------------------------------- title card
  setPlace(name) {
    this.placeName = String(name ?? '');
    this.el.place.textContent = this.placeName;
    this.enterT = this._clock();
    this.trace.length = 0;
    const g = typeof window !== 'undefined' ? window.__GAME : null;
    const bits = [];
    if (g?.biome?.id) bits.push(String(g.biome.id).toUpperCase());
    this._stageNo = (this._stageNo ?? 0) + 1;
    bits.push('STAGE ' + String(this._stageNo).padStart(2, '0'));
    this.subText = bits.join('  ·  ');
  }

  // ------------------------------------------------------------------- update
  update(v, driftScore, ctx) {
    try {
      this._resize();
      const t = this._clock();
      const dt = Math.max(0, Math.min(0.1, t - this.lastT));
      this.lastT = t;

      let score = Number.isFinite(driftScore) ? driftScore : 0;
      let drifting = !!v?.isDrifting;
      const feelMult = ctx?.feel?.chainMultiplier;

      if (this.demo) {
        const d = demoScript(t);
        score = d.score;
        drifting = d.drifting;
      }

      this._telemetry(v, t);
      this._title(t, ctx);
      this._drift(t, dt, score, drifting, feelMult);
      this._stats(dt);
      this._traceRibbon(v, dt, drifting);
    } catch (err) {
      // A HUD must never take the frame down with it.
      if (!this._warned) { this._warned = true; console.warn('[hud]', err); }
    }
  }

  // --------------------------------------------------------------- speed/gear
  _telemetry(v, t) {
    const kmh = Math.round(Math.max(0, (v?.speed ?? 0) * 3.6));
    if (kmh !== this._kmh) { this._kmh = kmh; this.el.speed.textContent = kmh; }

    const gear = Math.max(1, Math.min(6, v?.gear ?? 1));
    if (gear !== this.lastGear) { this.shiftT = t; this.lastGear = gear; }
    const k = clamp01(1 - (t - this.shiftT) / 0.34);
    const kick = easeOut(k) * k;
    for (let i = 0; i < 6; i++) {
      const cur = i === gear - 1;
      const el = this.gearTicks[i];
      el.style.opacity = cur ? 1 : i < gear ? 0.62 : 0.34;
      el.style.transform = `scale(${(cur ? 1.5 + kick * 0.34 : 1).toFixed(3)})`;
    }
    // shift kick: the speed cluster nudges up and settles
    this.el.speed.style.transform = `translateY(${(-3 * kick).toFixed(2)}px)`;

    const rpm = clamp01(v?.engineRpm ?? 0);
    this.el.rev.style.width = (1.5 + rpm * 98.5).toFixed(2) + '%';
    this.el.rev.style.opacity = (0.45 + rpm * 0.5).toFixed(3);
    // redline: the last sliver of the rev strip burns amber before the shift
    const red = clamp01((rpm - 0.84) / 0.14);
    const col = red > 0 ? mixHex('#ffffff', '#ff6f45', red) : '#fff';
    if (col !== this._revCol) { this._revCol = col; this.el.rev.style.background = col; }
  }

  // ---------------------------------------------------------------- titlecard
  _title(t, ctx) {
    const a = t - this.enterT;

    const inOver = seg(a, 0.05, 0.6);
    const inRule = easeOut(seg(a, 0.14, 0.95));
    const inName = easeOut(seg(a, 0.22, 1.05));
    const settle = easeInOut(seg(a, 4.2, 5.4));

    // name masks up from below, tracking tightens as it lands
    this.el.pInner.style.transform = `translateY(${((1 - inName) * 105).toFixed(2)}%)`;
    this.el.place.style.letterSpacing = `calc(${lerp(9, 0.4, inName).toFixed(2)}px * var(--s))`;

    // then the card settles down into a quiet corner label. The mask height is
    // driven with it so the block closes up instead of leaving a hole.
    const sc = lerp(1, 0.62, settle);
    this.el.place.style.setProperty('--settle', sc.toFixed(3));
    this.el.place.style.opacity = lerp(1, 0.82, settle).toFixed(3);
    if (!this._nameH) this._nameH = this.el.place.offsetHeight || 0;
    if (this._nameH) this.el.pMask.style.height = (this._nameH * sc).toFixed(1) + 'px';

    this.el.pOver.style.opacity = (inOver * (1 - settle)).toFixed(3);
    this.el.pOver.style.transform = `translateY(${((1 - inOver) * 7).toFixed(2)}px)`;
    this.el.pRule.style.transform = `scaleX(${(inRule * lerp(1, 0.26, settle)).toFixed(4)})`;
    this.el.pRule.style.opacity = (inRule * lerp(0.8, 0.34, settle)).toFixed(3);

    // surface line fades in once the card has settled
    const surf = ctx?.surface?.kind;
    const txt = this.subText + (surf ? '  ·  ' + String(surf).toUpperCase() : '');
    if (txt !== this._subShown) { this._subShown = txt; this.el.pSub.textContent = txt; }
    const inSub = seg(a, 4.7, 5.9);
    this.el.pSub.style.opacity = (inSub * 0.52).toFixed(3);
    this.el.pSub.style.transform = `translateY(${lerp(7, 0, inSub).toFixed(2)}px)`;
  }

  // -------------------------------------------------------------------- drift
  _drift(t, dt, score, drifting, feelMult) {
    // chain bookkeeping
    if (drifting && !this.wasDrift) {
      this.chain = t - this.lastEnd < CHAIN_WINDOW ? Math.min(this.chain + 1, 8) : 1;
      this.peak = 0;
      this.payT0 = -999;
    }
    if (drifting) this.peak = Math.max(this.peak, score);
    if (!drifting && this.wasDrift) {
      this.lastEnd = t;
      if (this.peak >= PAYOUT_MIN) {
        this.payT0 = t;
        this.payBase = this.peak;
        this.payMult = this._mult(feelMult);
        this.payTotal = this.payBase * this.payMult;
        this.total += this.payTotal;
        this.best = Math.max(this.best, this.payTotal);
      } else {
        this.chain = 0;
      }
    }
    this.wasDrift = drifting;
    if (!drifting && t - this.lastEnd > CHAIN_WINDOW) this.chain = 0;

    const mult = this._mult(feelMult);
    const pay = t - this.payT0;
    const paying = pay >= 0 && pay < 2.15;

    let vis = 0, y = 0, sc = 1, col = TIERS[0].col, txt = '0';
    let gradeTxt = 'SLIDE', multTxt = '×1.0', multVis = 0, bankVis = 0;

    if (drifting) {
      vis = clamp01((score - 25) / 55);
      const tier = tierOf(score);
      col = tier.col;
      gradeTxt = tier.name;
      // the number chases the truth so it always feels like it is climbing
      this.liveShown += (score - this.liveShown) * Math.min(1, dt * 14);
      txt = fmt(Math.round(this.liveShown));
      const ph = (this.liveShown % 100) / 100;         // small tick every 100 pts
      sc = 1 + 0.035 * Math.pow(1 - ph, 6) + clamp01(score / 2400) * 0.09;
      multTxt = '×' + mult.toFixed(1);
      multVis = mult > 1.04 ? 1 : 0;
      y = lerp(12, 0, easeOut(clamp01((score - 25) / 90)));
    } else if (paying) {
      const tier = tierOf(this.payBase);
      col = tier.col;
      gradeTxt = tier.name;
      // 0-0.12 slam · 0.10-0.72 count through the multiplier · hold · lift away
      const slam = seg(pay, 0, 0.12);
      const count = easeOutExpo(seg(pay, 0.1, 0.72));
      const lift = seg(pay, 1.5, 2.15);
      const val = lerp(this.payBase, this.payTotal, count);
      txt = fmt(Math.round(val));
      sc = 1 + 0.28 * (1 - easeOut(slam)) + 0.05 * (1 - count);
      vis = 1 - easeOut(lift);
      y = -36 * easeOut(lift);
      multTxt = '×' + this.payMult.toFixed(1);
      multVis = this.payMult > 1.04 ? seg(pay, 0.05, 0.28) : 0;
      if (slam < 1) col = mixHex('#ffffff', col, easeOut(slam));   // white-hot flash
      bankVis = seg(pay, 0.7, 0.95) * (1 - easeOut(seg(pay, 1.4, 1.9)));
      this.liveShown = val;
    } else {
      this.liveShown *= Math.exp(-dt * 6);
    }

    const d = this.el.drift;
    d.style.opacity = vis.toFixed(3);
    if (vis <= 0.002) { d.style.visibility = 'hidden'; return; }
    d.style.visibility = 'visible';
    d.style.transform = `translateX(-50%) translateY(${y.toFixed(2)}px)`;

    if (txt !== this._scoreTxt) { this._scoreTxt = txt; this.el.score.textContent = txt; }
    this.el.score.style.transform = `scaleX(.94) scale(${sc.toFixed(4)})`;
    if (col !== this._scoreCol) {
      this._scoreCol = col;
      this.el.score.style.color = col;
      this.el.grade.style.color = col;
    }
    if (gradeTxt !== this._gradeTxt) { this._gradeTxt = gradeTxt; this.el.grade.textContent = gradeTxt; }

    this.el.mult.style.opacity = multVis.toFixed(3);
    if (multTxt !== this._multTxt) { this._multTxt = multTxt; this.el.mult.textContent = multTxt; }
    this.el.mult.style.transform =
      `scale(${(paying ? lerp(2.2, 1, easeOut(seg(pay, 0.05, 0.42))) : 1).toFixed(3)})`;

    // chain pips — one per linked slide, the newest one long and bright
    const n = this.chain;
    for (let i = 0; i < this.pipEls.length; i++) {
      const on = i < n;
      const p = this.pipEls[i];
      p.style.opacity = on ? (i === n - 1 ? 1 : 0.5) : 0.1;
      p.style.background = on ? col : 'rgba(255,255,255,.85)';
      p.style.width = `calc(${on ? (i === n - 1 ? 17 : 9) : 5}px * var(--s))`;
    }
    this.el.pips.style.opacity = n > 1 ? '1' : '0';

    // The chip says only BANKED — the figure is already the big number above it,
    // and the session total is rolling up in the corner.
    this.el.bank.style.opacity = bankVis.toFixed(3);
    if (bankVis > 0) {
      this.el.bank.style.transform = `translateY(${(-9 * seg(pay, 0.7, 1.1)).toFixed(2)}px)`;
    }
  }

  _mult(feelMult) {
    if (Number.isFinite(feelMult) && feelMult > 1.04) return Math.min(9.9, feelMult);
    return Math.min(5, 1 + Math.max(0, this.chain - 1) * 0.5);
  }

  // -------------------------------------------------------------------- stats
  _stats(dt) {
    this.shownTotal += (this.total - this.shownTotal) * Math.min(1, dt * 7);
    this.shownBest += (this.best - this.shownBest) * Math.min(1, dt * 7);
    const a = fmt(Math.round(this.shownTotal));
    const b = fmt(Math.round(this.shownBest));
    if (a !== this._totalTxt) { this._totalTxt = a; this.el.total.textContent = a; }
    if (b !== this._bestTxt) { this._bestTxt = b; this.el.best.textContent = b; }
    // Driven off the sim clock, not a CSS transition — a wall-clock fade would
    // be caught halfway through by the screenshot harness.
    const want = this.total > 0 ? 1 : 0;
    this.statVis = (this.statVis ?? 0) + (want - (this.statVis ?? 0)) * Math.min(1, dt * 6);
    this.el.statWrap.style.opacity = this.statVis.toFixed(3);
  }

  // ------------------------------------------------------- route ribbon (map)
  _traceRibbon(v, dt, drifting) {
    if (!this.ctx2d || !v) return;

    this.odo = (this.odo ?? 0) + Math.max(0, v.speed ?? 0) * dt;
    const km = (this.odo / 1000).toFixed(this.odo < 10000 ? 1 : 0) + ' km';
    if (km !== this._odoTxt) { this._odoTxt = km; this.el.odo.textContent = km; }

    this._traceAccum += dt;
    if (this._traceAccum >= 0.085) {
      this._traceAccum = 0;
      this.trace.push({ x: v.position.x, z: v.position.z, d: drifting ? 1 : 0 });
      if (this.trace.length > 300) this.trace.shift();
    }
    // A two-point stub reads as a scratch on the frame, not as a map. Fade the
    // ribbon in only once there is a line worth showing.
    const presence = clamp01((this.trace.length - 4) / 22);
    this.el.traceWrap.style.opacity = (presence * (this.showTrace ? 1 : 0)).toFixed(3);
    if ((this._traceFrame++ % 2) !== 0) return;

    const c = this.el.trace;
    const g = this.ctx2d;
    const W = c.width, H = c.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (this.trace.length < 2) return;

    // The ribbon frames the LINE, not the world: fit the driven path to the
    // canvas so a thirty-second run always composes, then ease the framing so
    // it breathes instead of snapping. Centre is biased toward the car so the
    // arrowhead never drifts to the rim.
    const pts0 = this.trace;
    let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
    for (const q of pts0) {
      if (q.x < minx) minx = q.x;
      if (q.x > maxx) maxx = q.x;
      if (q.z < minz) minz = q.z;
      if (q.z > maxz) maxz = q.z;
    }
    const bx = (minx + maxx) / 2, bz = (minz + maxz) / 2;
    const wantSpan = Math.min(TRACE_SPAN,
      Math.max(110, Math.max(maxx - minx, maxz - minz) * 1.5));
    const ease = Math.min(1, dt * 1.6);
    this.fitSpan = (this.fitSpan ?? wantSpan) + (wantSpan - (this.fitSpan ?? wantSpan)) * ease;
    const tx = lerp(bx, v.position.x, 0.34), tz = lerp(bz, v.position.z, 0.34);
    this.fitX = (this.fitX ?? tx) + (tx - (this.fitX ?? tx)) * ease;
    this.fitZ = (this.fitZ ?? tz) + (tz - (this.fitZ ?? tz)) * ease;

    const k = W / this.fitSpan;
    const hh = v.heading ?? 0;
    const cx = this.fitX, cz = this.fitZ;
    g.translate(W / 2, H / 2);
    g.lineCap = 'round';
    g.lineJoin = 'round';

    const pts = this.trace;
    const N = pts.length;
    // Three passes: a dark contour so the line survives snow, the white line
    // itself, then the drifting stretches in amber. Age buckets keep the whole
    // ribbon down to a handful of strokes instead of one per segment.
    const BUCKETS = 7;
    const PASSES = [
      { w: 7.5, rgb: '4,7,12', a: 0.5 },
      { w: 3.0, rgb: '255,255,255', a: 0.95 },
    ];
    for (const P of PASSES) {
      for (let b = 0; b < BUCKETS; b++) {
        g.beginPath();
        let open = false;
        for (let i = 1; i < N; i++) {
          const age = 1 - i / N;                       // 0 = newest
          if (Math.min(BUCKETS - 1, Math.floor(age * BUCKETS)) !== b) { open = false; continue; }
          const p0 = pts[i - 1], p1 = pts[i];
          if (!open) { g.moveTo((p0.x - cx) * k, (p0.z - cz) * k); open = true; }
          g.lineTo((p1.x - cx) * k, (p1.z - cz) * k);
        }
        const fade = 0.36 + 0.64 * Math.pow(1 - b / BUCKETS, 1.1);
        g.lineWidth = P.w;
        g.strokeStyle = `rgba(${P.rgb},${(P.a * fade).toFixed(3)})`;
        g.stroke();
      }
    }

    // drift stretches overlaid in amber — you can read your own slides back
    g.beginPath();
    let open = false;
    for (let i = 1; i < N; i++) {
      if (!pts[i].d) { open = false; continue; }
      const p0 = pts[i - 1], p1 = pts[i];
      if (!open) { g.moveTo((p0.x - cx) * k, (p0.z - cz) * k); open = true; }
      g.lineTo((p1.x - cx) * k, (p1.z - cz) * k);
    }
    g.lineWidth = 3.6; g.strokeStyle = 'rgba(255,196,74,.98)'; g.stroke();

    // the car: a small arrowhead pointing along heading, contoured like the line
    const fx = Math.cos(hh), fz = -Math.sin(hh);
    const rx = -fz, rz = fx;
    const L = 13, Wd = 7.5;
    const ox = (v.position.x - cx) * k, oz = (v.position.z - cz) * k;
    g.beginPath();
    g.moveTo(ox + fx * L, oz + fz * L);
    g.lineTo(ox - fx * L * 0.55 + rx * Wd, oz - fz * L * 0.55 + rz * Wd);
    g.lineTo(ox - fx * L * 0.55 - rx * Wd, oz - fz * L * 0.55 - rz * Wd);
    g.closePath();
    g.lineWidth = 4.5; g.strokeStyle = 'rgba(4,7,12,.5)'; g.stroke();
    g.fillStyle = '#fff';
    g.fill();

    // vignette the ribbon away at its edges so it needs no frame at all
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    const rg = g.createRadialGradient(W / 2, H / 2, W * 0.36, W / 2, H / 2, W * 0.52);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(0.6, 'rgba(0,0,0,.22)');
    rg.addColorStop(0.88, 'rgba(0,0,0,.8)');
    rg.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------- screenshot mode
  setVisible(on) {
    this.visible = !!on;
    this.el.hud.style.opacity = this.visible ? '1' : '0';
  }
}

/** 1234567 -> 1 234 567. Thin groups read better than commas at display size. */
function fmt(n) {
  const s = String(Math.max(0, n | 0));
  let o = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) o += ' ';
    o += s[i];
  }
  return o;
}

function mixHex(a, b, x) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, x));
  const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, x));
  const bl = Math.round(lerp(pa & 255, pb & 255, x));
  return `rgb(${r},${g},${bl})`;
}

/**
 * Scripted drift telemetry for the `huddemo_*` capture presets only. The v0
 * vehicle cannot yet produce a real 25-degree slide, so the drift readout would
 * never appear in a screenshot and could not be art-directed. This is a review
 * fixture, not gameplay: unreachable unless the URL asks for it by name.
 */
function demoScript(t) {
  const runs = [
    [1.2, 3.1, 260],
    [4.0, 6.4, 720],
    [7.2, 10.4, 1980],
  ];
  for (const [a, b, top] of runs) {
    if (t >= a && t < b) {
      return { drifting: true, score: top * easeOut(clamp01((t - a) / (b - a))) };
    }
  }
  return { drifting: false, score: 0 };
}

const TEMPLATE = `
<style>
  .hud {
    --s: 1;
    /* A 1px dark contour plus two soft glows. The contour is what makes white
       type survive fresh snow; the glows are what make it sit on the picture
       instead of on top of it. */
    --ink:
      1px 0 0 rgba(4,7,12,.62), -1px 0 0 rgba(4,7,12,.62),
      0 1px 0 rgba(4,7,12,.62), 0 -1px 0 rgba(4,7,12,.62),
      1px 1px 0 rgba(4,7,12,.4), -1px -1px 0 rgba(4,7,12,.4),
      0 0 calc(3px * var(--s)) rgba(4,7,12,.7),
      0 calc(1px * var(--s)) calc(9px * var(--s)) rgba(4,7,12,.78),
      0 calc(3px * var(--s)) calc(22px * var(--s)) rgba(4,7,12,.6),
      0 calc(9px * var(--s)) calc(44px * var(--s)) rgba(4,7,12,.4);
    --edge: drop-shadow(0 0 1px rgba(4,7,12,.85)) drop-shadow(0 calc(2px * var(--s)) calc(9px * var(--s)) rgba(4,7,12,.5));
    --sans: "Helvetica Neue", "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    position:absolute; inset:0; color:#fff; font-family: var(--sans);
    -webkit-font-smoothing: antialiased; opacity:1;
    transition: opacity .28s ease;
  }
  .hud * { text-shadow: var(--ink); }
  .hud .scrim {
    position:absolute; inset:0; pointer-events:none; text-shadow:none;
    background:
      radial-gradient(58% 34% at 2% 100%,   rgba(5,8,13,.22), rgba(5,8,13,0) 66%),
      radial-gradient(46% 30% at 100% 100%, rgba(5,8,13,.18), rgba(5,8,13,0) 66%),
      radial-gradient(36% 26% at 0% 0%,     rgba(5,8,13,.19), rgba(5,8,13,0) 68%),
      radial-gradient(28% 20% at 100% 0%,   rgba(5,8,13,.14), rgba(5,8,13,0) 70%);
  }

  /* ------------------------------------------------------------- title card */
  .hud .place { position:absolute; left:calc(40px * var(--s)); top:calc(34px * var(--s)); }
  .hud .pOver {
    font-size:calc(10px * var(--s)); letter-spacing:calc(4.4px * var(--s));
    font-weight:600; opacity:.85; text-transform:uppercase; margin-bottom:calc(7px * var(--s));
  }
  .hud .pRule {
    width:calc(210px * var(--s)); height:calc(1.5px * var(--s)); background:#fff; opacity:.7;
    transform-origin:0 50%; margin-bottom:calc(9px * var(--s)); filter: var(--edge);
  }
  .hud .pMask { overflow:hidden; }
  .hud .pName {
    --settle: 1;
    display:block; transform: scale(var(--settle)); transform-origin:0 0;
    font-size:calc(38px * var(--s)); font-weight:700; line-height:1.06;
    white-space:nowrap;
  }
  .hud .pSub {
    margin-top:calc(10px * var(--s));
    font-size:calc(10px * var(--s)); letter-spacing:calc(3.2px * var(--s));
    font-weight:700; text-transform:uppercase; opacity:0;
  }

  /* ------------------------------------------------------------ score stats */
  .hud .stats {
    position:absolute; right:calc(40px * var(--s)); top:calc(34px * var(--s));
    text-align:right; opacity:0;
  }
  .hud .stats .row { display:flex; align-items:baseline; justify-content:flex-end; gap:calc(10px * var(--s)); }
  .hud .stats i {
    font-style:normal; font-size:calc(9.5px * var(--s)); letter-spacing:calc(3.2px * var(--s));
    font-weight:700; opacity:.62;
  }
  .hud .stats b {
    font-size:calc(23px * var(--s)); font-weight:700; letter-spacing:calc(-.3px * var(--s));
    font-variant-numeric: tabular-nums;
  }
  .hud .stats .row + .row { margin-top:calc(5px * var(--s)); }
  .hud .stats .row + .row b { font-size:calc(14px * var(--s)); opacity:.72; }
  .hud .stats .row + .row i { opacity:.44; }

  /* ---------------------------------------------------------- route  ribbon */
  .hud .traceWrap {
    position:absolute; right:calc(24px * var(--s)); bottom:calc(92px * var(--s));
    transition:opacity .3s ease;
  }
  .hud .trace { display:block; opacity:.95; text-shadow:none; }
  .hud .traceCap {
    display:flex; justify-content:flex-end; align-items:baseline;
    gap:calc(9px * var(--s)); margin-top:calc(-6px * var(--s)); padding-right:calc(14px * var(--s));
    font-size:calc(9px * var(--s)); letter-spacing:calc(3px * var(--s)); font-weight:700;
  }
  .hud .traceCap u { text-decoration:none; opacity:.42; }
  .hud .traceCap b {
    letter-spacing:calc(.6px * var(--s)); font-size:calc(10.5px * var(--s)); opacity:.72;
    font-variant-numeric: tabular-nums;
  }

  /* --------------------------------------------------------------- telemetry */
  .hud .tele { position:absolute; left:calc(40px * var(--s)); bottom:calc(34px * var(--s)); }
  .hud .gears {
    display:flex; align-items:flex-end; gap:calc(11px * var(--s));
    height:calc(17px * var(--s)); padding-left:calc(2px * var(--s));
  }
  .hud .gears i {
    font-style:normal; font-size:calc(10px * var(--s)); font-weight:700;
    line-height:1; transform-origin:50% 100%; font-variant-numeric: tabular-nums;
  }
  .hud .revWrap {
    position:relative; width:calc(158px * var(--s)); height:calc(2px * var(--s));
    margin:calc(10px * var(--s)) 0 calc(8px * var(--s)); background:rgba(255,255,255,.2);
    filter: var(--edge);
  }
  .hud .rev { position:relative; width:100%; height:100%; background:#fff; }
  .hud .rev::after {
    content:''; position:absolute; right:0; top:calc(-3px * var(--s));
    width:calc(2px * var(--s)); height:calc(8px * var(--s)); background:#fff;
  }
  .hud .speedRow { display:flex; align-items:baseline; gap:calc(11px * var(--s)); }
  .hud .speedRow b {
    font-size:calc(88px * var(--s)); font-weight:700; line-height:.84;
    letter-spacing:calc(-5px * var(--s)); font-variant-numeric: tabular-nums;
    transform-origin: 0 100%; display:inline-block;
  }
  .hud .speedRow span {
    font-size:calc(11px * var(--s)); letter-spacing:calc(3.6px * var(--s));
    font-weight:700; opacity:.66; padding-bottom:calc(7px * var(--s));
  }

  /* ------------------------------------------------------------------ drift */
  .hud .drift {
    position:absolute; left:50%; bottom:19%; transform:translateX(-50%);
    text-align:center; opacity:0; visibility:hidden;
  }
  .hud .dGrade {
    font-size:calc(10.5px * var(--s)); letter-spacing:calc(6px * var(--s)); font-weight:700;
    text-transform:uppercase; margin-bottom:calc(7px * var(--s)); opacity:.95;
    padding-left:calc(6px * var(--s));
  }
  .hud .dRow { display:flex; align-items:baseline; justify-content:center; gap:calc(13px * var(--s)); }
  .hud .dRow b {
    font-size:calc(64px * var(--s)); font-weight:700; line-height:.9;
    letter-spacing:calc(-2.4px * var(--s)); font-variant-numeric: tabular-nums;
    display:inline-block; transform-origin:50% 60%;
  }
  .hud .dRow em {
    font-style:normal; font-size:calc(23px * var(--s)); font-weight:700;
    letter-spacing:calc(-.5px * var(--s)); color:#fff; display:inline-block;
    transform-origin:0 65%;
  }
  .hud .dPips {
    display:flex; gap:calc(4px * var(--s)); justify-content:center;
    margin-top:calc(12px * var(--s)); filter: var(--edge);
  }
  .hud .dPips i { display:block; height:calc(2.5px * var(--s)); background:#fff; border-radius:1px; }
  .hud .dBank {
    margin-top:calc(11px * var(--s)); font-size:calc(10px * var(--s));
    letter-spacing:calc(4.4px * var(--s)); font-weight:700; opacity:0;
  }

  /* ------------------------------------------------------------------- help */
  .hud .help {
    position:absolute; right:calc(40px * var(--s)); bottom:calc(34px * var(--s));
    text-align:right; font-size:calc(10px * var(--s)); line-height:2;
    letter-spacing:calc(1.9px * var(--s)); font-weight:700; opacity:.72;
  }
  .hud .help u { text-decoration:none; opacity:1; }
  .hud .help s { text-decoration:none; opacity:.62; padding-left:calc(8px * var(--s)); font-weight:600; }
</style>
<div class="hud" data-hud>
  <div class="scrim"></div>

  <div class="place">
    <div class="pOver" data-pover>Now entering</div>
    <div class="pRule" data-prule></div>
    <div class="pMask" data-pmask><div data-pinner><div class="pName" data-place>—</div></div></div>
    <div class="pSub" data-psub></div>
  </div>

  <div class="stats" data-stats>
    <div class="row"><i>TOTAL</i><b data-total>0</b></div>
    <div class="row"><i>BEST</i><b data-best>0</b></div>
  </div>

  <div class="traceWrap">
    <canvas class="trace" data-trace width="300" height="300"></canvas>
    <div class="traceCap"><u>LINE</u><b data-odo>0.0 km</b></div>
  </div>

  <div class="tele">
    <div class="gears" data-gears></div>
    <div class="revWrap"><div class="rev" data-rev></div></div>
    <div class="speedRow"><b data-speed>0</b><span>KM/H</span></div>
  </div>

  <div class="drift" data-drift>
    <div class="dGrade" data-grade>SLIDE</div>
    <div class="dRow"><b data-score>0</b><em data-mult>×1.0</em></div>
    <div class="dPips" data-pips></div>
    <div class="dBank" data-bank>BANKED</div>
  </div>

  <div class="help" data-help>
    <u>W A S D</u><s>drive</s>&nbsp;&nbsp;&nbsp;<u>SPACE</u><s>handbrake</s><br>
    <u>R</u><s>reset</s>&nbsp;&nbsp;<u>M</u><s>map</s>&nbsp;&nbsp;<u>N</u><s>mute</s>&nbsp;&nbsp;<u>H</u><s>hide</s>
  </div>
</div>`;
