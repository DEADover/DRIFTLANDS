/**
 * HUD. Deliberately minimal and typographic — big numbers, no boxes, no
 * gradients. It must never fight the landscape for attention.
 */
export class Hud {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <style>
        .hud { position:absolute; inset:0; font-family: ui-monospace, "SF Mono", Menlo, monospace;
               color:#fff; text-shadow: 0 2px 10px rgba(0,0,0,.45); }
        .hud .speed { position:absolute; left:36px; bottom:28px; display:flex; align-items:baseline; gap:8px; }
        .hud .speed b { font-size:76px; font-weight:800; letter-spacing:-3px; line-height:.9; font-variant-numeric: tabular-nums; }
        .hud .speed span { font-size:15px; opacity:.72; letter-spacing:3px; }
        .hud .gear { position:absolute; left:36px; bottom:112px; font-size:20px; opacity:.7; letter-spacing:2px; }
        .hud .place { position:absolute; left:36px; top:30px; font-size:13px; letter-spacing:4px; opacity:.8; text-transform:uppercase; }
        .hud .placeName { position:absolute; left:36px; top:50px; font-size:29px; font-weight:700; letter-spacing:-.5px; }
        .hud .drift { position:absolute; left:50%; top:16%; transform:translateX(-50%); text-align:center;
                      opacity:0; transition:opacity .12s; }
        .hud .drift b { font-size:56px; font-weight:800; letter-spacing:-2px; font-variant-numeric: tabular-nums;
                        color:#ffd23f; display:block; line-height:1; }
        .hud .drift span { font-size:13px; letter-spacing:6px; opacity:.85; }
        .hud .help { position:absolute; right:34px; bottom:28px; font-size:12px; line-height:1.8;
                     text-align:right; opacity:.42; letter-spacing:1px; }
      </style>
      <div class="hud">
        <div class="place">NOW ENTERING</div>
        <div class="placeName" data-place>—</div>
        <div class="gear" data-gear>GEAR 1</div>
        <div class="speed"><b data-speed>0</b><span>KM/H</span></div>
        <div class="drift" data-drift><b data-driftScore>0</b><span>DRIFT</span></div>
        <div class="help">W A S D&nbsp;&nbsp;drive<br>SPACE&nbsp;&nbsp;handbrake<br>R&nbsp;&nbsp;reset&nbsp;&nbsp;·&nbsp;&nbsp;1-5&nbsp;&nbsp;travel</div>
      </div>`;
    this.speedEl = root.querySelector('[data-speed]');
    this.gearEl = root.querySelector('[data-gear]');
    this.placeEl = root.querySelector('[data-place]');
    this.driftEl = root.querySelector('[data-drift]');
    this.driftScoreEl = root.querySelector('[data-driftScore]');
  }

  setPlace(name) {
    this.placeEl.textContent = name;
  }

  update(v, driftScore) {
    const kmh = Math.round(v.speed * 3.6);
    this.speedEl.textContent = kmh;
    this.gearEl.textContent = `GEAR ${v.gear}`;
    if (driftScore > 40) {
      this.driftEl.style.opacity = '1';
      this.driftScoreEl.textContent = Math.round(driftScore);
    } else {
      this.driftEl.style.opacity = '0';
    }
  }

  setVisible(on) {
    this.root.style.display = on ? '' : 'none';
  }
}
