import * as THREE from 'three';

/**
 * THE HERO CAR — a Group B rally hatch seen from a long way up.
 *
 * It is TINY on screen (~4-5% of frame width), so the read order is brutal:
 *   1. plan-view SILHOUETTE — a wide, blocky, arch-flared rectangle with a
 *      wing hanging off the back. Nothing tapered, nothing subtle.
 *   2. VALUE — a bright saturated body against a dark glasshouse and near-black
 *      wheels. Three values, big areas, hard edges.
 *   3. MOTION — the roll, the squat, the opposite lock on the front wheels.
 *      At this scale, visible counter-steer is most of why a drift reads as a
 *      drift rather than as a car pointing the wrong way.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LOFT AND NOT A PILE OF BOXES
 *
 * The client asked for a higher-poly model "with proper textures". There are no
 * image assets in this project and there is no room for one: at 4% of frame
 * width, 1 px is about 5 cm, and surface detail below that is invisible. What
 * IS visible at that size is the value of each FACET, because a facet is a big
 * flat area of one colour and the eye reads areas long after it stops reading
 * detail. So the fidelity went into facets, not pixels:
 *
 *   - the shell is a lofted section sweep, so the roofline and the shoulder are
 *     CURVED. Each of the four top facets per side takes a slightly different
 *     value from the sun instead of one flat white lid.
 *   - every horizontal edge is chamfered. A 0.10 m chamfer is 2 px, but it runs
 *     the whole 4.7 m length of the car and reads as a hard bright rim line
 *     along a ~90 px silhouette. This is the single biggest visual gain here.
 *   - the wheel arches are real ARCHES on a curve, not solid blisters. See
 *     § THE ARCHES ARE UNSPRUNG below — that is also the bug fix.
 *   - the livery is baked into the shell's vertex colours instead of being
 *     seven extra floating meshes.
 *
 * And it got CHEAPER. Everything that shares a material is one buffer, so the
 * car went from 29 meshes to 8 — 21 fewer draw calls in the colour pass and
 * again in the shadow pass — while the triangle count roughly tripled.
 * Triangles were never the constraint; draw calls were.
 *
 * Deliberately NOT modelled, having been tried and measured against the camera:
 *   - brake discs and calipers: they sit inboard of the wheel face and are
 *     occluded by the flare from every angle this camera ever takes.
 *   - door shut lines: they run down the flank, which is foreshortened to
 *     nothing from 52 degrees up. Bonnet and hatch shut lines DO run across the
 *     car, so those are here, as a chamfered step rather than a groove.
 */

// Works rally livery, from the client's car reference: white shell, red and
// blue spine stripes, gold wheel centres, amber indicators.
const LIVERY_RED = 0xe4302c;
const LIVERY_BLUE = 0x1c56b8;
// Dropped from 0xc8912f: under this sun the old value clipped to a vivid orange
// disc that pulled more attention than the whole glasshouse. It still reads as
// gold at 19 px, which is all it has to do.
const WHEEL_GOLD = 0x9a6f24;
const AMBER = 0xff7a1a;
const GLASS = 0x141c26;
const TRIM = 0x1c1f25;
const TYRE = 0x14161a;

// Overall track across the flares. The STATIONS table below owns the shell's
// own width; this is only what sticks out past it.
const ARCH_W = 2.14;

/** Tyre radius and half-width. The wheel is the one dimension everything else
 *  has to clear, so it is declared before anything that has to clear it. */
const WHEEL_R = 0.46;
const TYRE_HW = 0.21;
/** Wheel stations. Order is FL, FR, RL, RR — +z first, matching `positions`. */
const AXLE_F = 1.34, AXLE_R = -1.32;
const WHEEL_Z = ARCH_W / 2 - 0.14;        // 0.93

/**
 * ARCH CLEARANCE — the number the client's bug report is really about.
 *
 * The flare's inner surface is a cylinder of this radius about the wheel centre.
 * It has to clear the tyre plus the largest the wheel ever rises relative to the
 * chassis, which is the per-corner weight-transfer term in update(): at most
 * 0.055 (pitch) + 0.050 (roll) = 0.105 m. 0.16 m of gap leaves 0.055 m of
 * margin and still looks like a rally car's deliberately huge arch gap.
 */
const ARCH_GAP = 0.16;
const ARCH_R = WHEEL_R + ARCH_GAP;        // 0.62

// ---------------------------------------------------------------------------
// A tiny mesher. Everything is non-indexed: flat shading wants per-face normals
// anyway, and per-face vertex colours need unshared vertices, so indexing would
// buy nothing and cost the hard colour boundaries the livery depends on.
// ---------------------------------------------------------------------------

class Mesher {
  constructor() { this.pos = []; this.col = []; }

  tri(a, b, c, col) {
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.col.push(col[0], col[1], col[2]);
    }
  }

  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }

  /** An axis-aligned box, chamfer-free. For small hard details only. */
  box(w, h, d, x, y, z, col) {
    const X0 = x - w / 2, X1 = x + w / 2;
    const Y0 = y - h / 2, Y1 = y + h / 2;
    const Z0 = z - d / 2, Z1 = z + d / 2;
    const v = (a, b, c) => [a, b, c];
    this.quad(v(X0, Y1, Z1), v(X1, Y1, Z1), v(X1, Y1, Z0), v(X0, Y1, Z0), col); // +y
    this.quad(v(X0, Y0, Z0), v(X1, Y0, Z0), v(X1, Y0, Z1), v(X0, Y0, Z1), col); // -y
    this.quad(v(X1, Y0, Z0), v(X1, Y1, Z0), v(X1, Y1, Z1), v(X1, Y0, Z1), col); // +x
    this.quad(v(X0, Y0, Z1), v(X0, Y1, Z1), v(X0, Y1, Z0), v(X0, Y0, Z0), col); // -x
    this.quad(v(X0, Y0, Z1), v(X1, Y0, Z1), v(X1, Y1, Z1), v(X0, Y1, Z1), col); // +z
    this.quad(v(X1, Y0, Z0), v(X0, Y0, Z0), v(X0, Y1, Z0), v(X1, Y1, Z0), col); // -z
  }

  get tris() { return this.pos.length / 9; }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** sRGB hex -> linear working-space triple, optionally scaled. */
const _c = new THREE.Color();
function C(hex, mul = 1) {
  _c.setHex(hex);
  return [_c.r * mul, _c.g * mul, _c.b * mul];
}

/**
 * Loft a run of closed sections along -x (nose to tail).
 *
 * Every section is the same closed loop of [z, y] points, ordered centre-top,
 * out along +z, down the flank, across the floor, and back up the -z side. That
 * ordering is what makes the winding below produce outward normals; if a section
 * is ever reordered, the car turns inside out and the shadow pass says so first.
 *
 * `colourFor(ring, edge)` colours each band, which is how the livery, the glass
 * and the bumpers get painted without a second material.
 */
function loft(m, stations, colourFor) {
  for (let s = 0; s < stations.length - 1; s++) {
    const A = stations[s], B = stations[s + 1];
    const n = A.loop.length;
    for (let e = 0; e < n; e++) {
      const e2 = (e + 1) % n;
      m.quad(
        [A.x, A.loop[e][1], A.loop[e][0]],
        [B.x, B.loop[e][1], B.loop[e][0]],
        [B.x, B.loop[e2][1], B.loop[e2][0]],
        [A.x, A.loop[e2][1], A.loop[e2][0]],
        colourFor(s, e),
      );
    }
  }
}

/** Fan-cap a section. `front` faces +x, otherwise -x. */
function cap(m, st, front, col) {
  const p = st.loop.map(([z, y]) => [st.x, y, z]);
  for (let i = 1; i < p.length - 1; i++) {
    if (front) m.tri(p[0], p[i], p[i + 1], col);
    else m.tri(p[0], p[i + 1], p[i], col);
  }
}

/** Mirror a half-outline (centre-top .. centre-bottom) into a closed loop. */
function closeLoop(half) {
  const loop = half.slice();
  for (let i = half.length - 2; i >= 1; i--) loop.push([-half[i][0], half[i][1]]);
  return loop;
}

// ---------------------------------------------------------------------------
// THE SHELL
// ---------------------------------------------------------------------------

/**
 * One lower-body section.
 *
 * The half-outline runs: crown centre, two stripe edges, crown outer, shoulder
 * chamfer, upper flank, the two flank-flash edges, the ARCH UNDERCUT, sill,
 * floor edge, floor centre. 13 points a side, 24 in the closed loop.
 *
 * `wLow` is the width BELOW the undercut and it is the whole wheel-clearance
 * story: at the two axle stations it pulls in to 0.58, well inboard of the
 * tyre's inner sidewall at 0.72, so the body has an actual wheel well instead of
 * a slab of tub occupying the same space as the tyre.
 */
function shellSection(s) {
  const crown = (z) => s.yTop - s.camber * (z / Math.max(s.wTop, 1e-3)) ** 2;
  const half = [
    [0, crown(0)],
    [0.015, crown(0.015)],
    [0.215, crown(0.215)],
    [s.wTop * 0.60, crown(s.wTop * 0.60)],
    [s.wTop, crown(s.wTop)],
    [s.wMax, s.yTop - 0.10],          // shoulder chamfer, bottom edge
    [s.wMax, s.yFlash + 0.075],       // upper flank
    [s.wMax, s.yFlash],               // flash: red band
    [s.wMax, s.yFlash - 0.075],       // flash: blue band
    [s.wMax, s.yUnder],               // flank, above the undercut
    [s.wLow, s.yUnder - 0.13],        // ARCH UNDERCUT — the tuck over the tyre
    [s.wLow * 0.90, s.ySill],
    [s.wFloor, s.y0],
    [0, s.y0],
  ];
  return { x: s.x, half, loop: closeLoop(half), s };
}

/** Edge names, in loop order, so colourFor can switch on meaning not index. */
const SHELL_EDGES = (() => {
  const a = ['crownC', 'stripeA', 'crownM', 'crownO', 'shoulder', 'flankHi',
    'flashA', 'flashB', 'flankLo', 'undercut', 'sill', 'floorEdge', 'floor'];
  const b = ['floor', 'floorEdge', 'sill', 'undercut', 'flankLo', 'flashB',
    'flashA', 'flankHi', 'shoulder', 'crownO', 'crownM', 'stripeB', 'crownC'];
  if (a.length + b.length !== 26) throw new Error('shell edge table out of step with the section');
  return [...a, ...b];
})();

/**
 * STATION TABLE — the whole shape of the car, in one place.
 *
 * x runs nose (+) to tail (-). Read the axle rows against WHEEL_Z (0.93) and
 * TYRE_HW (0.21): the tyre's inner sidewall is at 0.72, and `wMax` at the axles
 * is 0.60. That 0.12 m is the wheel well, and it is why the body narrows over
 * the wheels — which is also what a flared rally car looks like, the flare
 * standing proud of a narrower shell. It has to hold over the tyre's whole
 * length (x 0.88 to 1.80 at the front), not just at the axle line, or the tread
 * clips the door section at its rearmost sliver: hence the 1.66 and 1.06 rows.
 *
 * `yUnder` must stay below `yFlash - 0.075` or the outline doubles back on
 * itself and the section self-intersects. It did, at the axle stations, in the
 * first cut of this table.
 *
 * The 1.06/1.00 pair and the -2.00/-2.06 pair are SHUT LINES: two stations a few
 * centimetres apart with a step between them. A 0.02 m groove would be a fifth
 * of a pixel and would not read; a step gives the bonnet's trailing edge and the
 * hatch a genuine chamfer facet that takes its own value from the sun.
 */
const STATIONS = [
  //  x      y0    ySill  yUnder yFlash  yTop  wFloor wLow  wMax  wTop  camber
  [+2.60, 0.50, 0.62, 0.74, 0.86, 0.94, 0.56, 0.68, 0.76, 0.66, 0.02],
  [+2.46, 0.40, 0.52, 0.74, 0.86, 1.00, 0.62, 0.78, 0.86, 0.76, 0.02],
  [+2.16, 0.36, 0.50, 0.76, 0.88, 1.10, 0.66, 0.80, 0.90, 0.78, 0.03],
  [+1.94, 0.34, 0.50, 0.80, 0.90, 1.13, 0.62, 0.70, 0.80, 0.70, 0.03],
  [+1.66, 0.34, 0.50, 0.82, 0.90, 1.13, 0.56, 0.54, 0.62, 0.56, 0.03],
  [+1.34, 0.34, 0.50, 0.82, 0.90, 1.13, 0.54, 0.52, 0.60, 0.54, 0.03],
  [+1.06, 0.34, 0.50, 0.82, 0.90, 1.13, 0.56, 0.54, 0.62, 0.56, 0.03],
  [+1.00, 0.34, 0.50, 0.80, 0.90, 1.09, 0.54, 0.56, 0.64, 0.56, 0.03],
  [+0.86, 0.34, 0.50, 0.78, 0.90, 1.16, 0.56, 0.58, 0.66, 0.58, 0.04],
  [+0.70, 0.32, 0.50, 0.78, 0.92, 1.18, 0.64, 0.78, 0.86, 0.76, 0.04],
  [+0.40, 0.32, 0.50, 0.78, 0.92, 1.18, 0.64, 0.84, 0.90, 0.80, 0.04],
  [-0.40, 0.32, 0.50, 0.78, 0.92, 1.18, 0.64, 0.84, 0.90, 0.80, 0.04],
  [-0.70, 0.32, 0.50, 0.78, 0.92, 1.18, 0.64, 0.78, 0.86, 0.76, 0.04],
  [-0.86, 0.34, 0.50, 0.78, 0.90, 1.18, 0.56, 0.58, 0.66, 0.58, 0.04],
  [-1.04, 0.34, 0.50, 0.82, 0.90, 1.17, 0.56, 0.54, 0.62, 0.56, 0.03],
  [-1.32, 0.34, 0.50, 0.82, 0.90, 1.17, 0.54, 0.52, 0.60, 0.54, 0.03],
  [-1.64, 0.34, 0.50, 0.82, 0.90, 1.17, 0.56, 0.54, 0.62, 0.56, 0.03],
  [-1.92, 0.36, 0.50, 0.80, 0.90, 1.17, 0.62, 0.72, 0.82, 0.74, 0.03],
  [-2.00, 0.38, 0.52, 0.78, 0.90, 1.17, 0.62, 0.74, 0.84, 0.76, 0.03],
  [-2.06, 0.38, 0.52, 0.78, 0.90, 1.13, 0.62, 0.74, 0.84, 0.76, 0.03],
  [-2.20, 0.44, 0.56, 0.76, 0.88, 1.10, 0.58, 0.70, 0.80, 0.72, 0.02],
  [-2.32, 0.54, 0.64, 0.74, 0.86, 1.02, 0.50, 0.60, 0.68, 0.58, 0.02],
].map(([x, y0, ySill, yUnder, yFlash, yTop, wFloor, wLow, wMax, wTop, camber]) =>
  shellSection({ x, y0, ySill, yUnder, yFlash, yTop, wFloor, wLow, wMax, wTop, camber }));

/**
 * THE GLASSHOUSE.
 *
 * From 52 degrees up the roof panel hides anything under it, so the glass has to
 * BE a visible surface: the top band between the first two stations IS the
 * windscreen and between the last two IS the backlight, both raked to face the
 * camera. That dark-light-dark banding along the car is what stops it reading as
 * a brick, and it is why the roof is only 1.4 m long between them.
 *
 * The rear stations pull in to 0.66 half-width because the rear tyre's inner
 * sidewall is at 0.72 and the greenhouse passes over it.
 */
const CABIN = [
  //  x      yBelt  yWin  yTop   wG   camber
  [+0.90, 1.14, 1.18, 1.20, 0.74, 0.01],
  [+0.34, 1.14, 1.44, 1.58, 0.78, 0.04],
  [-0.26, 1.14, 1.48, 1.66, 0.80, 0.05],
  [-1.00, 1.14, 1.46, 1.65, 0.72, 0.05],
  [-1.46, 1.14, 1.36, 1.50, 0.64, 0.04],
  [-1.80, 1.14, 1.18, 1.20, 0.58, 0.02],
].map(([x, yBelt, yWin, yTop, wG, camber]) => {
  const crown = (z) => yTop - camber * (z / wG) ** 2;
  const half = [
    [0, crown(0)],
    [0.015, crown(0.015)],
    [0.215, crown(0.215)],
    [wG * 0.60, crown(wG * 0.60)],
    [wG, crown(wG) - 0.05],     // roof drip rail
    [wG, yWin],                 // window line
    [wG - 0.03, yBelt],
    [0, yBelt],
  ];
  return { x, half, loop: closeLoop(half), yTop };
});

const CABIN_EDGES = (() => {
  const a = ['crownC', 'stripeA', 'crownM', 'crownO', 'rail', 'glass', 'belt'];
  const b = ['belt', 'glass', 'rail', 'crownO', 'crownM', 'stripeB', 'crownC'];
  if (a.length + b.length !== 14) throw new Error('cabin edge table out of step with the section');
  return [...a, ...b];
})();

// ---------------------------------------------------------------------------
// THE WHEEL-CLEARANCE QUERY
//
// The client reported wheels sinking into the car's own frame. That cannot be
// judged by eye at 4% of frame width, so the body answers a question instead:
// HOW WIDE IS THE BODY AT THIS (x, y)? `tools/wheelbox.mjs` drives a lap,
// pushes points off the tyre surface into body-local space and asks. Anything
// with |z| under the answer is inside the car.
//
// This is the exact section, not a bounding box — a covering box round each
// lofted ring was tried first and reported 0.15 m of interpenetration where the
// real clearance was +0.08, because it claimed the shell was as wide at sill
// height as it is at the shoulder. A conservative audit that cries wolf is
// worse than no audit: it hides the real number.
//
// Derived from the same station table the geometry is lofted from, so it cannot
// drift out of date when the shape changes — which is exactly how the original
// bug survived this long.
// ---------------------------------------------------------------------------

/**
 * Half-width of a lofted body at (x, y), or -1 where there is no material.
 * @param {Array<{x:number, half:Array<[number,number]>}>} sections nose-to-tail
 */
function halfWidthAt(sections, x, y) {
  if (x > sections[0].x || x < sections[sections.length - 1].x) return -1;
  let i = 0;
  while (i < sections.length - 2 && sections[i + 1].x > x) i++;
  const A = sections[i], B = sections[i + 1];
  const t = (A.x - x) / Math.max(A.x - B.x, 1e-9);
  let best = -1;
  for (let k = 0; k < A.half.length - 1; k++) {
    // The lofted outline at this station, one segment at a time.
    const z0 = A.half[k][0] + (B.half[k][0] - A.half[k][0]) * t;
    const y0 = A.half[k][1] + (B.half[k][1] - A.half[k][1]) * t;
    const z1 = A.half[k + 1][0] + (B.half[k + 1][0] - A.half[k + 1][0]) * t;
    const y1 = A.half[k + 1][1] + (B.half[k + 1][1] - A.half[k + 1][1]) * t;
    if ((y < Math.min(y0, y1)) || (y > Math.max(y0, y1))) continue;
    const u = Math.abs(y1 - y0) < 1e-9 ? 0 : (y - y0) / (y1 - y0);
    const z = z0 + (z1 - z0) * u;
    if (z > best) best = z;
  }
  return best;
}

// ---------------------------------------------------------------------------

export function buildCarMesh({ body = 0xf2f3f5 } = {}) {
  const root = new THREE.Group();
  root.name = 'car';

  const SHELL = C(body);
  const SHELL_HI = C(body, 1.04);
  const SHELL_LO = C(body, 0.80);
  // Same lesson as the flares: 0.62 read as near-white and turned the sills into
  // a second bright band that made the car look fat from above.
  const TUCK = C(body, 0.16);
  const DARK = C(TRIM);
  const RED = C(LIVERY_RED);
  const BLUE = C(LIVERY_BLUE);
  const GLS = C(GLASS);

  const shellMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const litMat = new THREE.MeshBasicMaterial({ vertexColors: true });

  // ------------------------------------------------------------------- shell
  const m = new Mesher();

  // Which rings carry the spine stripes. The stripe runs bonnet, roof, hatch —
  // three separate runs of the same two colours, which is what makes it read as
  // one line down the car rather than three unrelated marks.
  const bonnetRing = (r) => STATIONS[r].x <= 1.90 && STATIONS[r].x >= 1.00;
  const bootRing = (r) => STATIONS[r].x <= -1.88 && STATIONS[r].x >= -2.20;
  const striped = (r) => bonnetRing(r) || bootRing(r);
  // Bumpers: the first two and last two rings wear trim below the shoulder.
  const bumper = (r) => r < 2 || r >= STATIONS.length - 3;

  loft(m, STATIONS, (ring, edge) => {
    const kind = SHELL_EDGES[edge];
    switch (kind) {
      case 'stripeA': return striped(ring) ? RED : SHELL_HI;
      case 'stripeB': return striped(ring) ? BLUE : SHELL_HI;
      case 'crownC': case 'crownM': return SHELL_HI;
      case 'crownO': return SHELL;
      case 'shoulder': return SHELL_HI;      // the chamfer: catches the sun
      case 'flashA': return bumper(ring) ? DARK : RED;
      case 'flashB': return bumper(ring) ? DARK : BLUE;
      case 'undercut': return TUCK;          // reads as the arch shadow line
      case 'sill': case 'floorEdge': return bumper(ring) ? DARK : SHELL_LO;
      case 'floor': return DARK;
      default: return bumper(ring) ? DARK : SHELL;
    }
  });
  cap(m, STATIONS[0], true, DARK);
  cap(m, STATIONS[STATIONS.length - 1], false, DARK);

  // ------------------------------------------------------------- glasshouse
  loft(m, CABIN, (ring, edge) => {
    const kind = CABIN_EDGES[edge];
    const isScreen = ring === 0 || ring >= 3;
    if (kind === 'glass') return GLS;
    if (kind === 'belt') return SHELL_LO;
    if (isScreen && (kind === 'crownC' || kind === 'crownM' || kind === 'crownO'
      || kind === 'stripeA' || kind === 'stripeB' || kind === 'rail')) return GLS;
    if (kind === 'stripeA') return RED;
    if (kind === 'stripeB') return BLUE;
    if (kind === 'rail') return SHELL_LO;
    return SHELL_HI;
  });
  cap(m, CABIN[0], true, GLS);
  cap(m, CABIN[CABIN.length - 1], false, GLS);

  // ------------------------------------------------------- bonnet furniture
  // A scoop and two vents. Each is only 6-8 px, but they are BLACK on the
  // brightest, flattest, most camera-facing panel on the car, so they are the
  // highest-contrast small feature available and they read as intent.
  m.box(0.44, 0.10, 0.46, 1.62, 1.16, 0, DARK);           // scoop lid
  m.box(0.30, 0.09, 0.42, 1.44, 1.11, 0, C(0x0d0f13));    // scoop mouth
  for (const z of [0.44, -0.44]) m.box(0.34, 0.05, 0.16, 1.86, 1.12, z, C(0x0d0f13));

  // Mirrors on short stalks. 0.18 m is under 4 px, but they break the shoulder
  // line at exactly the point where a car's silhouette pinches, and they cost
  // 24 triangles inside a mesh that was going to be drawn anyway.
  for (const z of [1, -1]) {
    m.box(0.07, 0.05, 0.16, 0.82, 1.17, z * 0.78, DARK);
    m.box(0.16, 0.11, 0.09, 0.80, 1.21, z * 0.88, DARK);
  }

  // Front splitter, and the light-pod bar. The bar is deliberately DEEP (0.16)
  // rather than a slat: half of it is buried in the nose, so the pods standing
  // on it read as mounted rather than hovering, which is what they did when the
  // bar was 0.09 and the pods floated 0.07 m clear of the bonnet crown.
  m.box(0.52, 0.07, ARCH_W - 0.20, 2.44, 0.33, 0, DARK);
  m.box(0.30, 0.16, 1.44, 2.26, 1.03, 0, DARK);

  // ------------------------------------------------------------------- wing
  // A real aerofoil section, not a slab. The wing is 0.42 x 2.08 m — about
  // 8 x 42 px — and it is the most isolated shape on the car, sitting alone
  // against the ground with nothing behind it. A cambered upper surface gives
  // that 42 px bar three values instead of one, which is the difference between
  // reading as a wing and reading as a smudge.
  const WING_X = -2.28, WING_Y = 1.44, WING_HS = (ARCH_W - 0.06) / 2;
  const foil = [
    [+0.21, 0.000], [+0.09, 0.062], [-0.06, 0.058], [-0.21, 0.012],  // upper
    [-0.21, -0.012], [-0.02, -0.028], [+0.14, -0.020],               // lower
  ];
  for (let i = 0; i < foil.length; i++) {
    const a = foil[i], b = foil[(i + 1) % foil.length];
    m.quad(
      [WING_X + a[0], WING_Y + a[1], +WING_HS],
      [WING_X + a[0], WING_Y + a[1], -WING_HS],
      [WING_X + b[0], WING_Y + b[1], -WING_HS],
      [WING_X + b[0], WING_Y + b[1], +WING_HS],
      DARK,
    );
  }
  for (const s of [1, -1]) {
    for (let i = 1; i < foil.length - 1; i++) {
      const p = (k) => [WING_X + foil[k][0], WING_Y + foil[k][1], s * WING_HS];
      if (s > 0) m.tri(p(0), p(i), p(i + 1), DARK);
      else m.tri(p(0), p(i + 1), p(i), DARK);
    }
    m.box(0.46, 0.13, 0.05, WING_X, WING_Y + 0.05, s * (WING_HS + 0.03), DARK); // endplate
    m.box(0.10, 0.32, 0.10, WING_X + 0.05, WING_Y - 0.16, s * 0.62, DARK);      // stalk
  }

  const shell = new THREE.Mesh(m.geometry(), shellMat);
  shell.name = 'shell';
  shell.castShadow = true;
  root.add(shell);

  // ------------------------------------------------------------------ lights
  const lm = new Mesher();
  const WARM = C(0xfff4d2), AMB = C(AMBER);
  // Four rally pods on the bar, then the headlamps and indicators set INTO the
  // nose. The old ones sat at |z| 0.55 and 0.86 on a 1.70 m wide nose; this nose
  // is 1.80 at its widest and 1.52 at the tip, and at 0.86 they hung in the air
  // beside the bodywork — clearly visible in a rear-three-quarter render.
  for (const z of [-0.51, -0.17, 0.17, 0.51]) lm.box(0.26, 0.09, 0.26, 2.26, 1.16, z, WARM);
  // On the NOSE CAP (x 2.60), not inside the nose. The previous pair sat at
  // x 2.53 where the shell is 0.84 half-width, so a 0.34 m lamp at |z| 0.44 was
  // entirely buried inside the bodywork and drew nothing at all.
  for (const z of [0.40, -0.40]) lm.box(0.12, 0.17, 0.34, 2.60, 0.82, z, WARM);
  for (const z of [0.60, -0.60]) lm.box(0.10, 0.11, 0.16, 2.58, 0.66, z, AMB);
  const lights = new THREE.Mesh(lm.geometry(), litMat);
  lights.name = 'lights';
  root.add(lights);

  // Tail lights sit on the very back edge, tall enough to catch the camera even
  // at 52 degrees — they are the only thing on the car that says "braking", so
  // they keep their own mesh and their own material to be re-coloured.
  const tm = new Mesher();
  for (const z of [0.40, -0.40]) tm.box(0.12, 0.20, 0.40, -2.34, 0.92, z, [1, 1, 1]);
  const tailMat = new THREE.MeshBasicMaterial({ color: 0x8a1616 });
  const tails = new THREE.Mesh(tm.geometry(), tailMat);
  tails.name = 'tails';
  root.add(tails);

  // ------------------------------------------------------------------ arches
  //
  // § THE ARCHES ARE UNSPRUNG, AND THAT IS THE BUG FIX.
  //
  // MEASURED on the old model (tools/wheelbox.mjs, 2600 frames of a driven lap):
  // a tyre was inside a body panel in 100% of frames. At rest the tyre crown sat
  // 0.26 m up inside the flare — because the flare was a solid box, not an arch —
  // and 0.18 m of the 0.42 m tyre width was inside the tub. Under load it reached
  // -0.81 m and -0.51 m.
  //
  // The static half is fixed by geometry: real arcs at ARCH_R, and a shell that
  // pulls in to 0.58 half-width over the axles.
  //
  // The dynamic half cannot be fixed on the body node, and the arithmetic says
  // why. The body carries up to 0.30 rad of weight-transfer roll — a value with
  // no physical meaning, chosen for how it reads — and 0.30 m of spring ride.
  // Roll maps z into y regardless of where the pivot is, so at the 0.93 m
  // half-track the leeward arch dives 0.93*sin(0.30) = 0.27 m onto its tyre, and
  // the ride height adds 0.30, and pitch adds 0.13. That is the 0.81 m measured,
  // and no arch drawn on a leaning node can clear it without becoming a monster
  // truck.
  //
  // So the arches go on the CHASSIS, at the wheel stations. This is NOT the two
  // nodes being merged back — that separation stands and the wheels are still
  // the only thing besides the ground pose on the chassis. It is one part being
  // put in the frame it belongs to: a wheel arch's entire job is to stay a fixed
  // distance from its wheel, and here it now does, exactly, in every frame. The
  // shell still leans over it, which is what a car does.
  //
  // The flares are drawn body-colour x0.34 like the old ones, which is dark
  // enough that the shear between a leaning shell and steady flares reads as
  // shadow rather than as two objects.
  const am = new Mesher();
  // MEASURED IN A RENDER, not picked from the hex. The old flares were
  // body x 0.34 with a comment saying that was "deliberately much darker" — in
  // an actual `car_plan` frame under this sun they came out a pale lavender,
  // barely a step off the white shell, and the four corners of the car had no
  // dark mass at all. The brief's value structure is bright shell / dark
  // glasshouse / NEAR-BLACK wheels, and the flare is most of what the camera
  // sees of a wheel from above, so it has to join the wheels, not the shell.
  // Absolute values, not a fraction of the body colour. A multiplier is the
  // wrong control here: this sun puts several units of light on an upward face,
  // so body x 0.34 measured as a PALE LAVENDER in a render and body x 0.15 was
  // still mid-grey. The flare has to sit with the tyre (0x14161a) in the value
  // structure, so it is specified where it has to land.
  const FLARE = C(0x23262c);
  const FLARE_HI = C(0x32363e);
  const archNodes = [];
  for (const [wx, wz] of [[AXLE_F, WHEEL_Z], [AXLE_F, -WHEEL_Z],
    [AXLE_R, WHEEL_Z], [AXLE_R, -WHEEL_Z]]) {
    const sign = Math.sign(wz);
    const SEG = 9, SPAN = 1.78;      // +-102 degrees: the lips reach below the axle
    const ring = (t) => {
      const a = (t - 0.5) * 2 * SPAN;
      const sa = Math.sin(a), ca = Math.cos(a);
      // The flare is WIDEST at the crown and tapers to the lips — an arch that
      // follows a curve in plan as well as in section, which is what separates a
      // rally flare from a rectangular blister.
      // The lip stops INSIDE the tyre's outer sidewall (1.14), not over it. A
      // fender that covers the whole tread hides the wheel completely from 52
      // degrees up, and the wheels are one of the three values the car is built
      // from — they have to be visible as dark mass at the four corners.
      const zo = sign * (1.02 - 0.09 * (1 - ca) / 1.2);
      // Inner edge tucks INSIDE the shell's 0.60 half-width at the axle, so the
      // wheel well closes instead of leaving a slot you can see down.
      const zi = sign * 0.56;
      const p = (r, z) => [wx + sa * r, WHEEL_R + ca * r, z];
      return [p(ARCH_R, zi), p(ARCH_R + 0.02, zo), p(ARCH_R + 0.11, zo), p(ARCH_R + 0.06, zi)];
    };
    let prev = ring(0);
    for (let i = 1; i <= SEG; i++) {
      const cur = ring(i / SEG);
      for (let e = 0; e < 4; e++) {
        const e2 = (e + 1) % 4;
        // Outward-facing winding depends on which side of the car we are on.
        if (sign > 0) am.quad(prev[e], cur[e], cur[e2], prev[e2], e === 2 ? FLARE_HI : FLARE);
        else am.quad(prev[e2], cur[e2], cur[e], prev[e], e === 2 ? FLARE_HI : FLARE);
      }
      prev = cur;
    }
    // Mud flaps behind each wheel. Pure silhouette: a 0.30 x 0.26 m black
    // rectangle hanging below the tail of the arch, which is unmistakably rally
    // in plan view and costs 12 triangles.
    am.box(0.05, 0.28, 0.30, wx - 0.58, 0.30, sign * 0.90, C(0x101216));
    archNodes.push([wx, wz]);
  }
  const arches = new THREE.Mesh(am.geometry(), shellMat);
  arches.name = 'arches';
  arches.castShadow = true;

  // ------------------------------------------------------------------ wheels
  //
  // 14-sided, with a real tyre profile: a flat tread band, chamfered shoulders,
  // then the sidewall dropping to the rim. The chamfer matters more than the
  // side count — it puts a bright rim of reflected sky around a near-black
  // circle, which is what makes a wheel read as round from directly above.
  //
  // Five spokes on the OUTER face only. The inner face is closed with a flat
  // annulus: it faces the car, and the flare occludes it from every angle this
  // camera takes. Discs and calipers were tried there and are invisible for the
  // same reason.
  const SIDES = 14;
  function wheelGeometry(sign) {
    const w = new Mesher();
    const TY = C(TYRE), TY_HI = C(0x1e2128), GOLD = C(WHEEL_GOLD), GOLD_LO = C(WHEEL_GOLD, 0.7);
    const OUT = sign * TYRE_HW, IN = -sign * TYRE_HW;
    const ring = (r, z) => {
      const p = [];
      for (let i = 0; i < SIDES; i++) {
        const a = (i / SIDES) * Math.PI * 2;
        p.push([Math.cos(a) * r, Math.sin(a) * r, z]);
      }
      return p;
    };
    const tread = [ring(WHEEL_R, OUT * 0.74), ring(WHEEL_R, IN * 0.74)];
    const shoulder = [ring(WHEEL_R - 0.05, OUT), ring(WHEEL_R - 0.05, IN)];
    const bead = [ring(0.30, OUT * 0.94), ring(0.30, IN * 0.94)];
    const dish = ring(0.25, OUT * 0.72);
    const hub = ring(0.09, OUT * 0.80);
    const band = (a, b, col, flip) => {
      for (let i = 0; i < SIDES; i++) {
        const j = (i + 1) % SIDES;
        if (flip) w.quad(a[i], b[i], b[j], a[j], col);
        else w.quad(a[j], b[j], b[i], a[i], col);
      }
    };
    const out = sign > 0;
    band(tread[0], tread[1], TY, out);
    band(shoulder[0], tread[0], TY_HI, out);
    band(tread[1], shoulder[1], TY_HI, out);
    band(bead[0], shoulder[0], TY, out);
    band(shoulder[1], bead[1], TY, out);
    band(dish, bead[0], GOLD, out);
    band(hub, dish, GOLD_LO, out);
    // Inner face: one flat annulus, then a cap. Nothing here is ever seen.
    band(bead[1], ring(0.0001, IN * 0.94), TY, out);
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES;
      if (out) w.tri(hub[0], hub[i], hub[j], GOLD);
      else w.tri(hub[0], hub[j], hub[i], GOLD);
    }
    // Five spokes, proud of the dish so they cast their own value step.
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const g = new Mesher();
      g.box(0.30, 0.075, 0.03, 0.155, 0, 0, GOLD);
      for (let k = 0; k < g.pos.length; k += 3) {
        const x = g.pos[k], y = g.pos[k + 1], z = g.pos[k + 2];
        w.pos.push(x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a),
          z + OUT * 0.80);
        w.col.push(g.col[k], g.col[k + 1], g.col[k + 2]);
      }
    }
    // Already built with the axle along z, which is what `hubs[i].rotation.z`
    // spins about — no rotate step, unlike the CylinderGeometry this replaced.
    return w.geometry();
  }
  const wheelGeoL = wheelGeometry(1);
  const wheelGeoR = wheelGeometry(-1);

  const wheels = [];
  const hubs = [];
  const positions = [
    [AXLE_F, WHEEL_R, WHEEL_Z], [AXLE_F, WHEEL_R, -WHEEL_Z],
    [AXLE_R, WHEEL_R, WHEEL_Z], [AXLE_R, WHEEL_R, -WHEEL_Z],
  ];
  for (const [x, y, z] of positions) {
    const steerNode = new THREE.Group();      // yaw only — steering
    const spinNode = new THREE.Group();       // roll only — rotation
    const tyre = new THREE.Mesh(z > 0 ? wheelGeoL : wheelGeoR, shellMat);
    tyre.name = 'wheel';
    tyre.castShadow = true;
    spinNode.add(tyre);
    steerNode.add(spinNode);
    steerNode.position.set(x, y, z);
    root.add(steerNode);
    wheels.push(steerNode);
    hubs.push(spinNode);
  }

  return {
    root, wheels, hubs, arches, bodyMesh: shell, tails, bodyMat: shellMat, tailMat,
    // Handed out on the instance, not just as a module export: under vite HMR a
    // re-imported module is a second instance, which is a quietly wrong answer.
    /** Body half-width at (x, y) in body-local space; -1 where there is nothing. */
    halfWidthAt: (x, y) => Math.max(halfWidthAt(STATIONS, x, y), halfWidthAt(CABIN, x, y)),
    archGeom: { r: ARCH_R, gap: ARCH_GAP, wheelR: WHEEL_R, stations: archNodes },
  };
}

const clamp = THREE.MathUtils.clamp;

/**
 * How deep the deepest wheel is allowed to sit before the seating lift reacts.
 *
 * Seating to exactly zero sounds right and is not: the lift is a MAXIMUM over
 * four wheels, so whichever wheel's ground query reads highest raises the other
 * three with it. While the height query and the drawn mesh still disagree by
 * about half a metre at wheel spacing, that overpayment showed up as a median
 * 0.221 m of FLOAT — half a tyre of daylight under a parked car, with the
 * shadow visibly detached.
 *
 * A tolerance buys some of that back for a penetration nobody can see at this
 * camera height, and the exchange rate is measured:
 *
 *   SEAT_TOL   median float   wheel samples deeper than 0.10 m
 *     0.00       -0.221 m                13.5%
 *     0.06       -0.168 m                17.1%
 *     0.15       -0.098 m                27.4%
 *
 * 0.06 because the complaint on the table is sinking, not hovering. This whole
 * constant is a symptom of the query, not a design choice: when roads and
 * terrain report the surface they actually draw, the four wheels stop
 * disagreeing by half a metre, the overpayment disappears, and this should come
 * down to a couple of centimetres.
 */
const SEAT_TOL = 0.02;

/**
 * How far a wheel may extend below its static position to reach the ground.
 *
 * A real rally car has ~0.20 m of droop; this is the visual equivalent. Bounded
 * on purpose: past the stroke the wheel stays in the air, which is what should
 * happen when the car is cocked over a crest or hanging a wheel off a verge.
 */
const DROOP_MAX = 0.20;
/** Scratch vector for per-wheel ground queries; avoids a per-frame allocation. */
const _wp = new THREE.Vector3();

/**
 * Visual layer over the Vehicle physics.
 *
 * Everything here is read from telemetry the vehicle already publishes — this
 * class never changes the simulation, it only tells the truth about it louder:
 * roll into the slide, dive under brakes, squat on power, suspension travel
 * over terrain, wheel spin, and opposite lock on the front axle.
 */
export class CarView {
  constructor(opts) {
    const built = buildCarMesh(opts);
    this.root = built.root;
    this.wheels = built.wheels;
    this.hubs = built.hubs;
    this.tails = built.tails;
    this.bodyMat = built.bodyMat;
    /** Body-local clearance query and arch geometry. See tools/wheelbox.mjs. */
    this.halfWidthAt = built.halfWidthAt;
    this.archGeom = built.archGeom;

    /**
     * TWO NODES, BECAUSE THEY ARE TWO DIFFERENT THINGS.
     *
     *   chassis — where the car IS. Carries the ground pose only, and the wheels
     *             are on it, so a wheel moves when and only when the ground
     *             under the car moves.
     *   body    — how the car LOOKS. Carries dive, squat and roll into a slide,
     *             plus the spring ride height. Purely cosmetic, and the wheels
     *             are NOT on it.
     *
     * They used to be one node, with the wheels under it, and that was quietly
     * expensive: a cosmetic lean rotated the wheels too. Measured, +0.30 rad of
     * weight-transfer roll — a value with no physical meaning at all, chosen for
     * how it reads — moved the four wheels by -0.42, +0.47, -0.49 and +0.41 m in
     * world Y, nearly a tyre diameter of spread. The old code compensated the
     * node's TRANSLATION on each wheel and never its ROTATION, so the seating
     * lift then levitated the whole car to put the deepest wheel back on the
     * ground. With the lean zeroed and nothing else changed, that lift never
     * fired at all over 60 s of driving and the wheel-to-wheel disagreement
     * collapsed from a 0.378 m median to 0.037 m: nine tenths of the problem was
     * self-inflicted here, and no amount of work on the ground queries could
     * have touched it.
     *
     * The wheel ARCHES are on the chassis with the wheels, for the same reason
     * and with the same evidence — see § THE ARCHES ARE UNSPRUNG in
     * buildCarMesh(). Everything else the eye reads as "the car" is on `body`.
     */
    this.chassis = new THREE.Group();
    this.body = new THREE.Group();
    while (this.root.children.length) this.body.add(this.root.children[0]);
    // The wheels ride with the ground, not with the lean. So do their arches.
    for (const w of this.wheels) this.chassis.add(w);
    // The arches were never put on `root`, so they arrive here directly.
    this.chassis.add(built.arches);
    this.arches = built.arches;
    this.chassis.add(this.body);
    this.root.add(this.chassis);

    this.suspension = this.wheels.map(() => 0);
    /** Low-passed rigid lift that seats the deepest wheel (see update()). */
    this._seatLift = 0;
    /** Low-passed per-wheel spring extension toward the ground (see update()). */
    this._droop = [0, 0, 0, 0];
    this.wheelSpin = 0;
    this._roll = 0;
    this._pitch = 0;
    this._bodyY = 0;

    // Headlights: a spot per side, cheap but they sell the dusk biomes.
    this.headlight = new THREE.SpotLight(0xfff0d0, 0, 90, 0.42, 0.5, 1.2);
    this.headlight.position.set(2.4, 0.8, 0);
    this.headlightTarget = new THREE.Object3D();
    this.headlightTarget.position.set(40, -6, 0);
    this.headlight.target = this.headlightTarget;
    this.root.add(this.headlight, this.headlightTarget);
  }

  setHeadlights(on) {
    this.headlight.intensity = on ? 260 : 0;
    this._lightsOn = on;
  }

  /**
   * @param {import('./vehicle.js').Vehicle} v
   * @param {{normal: THREE.Vector3, height: number}} ground
   */
  /**
   * @param {(x:number,z:number)=>number} [sampleHeight] world ground height
   *        query, used to seat each wheel individually. Optional so the view
   *        still works standalone, but the game always supplies it.
   */
  /** Drop the seating filters; used on respawn so the car does not arrive mid-lift. */
  resetSeating() {
    this._seatLift = 0;
    this._droop = [0, 0, 0, 0];
    this._bodyY = 0;
    this._roll = 0;
    this._pitch = 0;
  }

  update(dt, v, ground, sampleHeight) {
    const k = (rate) => 1 - Math.exp(-rate * Math.max(dt, 1e-5));

    // Suspension: the vehicle owns the vertical spring (so the feel layer can
    // read landing impacts from it); we just consume the deflection.
    const ride = v.updateVertical ? v.updateVertical(dt, ground.height) : 0;

    this.root.position.set(v.position.x, ground.height, v.position.z);
    const pose = ground.pose;
    this.root.rotation.y = v.heading;

    // ---- weight transfer ---------------------------------------------------
    // Roll comes from real lateral acceleration, not a slip proxy, so it loads
    // up as the car takes a set and unwinds as the slide is caught.
    const targetRoll = clamp(-(v.rollAccel ?? 0) * 0.030 - (v.lateralSlip ?? 0) * 0.10, -0.30, 0.30);
    const targetPitch = clamp(-(v.pitchAccel ?? 0) * 0.0135, -0.10, 0.10);
    this._roll += (targetRoll - this._roll) * k(11);
    this._pitch += (targetPitch - this._pitch) * k(9);

    // Orientation comes from the CONTACT-PATCH PLANE (see Game.carPose), not
    // from a terrain normal sampled under the car's centre. Those two disagree
    // on every gradient, and the disagreement is what used to bury or float the
    // wheels: the body tilted by one amount while the wheels needed another.
    //
    // Dynamic squat and roll are added ON TOP as small offsets, so weight
    // transfer still reads without ever breaking contact.
    // THE GROUND PITCH WAS APPLIED UPSIDE DOWN, AND IT IS THE SINKING.
    //
    // A rotation about local z maps a point at local x to y' = x*sin(theta).
    // The wheels sit at x = +1.34 (front) and -1.32 (rear), so a climb — where
    // carPose reports pitch > 0, nose up — needs theta > 0. It was applied as
    // -gp, which drove the uphill axle straight into the hill.
    //
    // MEASURED before the flip, by reading the world position of the four wheel
    // nodes and comparing the bottom of each tyre against the triangle beneath
    // it (tools/probe.mjs --only wheels, 1560 samples along the route):
    //
    //                 FL      FR      RL      RR
    //   climbing     +0.690  +0.670  -0.103  -0.112
    //   descending   +0.030  -0.077  +0.366  +0.301
    //
    // Equal and opposite front to rear, and the pair swaps when the gradient
    // does: the exact signature of a mirrored pitch. 62.3% of wheel samples were
    // more than 0.10 m inside the ground, mean 0.265 m, worst 2.58 m. That is
    // several times larger than the height-query error everyone had been
    // hunting, and it is why the car appeared to sink specifically on climbs and
    // descents rather than uniformly.
    const gp = pose?.pitch ?? 0;
    const gr = pose?.roll ?? 0;
    this.chassis.rotation.z = gp;
    // The ground ROLL was mirrored too, and it hid behind the pitch error until
    // that one was fixed. Same test, same evidence: with `+ gr` the four wheels
    // showed a clean left-to-right gradient (FL +0.114, FR +0.031, RL -0.078,
    // RR -0.114) that is the algebraic signature of the draw disagreeing with
    // the ride-height solve about which side of the car the roll lifts. With
    // `- gr`: p95 0.817 -> 0.546 m, max 1.835 -> 1.510, deeper than 0.10 m
    // 45.4% -> 39.6%. Better on every aggregate, so it is not a wash.
    this.chassis.rotation.x = -gr;

    // Weight transfer and the springs move the BODY over the wheels, which is
    // what they do on a real car. Nothing here reaches the contact patches, so
    // none of it can lift a tyre off the road any more.
    this.body.rotation.z = this._pitch;
    this.body.rotation.x = this._roll;
    this._bodyY += (ride - this._bodyY) * k(20);
    this.body.position.y = clamp(this._bodyY, -0.30, 0.30);

    // ---- wheels ------------------------------------------------------------
    const spinRate = (Math.abs(v.longSpeed ?? v.speed) * (1 + (v.wheelSpinBoost ?? 0) * 1.6)) / 0.46;
    this.wheelSpin += spinRate * dt;

    // Counter-steer: v.steer already contains the assist, and in a slide that
    // is opposite lock. Amplify it a touch — at this camera height a few
    // degrees of wheel angle is invisible, and this is the drift's signature.
    const steerVis = clamp((v.steer ?? 0) * 1.30, -0.78, 0.78);

    const rollN = clamp((v.rollAccel ?? 0) / 11, -1, 1);
    const pitchN = clamp((v.pitchAccel ?? 0) / 11, -1, 1);
    for (let i = 0; i < 4; i++) {
      const front = i < 2 ? 1 : -1;
      const leftSide = i % 2 === 0 ? 1 : -1;
      // Bounded at 0.105 m of rise, and ARCH_GAP (0.16) is sized against exactly
      // this sum. If these coefficients grow, the arches have to grow with them.
      const corner = (pitchN * front * 0.055) + (rollN * leftSide * 0.05);
      this.suspension[i] += (corner - this.suspension[i]) * k(12);
      const w = this.wheels[i];
      w.rotation.set(0, i < 2 ? steerVis : 0, 0);
      // No "undo the body's vertical move" term any more: the body moves on its
      // own node now, so there is nothing here to cancel.
      w.position.y = WHEEL_R + this.suspension[i];
      this.hubs[i].rotation.z = -this.wheelSpin;
    }

    /**
     * SEAT THE WHOLE CAR, ONCE, AFTER THE TRANSFORM IS FINAL.
     *
     * Game.carPose already solves a ride height at which no wheel is under its
     * ground — but it can only account for the tilt it knows about, the ground
     * plane. Everything added here is invisible to it: the weight-transfer lean
     * (up to ±0.30 rad, which at a 0.93 m half-track is ±0.27 m of wheel travel),
     * the spring ride height, and the per-corner suspension load. Measured, that
     * is exactly the residual left after the pitch and roll signs were fixed —
     * about 0.1 m, in the shape of whichever corner was loaded at the time.
     *
     * So ask the finished scene graph where the wheels actually ended up, and
     * lift the ROOT until the deepest one is on the ground. This is not the old
     * per-wheel correction pass that had to be removed: that one moved each
     * wheel independently and so fought the chassis transform every frame. This
     * is a single rigid translation of the entire car, which cannot fight
     * anything — it changes no angle and no relative position.
     *
     * Lift only, never push down: a wheel hanging in space over a crest or a
     * verge is correct and must stay hanging. Capped, because one bad ground
     * sample must not launch the car up the screen.
     */
    if (sampleHeight) {
      this.root.updateMatrixWorld(true);
      let lift = 0;
      for (let i = 0; i < 4; i++) {
        this.wheels[i].getWorldPosition(_wp);
        const need = sampleHeight(_wp.x, _wp.z) - (_wp.y - WHEEL_R) - SEAT_TOL;
        if (need > lift) lift = need;
      }
      // Smoothed, or facet-to-facet steps in the mesh arrive as a jolt. The rise
      // is quick because ground can only push; the release is slower.
      const want = lift > 0 ? Math.min(lift, 0.55) : 0;
      this._seatLift += (want - this._seatLift) * k(lift > 0 ? 30 : 12);
      this.root.position.y += this._seatLift;

      /**
       * DROOP — the springs take up what the rigid body cannot.
       *
       * Seating the deepest wheel is the right thing to do with a RIGID car, and
       * it necessarily leaves the other three in the air: a 4.2 x 1.9 m
       * rectangle resting on a faceted surface touches at one corner and hangs
       * at the rest. Measured with the ground query now exact, that was a median
       * 0.109-0.154 m of daylight under the other wheels — real rigid-body
       * behaviour, and it reads on screen as a hovering car.
       *
       * A real car does not hover, because its suspension extends. So extend it:
       * each wheel is allowed to drop toward its own ground, within a bounded
       * travel. This is NOT the per-wheel correction pass that had to be deleted.
       * That one moved wheels to make up for a chassis placed by a different
       * rule, so the two fought every frame. This runs after the chassis is
       * final, only ever extends, and is clamped to a real suspension stroke —
       * past the stroke the wheel stays in the air, which is exactly what should
       * happen when a car is cocked over a crest.
       *
       * Droop only ever LOWERS a wheel, so it opens the arch gap and can never
       * be the thing that buries a tyre in a flare.
       */
      this.root.updateMatrixWorld(true);
      /**
       * A CAR IN THE AIR HANGS ON ITS STOPS.
       *
       * DROOP_MAX is 0.20 m, which is right for a wheel hanging off a verge and
       * is 4 px at this camera — below the threshold at which anything reads. In
       * FLIGHT the springs are at full extension, and that is one of the few
       * airborne cues a top-down camera can actually show, so the stroke opens up
       * to 0.34 m (7 px per wheel, 14 px across the silhouette) whenever the pose
       * says the car is committed to a flight. `pose.airW` is the same
       * height-weighted term the airborne attitude uses, so this cannot fire on
       * the micro-hops that ordinary fast driving is full of.
       */
      const droopMax = DROOP_MAX + 0.14 * (pose?.airW ?? 0);
      for (let i = 0; i < 4; i++) {
        this.wheels[i].getWorldPosition(_wp);
        const gap = (_wp.y - WHEEL_R) - sampleHeight(_wp.x, _wp.z);
        const droop = clamp(gap, 0, droopMax);
        this._droop[i] += (droop - this._droop[i]) * k(18);
        this.wheels[i].position.y -= this._droop[i];
      }
    }

    // ---- lights ------------------------------------------------------------
    const braking = !!v._braking || (v.speed > 4 && (v.pitchAccel ?? 0) < -5);
    this.tails.material.color.setHex(braking ? 0xff4242 : 0x8a1616);
  }
}
