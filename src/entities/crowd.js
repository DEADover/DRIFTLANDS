import * as THREE from 'three';
import { Rng } from '../core/rng.js';

/**
 * SPECTATORS — the crowd behind the steel.
 *
 * CONTRACT:
 *   createCrowd(ctx) -> {
 *     group: THREE.Object3D
 *     update(dt, player) -> void       player = {position: Vector3, speed: number}
 *     count: number
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads, props, landmarks, bridges, jump, water }
 *
 * THE CLIENT'S RULE, AND IT IS THE WHOLE MODULE: "чтобы они стояли за железными
 * заборами" — spectators stand behind METAL GUARDRAILS and nowhere else. Not
 * behind the post-and-rail timber (that is a field boundary, not a safety
 * measure, and a car goes straight through it), not in the open meadow, never on
 * the road.
 *
 * So the population is not scattered and then filtered; it is GROWN OUT OF the
 * guardrail layout. `roads.barriers.segments` is walked, everything that is not
 * `kind === 'guard'` is dropped on the floor, and every spectator in the world is
 * a child of one surviving bay — standing on the far side of it, facing back
 * across it at the road.
 *
 * WHY THERE IS NOBODY ON THE BRIDGES. bridges.js publishes its parapets as rails
 * with `kind: 'guard'` too, and a real rally does put a crowd on a bridge. This
 * module never sees them: it reads `roads.barriers.segments`, which is the road's
 * own steel, and the composed view game.js assembles for the collision solver is
 * a different object. That is deliberate. Behind a road guardrail there is a
 * verge, a batter and then a hillside; behind a bridge parapet there is nothing
 * at all — the span exists BECAUSE the ground does not, and the only place to
 * stand would be on the water eight to thirty metres below. The approach
 * guardrails at either end of a span ARE road segments and DO carry a crowd,
 * which is where those people would really be: on the abutment, not over the
 * river.
 *
 * WHERE THE DENSITY GOES. Guardrails already mark the dangerous corners — that
 * is the rule roads.js rations them by — so the crowd only has to follow the
 * steel to be in the right places. But it should not be a hedge of equal depth
 * for 1.3 km either, so each bay is weighted by the curvature of its own run and
 * the tight ones grow big knots while the straights get ones and twos.
 *
 * COST. One InstancedMesh, one material, one shared time uniform. Everything
 * that moves — the idle weight shift, the arms, the flags, the reaction as the
 * car goes past — happens in the vertex shader. `update()` writes ONE float
 * uniform and touches the excitement of the handful of instances inside the
 * reaction radius; it never rewrites an instance matrix and never allocates.
 */

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;

// Vertex part ids — must match the shader below.
const P_BODY = 0, P_HEAD = 1, P_ARM_P = 2, P_ARM_N = 3, P_ACC = 4;
// Which per-instance colour a vertex wears. 0 = keep the authored colour.
const T_NONE = 0, T_JACKET = 1, T_LOWER = 2, T_FLAG = 3;

// ---------------------------------------------------------------------------
// GPU pose. Injected into the lit material AND the depth material, so the
// silhouette and the shadow it casts move together. One uniform drives all of
// it; everything else is per-instance and written once at build time, except
// `aExcite`, which is the car's wake through the crowd.
// ---------------------------------------------------------------------------

const POSE_PREAMBLE = /* glsl */ `
attribute float aPart;
attribute vec3  aPivot;
attribute vec4  aSpec;     // x phase, y sway, z arm rest angle, w accessory
attribute float aExcite;
uniform float uCrowdT;

vec3 dcRotX(vec3 p, vec3 pv, float a) {
  vec3 d = p - pv;
  float c = cos(a), s = sin(a);
  return pv + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
}
vec3 dcRotZ(vec3 p, vec3 pv, float a) {
  vec3 d = p - pv;
  float c = cos(a), s = sin(a);
  return pv + vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}
`;

const POSE_BODY = /* glsl */ `
  vec3 transformed = vec3( position );
  float dcPh = aSpec.x;      // personal phase — nobody sways on the same beat
  float dcSw = aSpec.y;      // how twitchy this one is at rest
  float dcEx = aExcite;      // 0 at rest, ~1 as the car goes past
  float dcT  = uCrowdT;

  if (aPart > 1.5 && aPart < 3.5) {
    // ARMS. Each swings about its own shoulder. At rest they hang with a little
    // fore-and-aft drift; excitement rotates them out and up and adds the wave,
    // which is the single thing that reads as a crowd rather than a fence of
    // people at fifteen pixels tall.
    float sd = (aPart < 2.5) ? 1.0 : -1.0;
    float rest = aSpec.z;
    float wave = 0.72 + 0.28 * sin(dcT * 8.5 + dcPh * 2.3 + sd);
    float raise = rest + dcEx * (2.35 - rest) * wave;
    transformed = dcRotX(transformed, aPivot, sin(dcT * 1.15 + dcPh) * (0.05 + dcSw * 0.7));
    transformed = dcRotZ(transformed, aPivot, sd * raise);
  } else if (aPart > 0.5 && aPart < 1.5) {
    // HEAD. Drifts along the road at rest, tips back when the car arrives.
    transformed = dcRotX(transformed, aPivot, sin(dcT * 0.83 + dcPh * 1.7) * 0.07 - dcEx * 0.15);
    transformed = dcRotZ(transformed, aPivot, sin(dcT * 0.61 + dcPh) * 0.09);
  } else if (aPart > 3.5) {
    // FLAG. Most people are not carrying one, and for those the whole accessory
    // collapses onto its own pivot: zero-area triangles, no second geometry, no
    // second draw call, nothing on screen.
    if (aSpec.w < 0.5) {
      transformed = aPivot;
    } else {
      float h = position.y - aPivot.y;
      transformed.x += sin(dcT * 2.9 + dcPh * 3.1) * (0.05 + dcEx * 0.10) * h;
      transformed.z += sin(dcT * 2.1 + dcPh * 1.9 + 1.1) * (0.035 + dcEx * 0.08) * h;
      transformed.y += dcEx * 0.14;
    }
  }

  // WHOLE BODY. A slow weight shift about the feet — a rotation, never a
  // translation, so the soles stay welded to the ground they were placed on —
  // plus a hop that only exists while the car is going past.
  float dcLean = sin(dcT * (0.62 + dcSw * 3.0) + dcPh) * (0.026 + dcSw * 0.30 + dcEx * 0.055);
  transformed = dcRotZ(transformed, vec3(0.0), dcLean);
  transformed = dcRotX(transformed, vec3(0.0), sin(dcT * 0.47 + dcPh * 2.7) * (0.016 + dcSw * 0.14));
  transformed.y += max(0.0, sin(dcT * 6.6 + dcPh)) * dcEx * 0.15;
`;

// Clothing. The instance carries three colours and each vertex says which of
// them it wears; the skin, the shoes and the flag pole keep what they were
// authored with. Done this way rather than through `instanceColor`, because that
// multiplies the WHOLE instance and a red anorak would give its owner a red face.
const COLOUR_PREAMBLE = /* glsl */ `
attribute float aTint;
attribute vec3  aJacket;
attribute vec3  aLower;
attribute vec3  aFlagC;
`;

const COLOUR_BODY = /* glsl */ `
  #include <color_vertex>
  if (aTint > 2.5)      vColor.rgb = aFlagC;
  else if (aTint > 1.5) vColor.rgb = aLower;
  else if (aTint > 0.5) vColor.rgb = aJacket;
`;

// ---------------------------------------------------------------------------
// Geometry kit.
//
// The whole budget of this feature is spent here, so every face is counted. A
// spectator is 50 triangles: 10 for the legs, 10 for the jacket, 8 for the head,
// 6 per arm and 10 for the flag that one in twelve of them is carrying. Boxes
// have no bottom face (it is on the ground) and the limbs are open triangular
// prisms (they are a pixel wide on screen). Authored facing +Z with the feet on
// y = 0, so an instance matrix is a yaw and a scale.
//
// WINDING. Front faces are counter-clockwise. Every builder below was checked by
// taking the cross product of a real face rather than by looking at it, because
// a back-facing spectator is invisible and invisible is indistinguishable from
// "the placement is wrong".
// ---------------------------------------------------------------------------

class Mesher {
  constructor() {
    this.pos = []; this.col = []; this.part = []; this.piv = []; this.tint = [];
  }
  tri(a, b, c, part, pivot, col, tint) {
    const vs = [a, b, c];
    for (let i = 0; i < 3; i++) {
      const v = vs[i];
      this.pos.push(v[0], v[1], v[2]);
      this.col.push(col.r, col.g, col.b);
      this.part.push(part);
      this.piv.push(pivot[0], pivot[1], pivot[2]);
      this.tint.push(tint);
    }
  }
  quad(a, b, c, d, part, pivot, col, tint) {
    this.tri(a, b, c, part, pivot, col, tint);
    this.tri(a, c, d, part, pivot, col, tint);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(this.part), 1));
    g.setAttribute('aPivot', new THREE.BufferAttribute(new Float32Array(this.piv), 3));
    g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(this.tint), 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** Corners of a rectangle at height y, in the order the side quads expect. */
function corners(hw, hd, y, cx, cz) {
  return [
    [cx + hw, y, cz + hd], [cx - hw, y, cz + hd],
    [cx - hw, y, cz - hd], [cx + hw, y, cz - hd],
  ];
}

/** Tapered box with no bottom face: 4 sides + a cap = 10 triangles. */
function frustum(m, cx, cy, cz, wb, db, wt, dt, h, part, pivot, col, tint) {
  const b = corners(wb * 0.5, db * 0.5, cy, cx, cz);
  const t = corners(wt * 0.5, dt * 0.5, cy + h, cx, cz);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    m.quad(b[i], t[i], t[j], b[j], part, pivot, col, tint);
  }
  m.quad(t[0], t[3], t[2], t[1], part, pivot, col, tint);
}

/** Open triangular prism between two points: 3 quads = 6 triangles. */
function limb(m, x0, y0, z0, x1, y1, z1, r, part, pivot, col, tint) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // Any vector not parallel to the axis seeds the section frame; a limb is a
  // triangle in section and nobody is counting its facets from 78 m up.
  let ax = 0, ay = 0, az = 1;
  if (Math.abs(uz) > 0.9) { ax = 1; ay = 0; az = 0; }
  let px = uy * az - uz * ay, py = uz * ax - ux * az, pz = ux * ay - uy * ax;
  const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
  const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
  const at = (x, y, z, i) => {
    const t = (i / 3) * TAU;
    const c = Math.cos(t) * r, s = Math.sin(t) * r;
    return [x + px * c + qx * s, y + py * c + qy * s, z + pz * c + qz * s];
  };
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    m.quad(at(x0, y0, z0, j), at(x1, y1, z1, j), at(x1, y1, z1, i), at(x0, y0, z0, i),
      part, pivot, col, tint);
  }
}

/** Octahedron — 8 triangles, the cheapest solid that is not a box. */
function octa(m, cx, cy, cz, rx, ry, rz, part, pivot, col, tint) {
  const px = [rx, 0, 0], nx = [-rx, 0, 0];
  const py = [0, ry, 0], ny = [0, -ry, 0];
  const pz = [0, 0, rz], nz = [0, 0, -rz];
  const at = (p) => [p[0] + cx, p[1] + cy, p[2] + cz];
  const f = (a, b, c) => m.tri(at(a), at(b), at(c), part, pivot, col, tint);
  f(py, pz, px); f(py, px, nz); f(py, nz, nx); f(py, nx, pz);
  f(ny, px, pz); f(ny, nz, px); f(ny, nx, nz); f(ny, pz, nx);
}

/** Flat panel, both faces: 4 triangles. */
function panel(m, a, b, c, d, part, pivot, col, tint) {
  m.quad(a, b, c, d, part, pivot, col, tint);
  m.quad(d, c, b, a, part, pivot, col, tint);
}

const HIP = 0.80;          // top of the legs
const SHOULDER = 1.40;     // top of the jacket, and where the arms hang from
const HEAD_Y = 1.52;
/** Furthest any vertex of any pose reaches from the model's own axis, in x. */
const MODEL_REACH = 0.79;

/** The one model in the module. 50 triangles. */
function buildSpectator(C) {
  const m = new Mesher();
  const NECK = [0, 1.38, 0];

  // legs — one block, because two 0.15 m legs are a third of a pixel apart
  frustum(m, 0, 0, 0, 0.38, 0.27, 0.34, 0.24, HIP, P_BODY, [0, 0, 0], C.base, T_LOWER);
  // jacket — wider at the shoulder than at the waist, which is the silhouette
  frustum(m, 0, HIP - 0.02, 0, 0.36, 0.26, 0.47, 0.30, SHOULDER - HIP + 0.02,
    P_BODY, [0, 0, 0], C.base, T_JACKET);
  // head
  octa(m, 0, HEAD_Y, 0, 0.115, 0.150, 0.115, P_HEAD, NECK, C.skin, T_NONE);

  // arms
  for (const sd of [1, -1]) {
    const sx = sd * 0.235;
    const piv = [sx, SHOULDER - 0.05, 0];
    limb(m, sx, SHOULDER - 0.05, 0.01, sx, SHOULDER - 0.53, 0.03, 0.058,
      sd > 0 ? P_ARM_P : P_ARM_N, piv, C.base, T_JACKET);
  }

  // flag — collapsed by the shader for everyone not carrying one
  const pv = [0.24, 1.02, 0.06];
  limb(m, 0.24, 1.02, 0.06, 0.30, 2.24, -0.16, 0.028, P_ACC, pv, C.pole, T_NONE);
  // The cloth is tipped well off vertical on purpose: the game camera looks down
  // at 52 degrees and a flag hanging straight down presents its edge to it.
  panel(m,
    [0.30, 2.22, -0.16], [0.34, 2.26, -0.62], [0.79, 2.02, -0.58], [0.74, 1.98, -0.12],
    P_ACC, pv, C.base, T_FLAG);

  return m.build();
}

// ---------------------------------------------------------------------------
// Colour. Nothing is invented here: every value is an HSL offset from a Palette
// slot, exactly as in entities/animals.js.
//
// The chromatic coats are the palette's own first accent — the slot the art
// direction reserves for "signage / flowers / manmade pops" — walked right round
// the hue wheel, because a crowd's whole job at this distance is to be a band of
// different colours and four accents repeated is a band of one.
//
// THE FIRST VERSION OF THIS WAS A WALL OF PINK WITH BLACK LEGS, and both halves
// of that were one mistake. `Color.offsetHSL` works in the WORKING colour space,
// which is linear: alpine's `trunk` is 0x6b4a30, lightness 0.30 as authored and
// 0.075 once linearised, so the -0.10 that was meant to darken it into denim
// clamped it to zero and six hundred spectators got legs made of shadow. And
// flooring the saturation of the white accent turned a third of the wardrobe
// into random hues. So every offset below is taken in sRGB, where 0.30 means
// what it looks like, and a third of the coats are deliberately achromatic —
// white, charcoal and grey are what make the coloured ones read as coloured.
// ---------------------------------------------------------------------------
const SRGB = THREE.SRGBColorSpace;
const _hsl = { h: 0, s: 0, l: 0 };

/** HSL offset from a palette hex, taken in sRGB. Absolute s/l where given. */
function shift(hex, dh, s, l) {
  const c = new THREE.Color(hex);
  c.getHSL(_hsl, SRGB);
  c.setHSL(
    (_hsl.h + dh + 1) % 1,
    s === null ? _hsl.s : clamp(s, 0, 1),
    l === null ? _hsl.l : clamp(l, 0, 1),
    SRGB
  );
  return c;
}

function wardrobe(palette) {
  const acc = palette.accents ?? [0xffffff];
  const jackets = [];
  // Nine anoraks, one every forty degrees round the wheel from the palette's own
  // signage hue. Saturation stays under the car's (0xef4d4d, s = 0.83): ART
  // DIRECTION says the car is the most saturated thing in frame, and there are
  // six hundred of these.
  for (let i = 0; i < 9; i++) {
    jackets.push(shift(acc[0], i / 9, 0.55 + (i % 3) * 0.10, 0.44 + ((i % 4) - 1.5) * 0.070));
  }
  jackets.push(shift(palette.terrain?.summit ?? 0xffffff, 0, 0.06, 0.88));
  jackets.push(shift(palette.rockShadow ?? palette.trunk ?? 0x6b5a44, 0, 0.10, 0.24));
  jackets.push(shift(palette.rock ?? palette.trunk ?? 0x6b5a44, 0, 0.09, 0.50));

  // Trousers: three off the trunk (canvas and cord) and two off the rock (denim
  // and grey). Dark enough to sit under the coat, never black.
  const lowers = [
    shift(palette.trunk ?? 0x6b5a44, 0, 0.26, 0.30),
    shift(palette.trunk ?? 0x6b5a44, 0.02, 0.16, 0.38),
    shift(palette.trunk ?? 0x6b5a44, -0.02, 0.30, 0.24),
    shift(palette.rock ?? 0x7a7164, 0.02, 0.22, 0.33),
    shift(palette.rock ?? 0x7a7164, 0, 0.08, 0.42),
  ];

  return {
    jackets, lowers,
    // Authored colour of anything the instance is going to repaint. White, so a
    // failed tint shows up as a white spectator rather than as nothing at all.
    base: new THREE.Color(0xffffff),
    skin: shift(palette.trunk ?? 0x6b5a44, 0.01, 0.34, 0.66),
    pole: shift(palette.trunk ?? 0x6b5a44, 0, 0.12, 0.46),
  };
}

// ---------------------------------------------------------------------------
// Placement constants
// ---------------------------------------------------------------------------

// Metres outboard of the guardrail's own post line. roads.js puts that line at
// `hw + verge + G_OFFSET (1.35)` and the post is 0.20 m thick, so the nearest a
// spectator's centre ever gets to steel is 1.20 m of clear air. Nothing on the
// model reaches that far sideways except a raised arm (0.68 m) or the flag
// (0.79 m), and both of those swing ALONG the rail rather than across it: the
// model faces the road, so its local x is the direction of travel.
const BACK_MIN = 1.40;
const BACK_MAX = 4.2;
const BACK_FLAG = 1.95;      // flag carriers stand a row further back
const PERSONAL = 0.62;       // closest two spectators ever stand, centre to centre
const MAX_SLOPE = 0.44;      // ~24 deg. Steeper and a rigid upright model leans out of it.
const MAX_BANK = 3.0;        // metres the ground may fall below the rail's own foot
const PROP_CLEAR = 0.55;     // added to a prop collider's radius
const CAP = 700;             // hard ceiling on population — see the triangle budget

// The car's wake.
const EXCITE_R = 34;
const EXCITE_R2 = EXCITE_R * EXCITE_R;
const GRID_CELL = 36;        // >= EXCITE_R, so a 3x3 block of cells always suffices

export function createCrowd(ctx) {
  const group = new THREE.Group();
  group.name = 'crowd';

  const { terrain, biome, palette } = ctx;
  const roads = ctx.roads ?? null;
  const water = ctx.water ?? null;
  const seed = (ctx.seed ?? 1337) | 0;
  const rng = new Rng((seed * 7717 + 991) >>> 0);
  const C = wardrobe(palette);

  const half = (biome.size ?? 2000) / 2 - 12;
  const biomeWater = biome.waterLevel ?? -1e4;

  // -------------------------------------------------------------------------
  // THE GROUND A SPECTATOR STANDS ON — and it is the hillside, not the road.
  //
  // buildBarriers puts its posts on `footGround`, the higher of the road's own
  // drawn cross-section and the drawn terrain, because a guardrail post stands
  // on the shoulder by construction. A spectator does not: they are 1.4 m
  // further out again, and the two queries are only reconcilable to a centimetre
  // in the middle of a surface, not at its edge.
  //
  // MEASURED, using the same raycast auditBarrierFeet uses. Placing them on
  // max(road, terrain) left the worst spectator 0.146 m in the air at (360, 140)
  // — the road query answering 38.18 for a sliver of ribbon at the very lip of
  // its own footprint, with the only triangle under them being terrain at 38.04.
  // Requiring the road to answer under the whole sole moved the defect rather
  // than fixing it: the same neighbourhood then buried one 0.156 m, because
  // there the ribbon IS drawn and the query declines. That boundary is ragged in
  // both directions and no threshold across it is going to be right.
  //
  // So the crowd simply stays off it. `terrain.drawnHeightAt` is not an estimate
  // — it returns the plane of the exact triangle that is on screen — and a
  // spectator standing on the hillside behind the steel is where a spectator
  // actually stands. The road's batter is loose fill on a 1:2 slope; nobody
  // watches a rally from one.
  //
  // ...AND "OFF IT" IS ANSWERED BY THE TRIANGLES, NOT BY THE QUERY.
  //
  // `roads.heightAt` finds the NEAREST station and asks that one station whether
  // its section reaches. At a hairpin or a spur junction the nearest station is
  // not the one whose ribbon is overhead, so the query returns null over drawn
  // road: measured on winter_pass at (112, 2), heightAt null, outerEdgeAt 8.16,
  // and the raycast finding road at 4.83 over terrain at 4.38. Ten spectators
  // stood buried up to 0.51 m in a road nobody could ask about.
  //
  // So the road's own footprint is rasterised ONCE, straight off the geometry it
  // draws, into a one-metre occupancy grid. It cannot miss a spur, it costs a
  // single pass over the ribbon vertices at build time (20 ms of an 8 s world),
  // and it answers in O(1).
  // -------------------------------------------------------------------------
  //
  // THE SETTLED LAYOUT, NOT THE EAGER ONE — and it has to come first, because
  // resettling rebuilds the barriers and re-sinks the ribbon under the bridge
  // decks, and the mask should be taken of the geometry that is finally drawn.
  //
  // roads.js builds its barriers before water.js has dug the tarns and before
  // bridges.js exists, then rebuilds the whole layout once on the first tick if
  // the ground moved or a deck appeared. Reading `segments` without that rebuild
  // would grow the crowd against a guardrail plan that is about to be thrown
  // away: nobody at any bridge approach, and knots standing beside steel that
  // has since gone back to being timber. `barriers.update` runs the resettle, is
  // idempotent, and game.js calls it every frame anyway.
  try { roads?.barriers?.update?.(0); } catch { /* the eager layout beats none */ }

  const CELL_M = 1.0;
  const gHalf = (biome.size ?? 2000) / 2 + 12;
  const gN = Math.ceil((gHalf * 2) / CELL_M);
  const roadMask = new Uint8Array(gN * gN);
  {
    const mark = (x0, z0, x1, z1, x2, z2) => {
      let i0 = Math.floor((Math.min(x0, x1, x2) + gHalf) / CELL_M);
      let i1 = Math.floor((Math.max(x0, x1, x2) + gHalf) / CELL_M);
      let j0 = Math.floor((Math.min(z0, z1, z2) + gHalf) / CELL_M);
      let j1 = Math.floor((Math.max(z0, z1, z2) + gHalf) / CELL_M);
      if (i1 < 0 || j1 < 0 || i0 >= gN || j0 >= gN) return;
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 >= gN) i1 = gN - 1;
      if (j1 >= gN) j1 = gN - 1;
      // A triangle the size of a field is a degenerate one; marking its box
      // would blank out a quarter of the map.
      if (i1 - i0 > 64 || j1 - j0 > 64) return;
      for (let j = j0; j <= j1; j++) {
        const row = j * gN;
        for (let i = i0; i <= i1; i++) roadMask[row + i] = 1;
      }
    };
    try {
      roads?.group?.updateMatrixWorld?.(true);
      roads?.group?.traverse?.((o) => {
        if (!o.isMesh || !o.geometry) return;
        // The barriers and their debris are not ground; a spectator standing
        // beside a post must not be refused because the post is drawn there.
        if (/barrier|debris/.test(o.name || '')) return;
        const a = o.geometry.attributes?.position;
        if (!a) return;
        const e = o.matrixWorld.elements;
        const arr = a.array;
        const idx = o.geometry.index ? o.geometry.index.array : null;
        const n = idx ? idx.length : a.count;
        const P = [0, 0, 0, 0, 0, 0];
        for (let t = 0; t + 2 < n; t += 3) {
          for (let k = 0; k < 3; k++) {
            const vi = (idx ? idx[t + k] : t + k) * 3;
            const x = arr[vi], y = arr[vi + 1], z = arr[vi + 2];
            P[k * 2] = e[0] * x + e[4] * y + e[8] * z + e[12];
            P[k * 2 + 1] = e[2] * x + e[6] * y + e[10] * z + e[14];
          }
          mark(P[0], P[1], P[2], P[3], P[4], P[5]);
        }
      });
    } catch { /* no mask is better than no crowd */ }
  }
  /** True if any part of a spectator's stance would land on roads.js's own mesh. */
  const onEarthworks = (x, z) => {
    const i = Math.floor((x + gHalf) / CELL_M);
    const j = Math.floor((z + gHalf) / CELL_M);
    if (i < 0 || j < 0 || i >= gN || j >= gN) return false;
    // ONE cell, not a dilated block. Marking each triangle's bounding box
    // already over-covers by up to a cell, and a ribbon triangle is 3 m long, so
    // the mask is generous before any dilation: testing the 3x3 neighbourhood on
    // top of that added two to three metres of exclusion and cut the alpine
    // crowd from 514 to 94.
    return roadMask[j * gN + i] === 1;
  };
  const groundAt = (x, z) => terrain.drawnHeightAt(x, z);

  const segments = roads?.barriers?.segments ?? [];

  // --- prop lookup ---------------------------------------------------------
  // 13k tree and boulder colliders on an alpine build; a linear scan per
  // candidate would be minutes of build time, so they go in a hash grid once.
  // roads' own furniture — sign posts, the marker boards at the hairpins — is in
  // here too: those stand exactly where the guardrails are.
  const PCELL = 8;
  const propGrid = new Map();
  let propMaxR = 0;
  const addCollider = (c) => {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) return;
    const r = c.r ?? 0.4;
    if (r > propMaxR) propMaxR = r;
    const k = `${Math.floor(c.x / PCELL)},${Math.floor(c.z / PCELL)}`;
    let l = propGrid.get(k);
    if (!l) propGrid.set(k, (l = []));
    l.push(c);
  };
  for (const c of (ctx.props?.colliders ?? [])) addCollider(c);
  for (const c of (roads?.colliders ?? [])) addCollider(c);
  const propReach = Math.max(1, Math.ceil((propMaxR + PROP_CLEAR + 0.6) / PCELL));
  const insideProp = (x, z) => {
    const ci = Math.floor(x / PCELL), cj = Math.floor(z / PCELL);
    for (let u = -propReach; u <= propReach; u++) {
      for (let v = -propReach; v <= propReach; v++) {
        const l = propGrid.get(`${ci + u},${cj + v}`);
        if (!l) continue;
        for (const c of l) {
          const d = (c.r ?? 0.4) + PROP_CLEAR;
          const dx = c.x - x, dz = c.z - z;
          if (dx * dx + dz * dz < d * d) return true;
        }
      }
    }
    return false;
  };

  // --- personal space ------------------------------------------------------
  const SCELL = 1.4;
  const seatGrid = new Map();
  const tooClose = (x, z) => {
    const ci = Math.floor(x / SCELL), cj = Math.floor(z / SCELL);
    for (let u = -1; u <= 1; u++) {
      for (let v = -1; v <= 1; v++) {
        const l = seatGrid.get(`${ci + u},${cj + v}`);
        if (!l) continue;
        for (const p of l) {
          const dx = p[0] - x, dz = p[1] - z;
          if (dx * dx + dz * dz < PERSONAL * PERSONAL) return true;
        }
      }
    }
    return false;
  };
  const claim = (x, z) => {
    const k = `${Math.floor(x / SCELL)},${Math.floor(z / SCELL)}`;
    let l = seatGrid.get(k);
    if (!l) seatGrid.set(k, (l = []));
    l.push([x, z]);
  };

  const blocked = (x, z) => {
    try { if (ctx.landmarks?.isBlocked?.(x, z)) return true; } catch { /* ignore */ }
    try { if (ctx.bridges?.isBlocked?.(x, z)) return true; } catch { /* ignore */ }
    try { if (ctx.jump?.isBlocked?.(x, z)) return true; } catch { /* ignore */ }
    return false;
  };
  // The carriageway itself, verge included, over the WHOLE network — a spur can
  // pass behind a guardrail, and a crowd standing in it is a crowd on a road.
  const onCarriageway = (x, z) => {
    try { return roads?.surfaceAt?.(x, z) != null; } catch { return false; }
  };
  /**
   * WATER, ASKED OF A SOURCE THAT HAS AN ANSWER YET.
   *
   * `water.level` is documented in water.js as a PLACEHOLDER until
   * `_ensureSurface` has resolved the plan, which does not happen until the
   * lattice is built — after this module runs. Asking `water.contains` here got
   * the placeholder, and on any load after the first that placeholder was the
   * PREVIOUS world's tarn level, because lake.js keeps its context in a
   * module-level variable keyed only by biome id. Measured on lake_bridge: 2251
   * candidates refused for standing in a lake thirty metres above them that
   * belonged to a world which no longer existed, and the crowd fell from 391 to
   * 159 on the second `loadBiome` of the same seed. A build that is not the same
   * twice is worse than one that is slightly wrong.
   *
   * So the test is the biome's own plane — a constant — and it is enough,
   * because buildBarriers has already walked every guardrail post inward until
   * it stands clear of water, and nobody here is more than 4.2 m behind a post
   * or 3 m below its foot. tools/crowd-test.mjs checks the tarns directly once
   * they are resolved.
   */
  const wet = (x, z, y) => {
    if (y < biomeWater + 0.6) return true;
    if (water && water.plan) {
      try { if (water.contains(x, z, y + 0.6)) return true; } catch { /* ignore */ }
    }
    return false;
  };

  // -------------------------------------------------------------------------
  // 1. The guardrail, as runs rather than as a bag of bays.
  //
  // A bay's own direction says nothing about how hard the corner is; the change
  // in direction across a few bays says everything. roads.js emits the bays of
  // one side of one route in id order, so a run is a maximal chain of guard
  // segments with consecutive ids whose ends actually meet.
  // -------------------------------------------------------------------------
  const guards = segments.filter((s) => s.kind === 'guard').sort((a, b) => a.id - b.id);
  const runs = [];
  {
    let cur = null;
    for (const s of guards) {
      const prev = cur && cur[cur.length - 1];
      const joins = prev && s.id === prev.id + 1
        && Math.hypot(s.x - prev.x, s.z - prev.z) < 8.6;
      if (!joins) { cur = []; runs.push(cur); }
      cur.push(s);
    }
  }

  /** Corner radius at bay `j` of `run`, measured over the run's own bend. */
  const radiusAt = (run, j) => {
    const n = run.length;
    if (n < 3) return 1e4;
    const a = run[Math.max(0, j - 2)], b = run[Math.min(n - 1, j + 2)];
    if (a === b) return 1e4;
    const ang = Math.acos(clamp(a.dx * b.dx + a.dz * b.dz, -1, 1));
    const arc = Math.hypot(b.x - a.x, b.z - a.z);
    if (ang < 1e-4 || arc < 1e-3) return 1e4;
    return arc / ang;
  };

  // -------------------------------------------------------------------------
  // 2. Which way is AWAY from the road.
  //
  // roads.js publishes one unit normal per bay and it is authoritative. The
  // fallback exists so this module can never silently seat a crowd on the
  // carriageway if that field stops being written: take the perpendicular, and
  // keep whichever of the two sides is not road.
  // -------------------------------------------------------------------------
  const _n = [0, 0];
  const outward = (s) => {
    if (Number.isFinite(s.nx) && Number.isFinite(s.nz) && (s.nx !== 0 || s.nz !== 0)) {
      _n[0] = s.nx; _n[1] = s.nz;
      return _n;
    }
    const px = -s.dz, pz = s.dx;
    const a = onCarriageway(s.x + px * 3.2, s.z + pz * 3.2);
    const b = onCarriageway(s.x - px * 3.2, s.z - pz * 3.2);
    const sign = a && !b ? -1 : 1;
    _n[0] = px * sign; _n[1] = pz * sign;
    return _n;
  };

  // -------------------------------------------------------------------------
  // 3. Grow the crowd.
  // -------------------------------------------------------------------------
  const people = [];

  // Why candidates were turned away. Density arguments are unwinnable without
  // it — see the same reasoning above `this.counts` in world/props.js.
  const rejects = {
    edge: 0, road: 0, earthworks: 0, wet: 0, bank: 0, slope: 0, blocked: 0, prop: 0, crowd: 0,
  };

  /** Everything that can stop a spectator standing here. Returns the foot height. */
  const siteOk = (x, z, railY) => {
    if (Math.abs(x) > half || Math.abs(z) > half) { rejects.edge++; return null; }
    if (onCarriageway(x, z)) { rejects.road++; return null; }
    if (onEarthworks(x, z)) { rejects.earthworks++; return null; }
    const y = groundAt(x, z);
    if (!Number.isFinite(y)) { rejects.edge++; return null; }
    if (wet(x, z, y)) { rejects.wet++; return null; }
    // The bank behind a guardrail is exactly where the ground runs out — that is
    // what the guardrail is there for. Somebody three metres down it is not a
    // spectator, they are a falling object.
    if (railY - y > MAX_BANK) { rejects.bank++; return null; }
    // Slope over the footprint, on the DRAWN surface. A person on a 30 degree
    // face leans out of the hill, because the model is rigid and upright.
    const e = 0.55;
    const hx = groundAt(x + e, z) - groundAt(x - e, z);
    const hz = groundAt(x, z + e) - groundAt(x, z - e);
    if (Math.hypot(hx, hz) / (2 * e) > MAX_SLOPE) { rejects.slope++; return null; }
    if (blocked(x, z)) { rejects.blocked++; return null; }
    if (insideProp(x, z)) { rejects.prop++; return null; }
    if (tooClose(x, z)) { rejects.crowd++; return null; }
    return y;
  };

  const addPerson = (x, y, z, yaw, kid, wantFlag) => {
    people.push({
      x, y, z, yaw,
      scale: kid ? rng.float(0.68, 0.82) : rng.float(0.93, 1.08),
      phase: rng.float(0, TAU),
      sway: rng.float(0.012, 0.115),
      // One in five already has their arms up. A crowd is never all in one pose,
      // and the raised ones are what break the row-of-posts read. Never near
      // pi/2, which is a T-pose and reads as a scarecrow rather than a cheer.
      arm: rng.bool(0.20) ? rng.float(1.95, 2.45) : rng.float(0.07, 0.26),
      acc: wantFlag ? 1 : 0,
      jacket: C.jackets[rng.int(0, C.jackets.length - 1)],
      lower: C.lowers[rng.int(0, C.lowers.length - 1)],
      flag: C.jackets[rng.int(0, C.jackets.length - 1)],
    });
    claim(x, z);
  };

  for (const run of runs) {
    for (let j = 0; j < run.length && people.length < CAP; j++) {
      const s = run[j];
      const r = radiusAt(run, j);
      // Heat: 1 at a 48 m hairpin, a third of that on a 150 m sweep, a tenth on a
      // straight run of steel guarding a long drop. Guardrails are already
      // rationed to the dangerous places; this only decides how DEEP the crowd
      // gets once it is there.
      const heat = clamp(48 / Math.max(r, 26), 0.10, 1.55);
      if (!rng.bool(clamp(0.20 + heat * 0.60, 0.12, 0.85))) continue;

      // Knot size. Ones and twos most of the time; a real gallery only where the
      // corner has earned it.
      let want = 1 + Math.floor(Math.pow(rng.float(0, 1), 1.6) * (2.8 + heat * 17));
      if (want > 24) want = 24;

      let placed = 0, tries = 0;
      while (placed < want && tries < want * 9 && people.length < CAP) {
        tries++;
        const flagBearer = placed > 0 && rng.bool(0.085);
        // A KNOT SPREADS ALONG THE STEEL, NOT ALONG A TANGENT.
        //
        // The spread used to be a gaussian in metres off this bay's centre, and
        // a fourteen-strong knot at the end of a run then threw stragglers ten
        // metres past the last post — people standing in open meadow, which is
        // the one thing the client asked for by name. Spreading over the run's
        // own BAYS instead keeps every member inside some bay's frontage, so the
        // distance from any spectator to the nearest guardrail is exactly their
        // set-back and nothing else; it also follows the corner round rather
        // than running off the tangent of one bay.
        const bi = clamp(j + Math.round(rng.gauss(0, 0.55 + want * 0.14)),
          0, run.length - 1);
        const sb = run[bi];
        const n = outward(sb);
        const nx = n[0], nz = n[1];
        const along = rng.float(-sb.half, sb.half);
        const floor = flagBearer ? BACK_FLAG : BACK_MIN;
        const back = clamp(floor + Math.abs(rng.gauss(0, 0.85)), floor, BACK_MAX);
        const x = sb.x + sb.dx * along + nx * back;
        const z = sb.z + sb.dz * along + nz * back;
        const y = siteOk(x, z, groundAt(sb.x, sb.z));
        if (y == null) continue;
        // The front rank watches the road; the ones behind turn to each other as
        // often as not.
        const turn = clamp(rng.gauss(0, back < 2.2 ? 0.30 : 0.85), -1.5, 1.5);
        addPerson(x, y, z, Math.atan2(-nx, -nz) + turn, rng.bool(0.07), flagBearer);
        placed++;
      }
    }
  }

  const count = people.length;

  // -------------------------------------------------------------------------
  // 4. Bake. One InstancedMesh, one material, one depth material.
  // -------------------------------------------------------------------------
  const timeU = { value: 0 };

  const injectPose = (shader) => {
    shader.uniforms.uCrowdT = timeU;
    shader.vertexShader = POSE_PREAMBLE
      + shader.vertexShader.replace('#include <begin_vertex>', POSE_BODY);
  };
  const injectAll = (shader) => {
    injectPose(shader);
    shader.vertexShader = COLOUR_PREAMBLE
      + shader.vertexShader.replace('#include <color_vertex>', COLOUR_BODY);
  };

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  material.onBeforeCompile = injectAll;
  material.customProgramCacheKey = () => 'driftlands-crowd';

  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = injectPose;
  depthMaterial.customProgramCacheKey = () => 'driftlands-crowd-depth';

  const geo = buildSpectator(C);
  const triPer = geo.attributes.position.count / 3;

  // Flat position arrays. `update` must not walk an array of objects, and it
  // must certainly not build one.
  const pxArr = new Float32Array(Math.max(1, count));
  const pzArr = new Float32Array(Math.max(1, count));
  for (let i = 0; i < count; i++) { pxArr[i] = people[i].x; pzArr[i] = people[i].z; }

  let mesh = null;
  let excite = null, exciteAttr = null;
  let cellStart = null, cellItems = null;
  let gx0 = 0, gz0 = 0, gw = 0, gh = 0;
  let active = null, isActive = null, activeCount = 0;
  const range = { start: 0, count: 0 };

  if (count > 0) {
    const spec = new Float32Array(count * 4);
    const jacket = new Float32Array(count * 3);
    const lower = new Float32Array(count * 3);
    const flagc = new Float32Array(count * 3);
    excite = new Float32Array(count);

    geo.setAttribute('aSpec', new THREE.InstancedBufferAttribute(spec, 4));
    geo.setAttribute('aJacket', new THREE.InstancedBufferAttribute(jacket, 3));
    geo.setAttribute('aLower', new THREE.InstancedBufferAttribute(lower, 3));
    geo.setAttribute('aFlagC', new THREE.InstancedBufferAttribute(flagc, 3));
    exciteAttr = new THREE.InstancedBufferAttribute(excite, 1);
    exciteAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aExcite', exciteAttr);

    mesh = new THREE.InstancedMesh(geo, material, count);
    mesh.name = 'crowd:spectators';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    /**
     * AND KEEP THE SHADOW. renderer.js rations the shadow map by demoting any
     * instanced scatter with 300+ copies whose instances are under 2 m — the
     * rule that keeps 25,951 daisies out of the depth pass, where each of them
     * would be smaller than one shadow texel and the contact AO in post.js is
     * the better likeness anyway.
     *
     * A crowd trips that rule by arithmetic (561 > 300, and a spectator's
     * bounding radius is 1.27 m) while being the opposite case. A standing
     * figure at this camera casts a readable couple of metres of shadow, and it
     * stands beside guardrail posts, saplings and firs that all cast theirs.
     * A/B'd at 4x on the crowd_alpine preset: without it the gallery sits ON
     * the grass instead of IN it — flat colour on flat green, no contact. The
     * whole crowd is 28,050 triangles, which is 0.5% of a frame.
     */
    mesh.userData.mustCast = true;
    mesh.frustumCulled = false;
    mesh.customDepthMaterial = depthMaterial;

    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const p = people[i];
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yaw, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      spec[i * 4] = p.phase;
      spec[i * 4 + 1] = p.sway;
      spec[i * 4 + 2] = p.arm;
      spec[i * 4 + 3] = p.acc;
      jacket[i * 3] = p.jacket.r; jacket[i * 3 + 1] = p.jacket.g; jacket[i * 3 + 2] = p.jacket.b;
      lower[i * 3] = p.lower.r; lower[i * 3 + 1] = p.lower.g; lower[i * 3 + 2] = p.lower.b;
      flagc[i * 3] = p.flag.r; flagc[i * 3 + 1] = p.flag.g; flagc[i * 3 + 2] = p.flag.b;
    }
    // Written once, uploaded once, never touched again. Rewriting these every
    // frame is the exact cost a crowd must not have.
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);

    // --- the lookup update() uses ------------------------------------------
    // A flat CSR grid, so "who is near the car" is nine index ranges rather than
    // a scan of the whole population.
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      if (pxArr[i] < minX) minX = pxArr[i];
      if (pxArr[i] > maxX) maxX = pxArr[i];
      if (pzArr[i] < minZ) minZ = pzArr[i];
      if (pzArr[i] > maxZ) maxZ = pzArr[i];
    }
    gx0 = Math.floor(minX / GRID_CELL) - 1;
    gz0 = Math.floor(minZ / GRID_CELL) - 1;
    gw = Math.floor(maxX / GRID_CELL) - gx0 + 2;
    gh = Math.floor(maxZ / GRID_CELL) - gz0 + 2;
    const cells = gw * gh;
    cellStart = new Int32Array(cells + 1);
    const cellOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      const cx = clamp(Math.floor(pxArr[i] / GRID_CELL) - gx0, 0, gw - 1);
      const cz = clamp(Math.floor(pzArr[i] / GRID_CELL) - gz0, 0, gh - 1);
      const c = cz * gw + cx;
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
    cellItems = new Int32Array(count);
    const fill = new Int32Array(cells);
    for (let i = 0; i < count; i++) {
      const c = cellOf[i];
      cellItems[cellStart[c] + fill[c]++] = i;
    }

    active = new Int32Array(count);
    isActive = new Uint8Array(count);
  }

  // -------------------------------------------------------------------------
  // 5. update(). One float uniform, plus the excitement of whoever the car is
  //    driving past. No allocation, no matrix writes, no Math.random, no wall
  //    clock — `time` is the caller's accumulated simulation dt, so a capture at
  //    t = 9.0 s always shows the same crowd in the same pose.
  // -------------------------------------------------------------------------
  let time = 0;

  function update(dtRaw, player) {
    const dt = Math.min(0.05, Math.max(0, dtRaw || 0));
    time += dt;
    timeU.value = time;
    if (!mesh || dt <= 0) return;

    let lo = count, hi = -1;

    // Decay whoever is still warm. The active list only ever holds people the
    // car has been near, so this is a handful of iterations, not `count`.
    const dec = Math.exp(-dt * 1.35);
    for (let a = activeCount - 1; a >= 0; a--) {
      const i = active[a];
      const e = excite[i] * dec;
      if (e < 0.004) {
        excite[i] = 0;
        isActive[i] = 0;
        active[a] = active[--activeCount];
      } else {
        excite[i] = e;
      }
      if (i < lo) lo = i;
      if (i > hi) hi = i;
    }

    const pos = player && player.position;
    if (pos) {
      // A crowd cheers a car that is COMMITTED, not one trundling past; below
      // walking pace they barely look up.
      const cx0 = pos.x, cz0 = pos.z;
      const heat = 0.30 + 0.70 * clamp(((player.speed ?? 0) - 6) / 17, 0, 1);
      const cx = clamp(Math.floor(cx0 / GRID_CELL) - gx0, 0, gw - 1);
      const cz = clamp(Math.floor(cz0 / GRID_CELL) - gz0, 0, gh - 1);
      for (let v = -1; v <= 1; v++) {
        const zz = cz + v;
        if (zz < 0 || zz >= gh) continue;
        const row = zz * gw;
        for (let u = -1; u <= 1; u++) {
          const xx = cx + u;
          if (xx < 0 || xx >= gw) continue;
          const c = row + xx;
          const e1 = cellStart[c + 1];
          for (let k = cellStart[c]; k < e1; k++) {
            const i = cellItems[k];
            const dx = pxArr[i] - cx0, dz = pzArr[i] - cz0;
            const d2 = dx * dx + dz * dz;
            if (d2 >= EXCITE_R2) continue;
            const target = (1 - d2 / EXCITE_R2) * heat;
            if (target <= excite[i]) continue;
            excite[i] = target;
            if (!isActive[i]) { isActive[i] = 1; active[activeCount++] = i; }
            if (i < lo) lo = i;
            if (i > hi) hi = i;
          }
        }
      }
    }

    if (hi >= lo) {
      // Upload only the span that moved. The renderer empties `updateRanges`
      // once it has consumed it; if it has not — a frame on which the mesh was
      // not drawn — widen the range already queued rather than pushing a second
      // one, because pushing allocates and this must not.
      const rs = exciteAttr.updateRanges;
      if (rs.length === 0) {
        range.start = lo;
        range.count = hi - lo + 1;
        rs.push(range);
      } else {
        const s = range.start < lo ? range.start : lo;
        const e0 = range.start + range.count - 1;
        const e = e0 > hi ? e0 : hi;
        range.start = s;
        range.count = e - s + 1;
      }
      exciteAttr.needsUpdate = true;
    }
  }

  let flags = 0;
  for (let i = 0; i < count; i++) flags += people[i].acc;

  return {
    group,
    update,
    count,
    /** Diagnostics — tools/crowd-test.mjs reads these; the game reads `count`. */
    stats: {
      count,
      guardBays: guards.length,
      runs: runs.length,
      trisPerSpectator: triPer,
      tris: triPer * count,
      flags,
      meshes: mesh ? 1 : 0,
      reach: MODEL_REACH,
      backMin: BACK_MIN,
      backMax: BACK_MAX,
      rejects,
    },
    _people: people,
  };
}
