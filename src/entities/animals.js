import * as THREE from 'three';
import { Rng, fbm } from '../core/rng.js';

/**
 * ANIMALS — owned by the wildlife builder.
 *
 * CONTRACT:
 *   createAnimals(ctx) -> {
 *     group: THREE.Object3D
 *     update(dt, player) -> void        player = {position: Vector3, speed: number}
 *   }
 *
 * ctx = { terrain, biome, palette, seed, roads }
 *
 * Design intent: herds that read as ALIVE from 180 m up. That means motion,
 * flocking, and a startle reaction when the car gets close — silhouette alone
 * is not enough at this camera height.
 *
 * HOW IT WORKS
 * ------------
 * One InstancedMesh per species; every animal of that species is an instance.
 * A whole biome's wildlife is 6-9 draw calls for 400+ animals.
 *
 * The gait runs on the GPU. Each vertex carries a PART id and a PIVOT, and each
 * instance carries a vec4 of animation state (phase, gait amplitude, head
 * pitch, wing/tail angle). The vertex shader rotates each leg about its own
 * hip, the head about the base of the neck, and each wing about its shoulder.
 * Flat shading makes three re-derive normals per fragment, so displaced
 * geometry stays correctly faceted with no normal fix-up. The same injection is
 * applied to a customDepthMaterial, so the SHADOWS animate too — at this camera
 * height the shadow is half of what sells an animal.
 *
 * The CPU only does behaviour: 2D boids per herd (separation / alignment /
 * cohesion / wander / home tether), a four-state machine (GRAZE, ALERT, FLEE,
 * REGROUP), water/cliff/road rejection, and one terrain height query per animal
 * per frame.
 *
 * Colour policy: no fur hexes are invented here. Every animal colour is derived
 * from the biome Palette (trunk, rock, rockShadow, the ground ramp, accents)
 * with an HSL offset, so wildlife is automatically in key with where it lives.
 */

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;

// Vertex part ids — must match the shader below.
const P_BODY = 0, P_HEAD = 1, P_LEG_A = 2, P_LEG_B = 3, P_WING_L = 4, P_WING_R = 5, P_TAIL = 6;

// ---------------------------------------------------------------------------
// GPU gait. Injected into the lit material AND the depth material so animated
// silhouettes and animated shadows stay in lockstep.
// ---------------------------------------------------------------------------

const GAIT_PREAMBLE = /* glsl */ `
attribute float aPart;
attribute vec3 aPivot;
attribute vec4 aAnim;

vec3 dlRotX(vec3 p, vec3 pv, float a) {
  vec3 d = p - pv;
  float c = cos(a), s = sin(a);
  return pv + vec3(d.x, d.y * c - d.z * s, d.y * s + d.z * c);
}
vec3 dlRotZ(vec3 p, vec3 pv, float a) {
  vec3 d = p - pv;
  float c = cos(a), s = sin(a);
  return pv + vec3(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
}
`;

const GAIT_BODY = /* glsl */ `
  vec3 transformed = vec3( position );
  float dlPh   = aAnim.x;   // gait / wingbeat phase
  float dlGait = aAnim.y;   // leg swing amplitude, radians
  float dlHead = aAnim.z;   // head pitch: + is down (grazing)
  float dlWing = aAnim.w;   // wing flap amplitude, or tail angle

  if (aPart > 1.5 && aPart < 3.5) {
    // Legs. Diagonal pairs half a cycle apart — reads as a trot.
    float off = (aPart < 2.5) ? 0.0 : 3.14159265;
    float sw = sin(dlPh + off);
    transformed = dlRotX(transformed, aPivot, sw * dlGait);
    // Lift the hoof on the forward swing so it does not scrape the ground.
    transformed.y += max(0.0, sw) * dlGait * 0.18 * max(0.0, aPivot.y - position.y);
  } else if (aPart > 0.5 && aPart < 1.5) {
    // Head + neck: graze down / alert up, plus a bounce when running.
    transformed = dlRotX(transformed, aPivot, dlHead + sin(dlPh) * dlGait * 0.12);
  } else if (aPart > 3.5 && aPart < 5.5) {
    // Wings, mirrored about the body axis.
    float dir = (aPart < 4.5) ? 1.0 : -1.0;
    float f = sin(dlPh);
    transformed = dlRotZ(transformed, aPivot, f * dlWing * dir);
    // Sweep back a touch on the downstroke.
    transformed.z -= max(0.0, -f) * dlWing * 0.22 * abs(position.x - aPivot.x);
  } else if (aPart > 5.5) {
    transformed = dlRotX(transformed, aPivot, dlWing);
  }

  // Whole-body bounce, twice per stride.
  transformed.y += abs(sin(dlPh)) * dlGait * 0.13;
`;

function injectGait(shader) {
  shader.vertexShader = GAIT_PREAMBLE + shader.vertexShader.replace('#include <begin_vertex>', GAIT_BODY);
}

// ---------------------------------------------------------------------------
// Geometry kit. Everything is faceted and low-poly, authored nose-toward +Z
// with the feet on y = 0, so an instance matrix is just yaw/pitch/roll + scale.
// ---------------------------------------------------------------------------

const ZERO3 = [0, 0, 0];

class Model {
  constructor() { this.chunks = []; }
  add(geo, part = P_BODY, pivot = ZERO3, color) {
    this.chunks.push({ geo, part, pivot, color });
    return this;
  }
  build() {
    let total = 0;
    const flat = [];
    for (const c of this.chunks) {
      const g = c.geo.index ? c.geo.toNonIndexed() : c.geo;
      if (!g.attributes.normal) g.computeVertexNormals();
      total += g.attributes.position.count;
      flat.push({ g, c });
    }
    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    const col = new Float32Array(total * 3);
    const part = new Float32Array(total);
    const piv = new Float32Array(total * 3);
    let o = 0;
    for (const { g, c } of flat) {
      const n = g.attributes.position.count;
      pos.set(g.attributes.position.array.subarray(0, n * 3), o * 3);
      nrm.set(g.attributes.normal.array.subarray(0, n * 3), o * 3);
      for (let i = 0; i < n; i++) {
        const k = (o + i) * 3;
        col[k] = c.color.r; col[k + 1] = c.color.g; col[k + 2] = c.color.b;
        piv[k] = c.pivot[0]; piv[k + 1] = c.pivot[1]; piv[k + 2] = c.pivot[2];
        part[o + i] = c.part;
      }
      o += n;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    geo.setAttribute('aPivot', new THREE.BufferAttribute(piv, 3));
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Tapered n-gon prism along +Z. The workhorse: bodies, necks, muzzles. */
function limb(rFront, rBack, len, seg = 6) {
  const g = new THREE.CylinderGeometry(rFront, rBack, len, seg, 1);
  g.rotateX(Math.PI / 2);
  return g;
}
/** Tapered n-gon prism along +Y. Legs, horns, antler beams. */
function post(rTop, rBot, len, seg = 4) {
  return new THREE.CylinderGeometry(rTop, rBot, len, seg, 1);
}
/** Flat plate from an XZ polygon extruded in Y. Wings, ears, tails, flippers. */
function plate(poly, thick) {
  const n = poly.length;
  const tris = [];
  const half = thick / 2;
  for (let i = 1; i < n - 1; i++) {
    tris.push([poly[0][0], half, poly[0][1]], [poly[i][0], half, poly[i][1]], [poly[i + 1][0], half, poly[i + 1][1]]);
    tris.push([poly[0][0], -half, poly[0][1]], [poly[i + 1][0], -half, poly[i + 1][1]], [poly[i][0], -half, poly[i][1]]);
  }
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    tris.push([a[0], half, a[1]], [a[0], -half, a[1]], [b[0], half, b[1]]);
    tris.push([b[0], half, b[1]], [a[0], -half, a[1]], [b[0], -half, b[1]]);
  }
  const arr = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    arr[i * 3] = tris[i][0]; arr[i * 3 + 1] = tris[i][1]; arr[i * 3 + 2] = tris[i][2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  g.computeVertexNormals();
  return g;
}
function blob(r, sx, sy, sz) {
  const g = new THREE.IcosahedronGeometry(r, 0);
  g.scale(sx, sy, sz);
  return g;
}

// ---------------------------------------------------------------------------
// Species builders
// ---------------------------------------------------------------------------

/**
 * The generic mammal. Nearly every ground animal in the game is this function
 * with different numbers: deer, stag, sheep, cow, boar, fox, wolf, marmot.
 */
function mammal(P, C) {
  const m = new Model();
  const bodyY = P.bodyY;
  const halfLen = P.bodyLen / 2;

  // --- torso ---------------------------------------------------------------
  if (P.wool) {
    // Woolly animals read as a rounded lozenge from above, never as a bar.
    const b1 = blob(P.bodyR, P.bodyW * 1.06, P.bodyH * 0.98, 1.35);
    b1.translate(0, bodyY, halfLen * 0.14);
    m.add(b1, P_BODY, ZERO3, C.body);
    const b2 = blob(P.bodyR * 0.86, P.bodyW * 1.08, P.bodyH * 0.94, 1.15);
    b2.rotateY(0.7);
    b2.translate(0, bodyY + P.bodyR * 0.06, -halfLen * 0.52);
    m.add(b2, P_BODY, ZERO3, C.body2 ?? C.body);
  } else if (P.twoTone) {
    const front = limb(P.bodyR * P.frontTaper, P.bodyR, halfLen, P.seg ?? 6);
    front.scale(P.bodyW, P.bodyH, 1);
    front.translate(0, bodyY, halfLen / 2);
    m.add(front, P_BODY, ZERO3, C.body);
    const back = limb(P.bodyR, P.bodyR * P.rumpTaper, halfLen, P.seg ?? 6);
    back.scale(P.bodyW, P.bodyH, 1);
    back.translate(0, bodyY, -halfLen / 2);
    m.add(back, P_BODY, ZERO3, C.body2 ?? C.body);
  } else {
    const body = limb(P.bodyR * P.frontTaper, P.bodyR * P.rumpTaper, P.bodyLen, P.seg ?? 6);
    body.scale(P.bodyW, P.bodyH, 1);
    body.translate(0, bodyY, 0);
    m.add(body, P_BODY, ZERO3, C.body);
  }
  if (P.hump) {
    const h = blob(P.hump, 1.2, 0.8, 1.6);
    h.translate(0, bodyY + P.bodyR * P.bodyH * 0.7, halfLen * 0.3);
    m.add(h, P_BODY, ZERO3, C.body2 ?? C.body);
  }
  if (P.ruff) {
    const r = limb(P.ruff * 0.75, P.ruff, P.bodyLen * 0.2, 6);
    r.scale(1, 0.9, 1);
    r.translate(0, bodyY + P.bodyR * P.bodyH * 0.2, halfLen * 0.82);
    m.add(r, P_BODY, ZERO3, C.ruff ?? C.body2 ?? C.body);
  }

  // --- neck + head: one rigid part pivoting at the base of the neck ---------
  const pivot = [0, P.neckY, P.neckZ];
  if (P.neckLen > 0) {
    const neck = post(P.neckR * 0.72, P.neckR, P.neckLen, 5);
    neck.translate(0, P.neckLen / 2, 0);
    neck.rotateX(P.neckTilt);
    neck.translate(pivot[0], pivot[1], pivot[2]);
    m.add(neck, P_HEAD, pivot, C.neck ?? C.body);
  }
  const tipY = pivot[1] + Math.cos(P.neckTilt) * P.neckLen;
  const tipZ = pivot[2] + Math.sin(P.neckTilt) * P.neckLen;
  const head = limb(P.headR * 0.55, P.headR, P.headLen, 5);
  head.scale(P.headW ?? 1, 1, 1);
  head.translate(0, 0, P.headLen / 2);
  head.rotateX(P.headPitch);
  head.translate(0, tipY, tipZ);
  m.add(head, P_HEAD, pivot, C.head ?? C.body);

  if (P.ears) {
    for (const s of [-1, 1]) {
      const e = plate([[0, 0], [0.09, 0.16], [0, 0.30], [-0.09, 0.16]], 0.02);
      e.rotateZ(s * 0.9);
      e.rotateX(-0.5);
      e.scale(P.ears, P.ears, P.ears);
      e.translate(s * P.headR * 0.9, tipY + P.headR * 0.5, tipZ - P.headLen * 0.1);
      m.add(e, P_HEAD, pivot, C.head ?? C.body);
    }
  }
  if (P.antler) {
    const A = P.antler;
    for (const s of [-1, 1]) {
      const beam = post(0.03 * A, 0.05 * A, 0.62 * A, 4);
      beam.translate(0, 0.31 * A, 0);
      beam.rotateZ(s * 0.55);
      beam.rotateX(-0.35);
      beam.translate(s * P.headR * 0.55, tipY + P.headR * 0.4, tipZ - P.headLen * 0.25);
      m.add(beam, P_HEAD, pivot, C.horn);
      for (let i = 0; i < 2; i++) {
        const tine = post(0.02 * A, 0.035 * A, (0.30 + i * 0.12) * A, 4);
        tine.translate(0, (0.15 + i * 0.06) * A, 0);
        tine.rotateZ(s * (0.95 + i * 0.25));
        tine.rotateX(-0.55 - i * 0.3);
        tine.translate(
          s * (P.headR * 0.55 + (0.16 + i * 0.06) * A),
          tipY + P.headR * 0.4 + (0.30 + i * 0.16) * A,
          tipZ - P.headLen * 0.25 - i * 0.16 * A
        );
        m.add(tine, P_HEAD, pivot, C.horn);
      }
    }
  }
  if (P.horn) {
    for (const s of [-1, 1]) {
      const h = post(0.018 * P.horn, 0.05 * P.horn, 0.32 * P.horn, 4);
      h.translate(0, 0.16 * P.horn, 0);
      h.rotateZ(s * 1.15);
      h.translate(s * P.headR * 0.7, tipY + P.headR * 0.35, tipZ - P.headLen * 0.3);
      m.add(h, P_HEAD, pivot, C.horn);
    }
  }

  // --- legs: each rotates about its OWN hip; diagonal pairs share a phase ---
  const pairs = P.legPairs ?? 4;
  const lx = P.bodyW * P.bodyR * (P.legSpread ?? 0.62);
  const lz = halfLen * (P.legZ ?? 0.62);
  const legs = pairs === 4
    ? [[lx, lz, P_LEG_A], [-lx, lz, P_LEG_B], [lx, -lz, P_LEG_B], [-lx, -lz, P_LEG_A]]
    : [[lx, 0, P_LEG_A], [-lx, 0, P_LEG_B]];
  const hipY = P.hipY ?? bodyY;
  for (const [x, z, part] of legs) {
    const g = post(P.legR, P.legR * 0.55, hipY, 4);
    g.rotateY(Math.PI / 4);
    g.translate(x, hipY / 2, z);
    m.add(g, part, [x, hipY, z], C.leg ?? C.body);
  }

  // --- tail ----------------------------------------------------------------
  if (P.tail) {
    const T = P.tail;
    const pv = [0, bodyY + P.bodyR * P.bodyH * 0.35, -halfLen];
    let g;
    if (T.bushy) {
      g = blob(T.len * 0.34, 0.75, 0.8, 1.9);
      g.translate(0, 0, -T.len * 0.45);
      g.rotateX(T.up ?? -0.3);
    } else {
      g = post(T.r ?? 0.05, (T.r ?? 0.05) * 0.6, T.len, 4);
      g.translate(0, -T.len / 2, 0);
      g.rotateX(T.up ?? -0.5);
    }
    g.translate(pv[0], pv[1], pv[2]);
    m.add(g, P_TAIL, pv, T.color ?? C.tail ?? C.body);
  }
  return m.build();
}

/** Birds. Body + tail are rigid; the two wings flap about their shoulders. */
function bird(P, C) {
  const m = new Model();
  const body = limb(P.bodyR * 0.5, P.bodyR, P.bodyLen, 5);
  body.scale(1, 0.85, 1);
  body.translate(0, 0, P.bodyLen * 0.1);
  m.add(body, P_BODY, ZERO3, C.body);

  const head = limb(P.bodyR * 0.35, P.bodyR * 0.72, P.bodyLen * 0.3, 4);
  head.translate(0, P.bodyR * 0.18, P.bodyLen * 0.72);
  m.add(head, P_BODY, ZERO3, C.head ?? C.body);
  if (P.beak) {
    const bk = limb(0.01, P.bodyR * 0.3, P.bodyLen * 0.22, 4);
    bk.translate(0, P.bodyR * 0.18, P.bodyLen * 0.96);
    m.add(bk, P_BODY, ZERO3, C.beak ?? C.head ?? C.body);
  }

  const tailPivot = [0, 0, -P.bodyLen * 0.4];
  const tail = plate([[0, 0], [P.span * 0.075, -P.tailLen], [-P.span * 0.075, -P.tailLen]], P.bodyR * 0.35);
  tail.translate(0, 0, -P.bodyLen * 0.4);
  m.add(tail, P_TAIL, tailPivot, C.tail ?? C.body);

  // Wings: swept, tapered, with a built-in dihedral so gliders read as a V.
  for (const s of [-1, 1]) {
    const half = P.span / 2;
    let poly = [
      [0, P.chord * 0.5],
      [s * half * 0.45, P.chord * 0.34],
      [s * half, P.chord * 0.02],
      [s * half * 0.96, -P.chord * 0.22],
      [s * half * 0.4, -P.chord * 0.42],
      [0, -P.chord * 0.5],
    ];
    if (s > 0) poly = poly.slice().reverse();
    const pv = [s * P.bodyR * 0.5, P.bodyR * 0.25, P.bodyLen * 0.16];
    const w = plate(poly, P.bodyR * 0.34);
    w.rotateZ(s * (P.dihedral ?? 0.12));
    w.translate(pv[0], pv[1], pv[2]);
    m.add(w, s < 0 ? P_WING_R : P_WING_L, pv, s < 0 ? (C.wing2 ?? C.wing ?? C.body) : (C.wing ?? C.body));
  }
  return m.build();
}

/** Long-legged ground bird (roadrunner): bird body, two swinging legs. */
function groundBird(P, C) {
  const m = new Model();
  const bodyY = P.bodyY;
  const body = limb(P.bodyR * 0.6, P.bodyR, P.bodyLen, 5);
  body.scale(1, 0.9, 1);
  body.rotateX(-0.25);
  body.translate(0, bodyY, 0);
  m.add(body, P_BODY, ZERO3, C.body);

  const pivot = [0, bodyY + P.bodyR * 0.5, P.bodyLen * 0.34];
  const neck = post(P.bodyR * 0.28, P.bodyR * 0.4, P.neckLen, 4);
  neck.translate(0, P.neckLen / 2, 0);
  neck.rotateX(0.35);
  neck.translate(pivot[0], pivot[1], pivot[2]);
  m.add(neck, P_HEAD, pivot, C.body);
  const tipY = pivot[1] + Math.cos(0.35) * P.neckLen;
  const tipZ = pivot[2] + Math.sin(0.35) * P.neckLen;
  const head = limb(P.bodyR * 0.2, P.bodyR * 0.42, P.bodyLen * 0.34, 4);
  head.rotateX(1.15);
  head.translate(0, tipY, tipZ + P.bodyLen * 0.08);
  m.add(head, P_HEAD, pivot, C.head ?? C.body);
  const crest = plate([[0, 0], [0.02, 0.20], [-0.02, 0.15]], 0.02);
  crest.rotateX(-0.6);
  crest.translate(0, tipY + P.bodyR * 0.35, tipZ - P.bodyLen * 0.05);
  m.add(crest, P_HEAD, pivot, C.head ?? C.body);

  const tailPivot = [0, bodyY + P.bodyR * 0.4, -P.bodyLen * 0.45];
  const tail = plate([[0, 0], [P.bodyR * 0.5, -P.tailLen], [-P.bodyR * 0.5, -P.tailLen]], P.bodyR * 0.3);
  tail.rotateX(0.55);
  tail.translate(tailPivot[0], tailPivot[1], tailPivot[2]);
  m.add(tail, P_TAIL, tailPivot, C.tail ?? C.body);

  const lx = P.bodyR * 0.5;
  for (const [x, part] of [[lx, P_LEG_A], [-lx, P_LEG_B]]) {
    const g = post(P.legR, P.legR * 0.6, bodyY, 4);
    g.translate(x, bodyY / 2, 0);
    m.add(g, part, [x, bodyY, 0], C.leg ?? C.body);
  }
  return m.build();
}

/** Seal hauled out on a rock: no legs, just a lozenge and a lifting head. */
function seal(C) {
  const m = new Model();
  const body = blob(0.42, 0.85, 0.8, 2.1);
  body.translate(0, 0.3, -0.1);
  m.add(body, P_BODY, ZERO3, C.body);
  const pv = [0, 0.4, 0.55];
  const head = limb(0.13, 0.2, 0.42, 5);
  head.rotateX(-0.45);
  head.translate(0, 0.44, 0.72);
  m.add(head, P_HEAD, pv, C.head);
  for (const s of [-1, 1]) {
    const f = plate([[0, 0.1], [s * 0.3, -0.06], [0, -0.24]], 0.05);
    f.translate(s * 0.26, 0.16, -0.55);
    m.add(f, P_BODY, ZERO3, C.leg);
  }
  return m.build();
}

// ---------------------------------------------------------------------------
// Palette-derived colours: `t(slot, dh, ds, dl)` reads a slot from the Palette
// and shifts it in HSL. Nothing here hard-codes a hex.
// ---------------------------------------------------------------------------
function makeTint(palette) {
  const slot = (name) => {
    if (name.startsWith('ground')) return palette.ground[Math.min(palette.ground.length - 1, +name.slice(6))];
    if (name.startsWith('foliage')) return palette.foliage[+name.slice(7) % palette.foliage.length];
    if (name.startsWith('accent')) return palette.accents[+name.slice(6) % palette.accents.length];
    return palette[name];
  };
  return (name, h = 0, s = 0, l = 0) => new THREE.Color(slot(name)).offsetHSL(h, s, l);
}

// ---------------------------------------------------------------------------
// Species table: geometry + behaviour numbers.
// ---------------------------------------------------------------------------
function speciesTable(t) {
  const bone = t('trunk', 0.01, -0.16, 0.22);
  const pale = t('ground4', 0, -0.2, 0.08);
  return {
    deer: {
      kind: 'ground', scale: [1.16, 1.38], sep: 3.0, flag: true,
      speed: { graze: 0.42, walk: 2.0, run: 11.5 }, cadence: 1.55, gaitAmp: 0.55, grazeHead: 1.5,
      build: () => mammal(
        { bodyLen: 1.46, bodyR: 0.35, bodyW: 0.84, bodyH: 1.02, frontTaper: 0.92, rumpTaper: 1.02, bodyY: 1.00,
          twoTone: true,
          neckY: 1.16, neckZ: 0.56, neckLen: 0.56, neckR: 0.165, neckTilt: 0.46,
          headLen: 0.50, headR: 0.165, headPitch: 0.55, ears: 1.1,
          legR: 0.100, hipY: 1.00, legZ: 0.74, legSpread: 0.74,
          tail: { len: 0.28, r: 0.085, up: -1.1 } },
        { body: t('trunk', 0.01, 0.14, 0.13), body2: t('trunk', 0.015, 0.10, 0.24),
          head: t('trunk', 0.01, 0.10, 0.02),
          neck: t('trunk', 0.01, 0.12, 0.07), leg: t('trunk', 0, 0.06, -0.06),
          tail: pale, horn: bone }
      ),
    },
    stag: {
      kind: 'ground', scale: [1.30, 1.48], sep: 3.4, flag: true,
      speed: { graze: 0.38, walk: 1.9, run: 11.0 }, cadence: 1.45, gaitAmp: 0.52, grazeHead: 1.45,
      build: () => mammal(
        { bodyLen: 1.62, bodyR: 0.39, bodyW: 0.86, bodyH: 1.02, frontTaper: 0.94, rumpTaper: 1.0, bodyY: 1.14,
          twoTone: true,
          neckY: 1.30, neckZ: 0.62, neckLen: 0.62, neckR: 0.20, neckTilt: 0.42,
          headLen: 0.54, headR: 0.175, headPitch: 0.5, ears: 1.1, antler: 1.35, ruff: 0.32,
          legR: 0.112, hipY: 1.14, legZ: 0.74, legSpread: 0.72,
          tail: { len: 0.30, r: 0.085, up: -1.1 } },
        { body: t('trunk', 0.01, 0.16, 0.08), body2: t('trunk', 0.015, 0.10, 0.20),
          head: t('trunk', 0.01, 0.10, -0.02),
          neck: t('trunk', 0.0, 0.10, 0.03), ruff: t('trunk', 0.0, 0.05, 0.20),
          leg: t('trunk', 0, 0.05, -0.08), tail: pale, horn: bone }
      ),
    },
    sheep: {
      kind: 'ground', scale: [1.05, 1.32], sep: 2.0,
      speed: { graze: 0.30, walk: 1.3, run: 6.4 }, cadence: 2.2, gaitAmp: 0.44, grazeHead: 1.2,
      build: () => mammal(
        { bodyLen: 1.20, bodyR: 0.42, bodyW: 0.98, bodyH: 1.0, frontTaper: 0.96, rumpTaper: 1.0, bodyY: 0.78,
          wool: true,
          neckY: 0.80, neckZ: 0.50, neckLen: 0.24, neckR: 0.115, neckTilt: 0.72,
          headLen: 0.34, headR: 0.115, headPitch: 0.75, ears: 0.9,
          legR: 0.085, hipY: 0.60, legZ: 0.62, legSpread: 0.58,
          tail: { len: 0.16, r: 0.07, up: -0.2 } },
        { body: t('ground4', 0, -0.18, 0.08), body2: t('ground4', 0, -0.18, 0.03),
          head: t('rockShadow', 0, 0, 0.02),
          neck: t('rockShadow', 0, 0, 0.06), leg: t('rockShadow', 0, 0, 0.0), horn: bone }
      ),
    },
    cow: {
      kind: 'ground', scale: [1.14, 1.32], sep: 4.0,
      speed: { graze: 0.30, walk: 1.2, run: 6.0 }, cadence: 1.25, gaitAmp: 0.40, grazeHead: 1.5,
      build: () => mammal(
        { bodyLen: 2.1, bodyR: 0.46, bodyW: 0.88, bodyH: 1.0, frontTaper: 0.95, rumpTaper: 1.02, bodyY: 1.12,
          twoTone: true,
          neckY: 1.18, neckZ: 0.86, neckLen: 0.30, neckR: 0.19, neckTilt: 0.62,
          headLen: 0.50, headR: 0.16, headPitch: 0.62, ears: 0.9, horn: 0.9,
          legR: 0.125, hipY: 1.06, legZ: 0.66, legSpread: 0.66,
          tail: { len: 0.40, r: 0.055, up: -0.10 } },
        { body: t('ground4', 0, -0.12, 0.02), body2: t('rockShadow', 0.02, 0.06, -0.10),
          head: t('rockShadow', 0.02, 0.06, -0.06), neck: t('ground4', 0, -0.12, 0.0),
          leg: t('rockShadow', 0.02, 0.06, -0.03), horn: bone }
      ),
    },
    marmot: {
      kind: 'ground', scale: [1.25, 1.65], sep: 1.5,
      speed: { graze: 0.35, walk: 1.1, run: 5.2 }, cadence: 3.4, gaitAmp: 0.4, grazeHead: 0.95,
      build: () => mammal(
        { bodyLen: 0.58, bodyR: 0.21, bodyW: 0.95, bodyH: 1.0, frontTaper: 0.8, rumpTaper: 1.1, bodyY: 0.30,
          neckY: 0.34, neckZ: 0.24, neckLen: 0.10, neckR: 0.11, neckTilt: 0.30,
          headLen: 0.20, headR: 0.10, headPitch: 0.30, ears: 0.5,
          legR: 0.060, hipY: 0.24, legZ: 0.6, legSpread: 0.62,
          tail: { len: 0.22, r: 0.05, up: -1.0 } },
        { body: t('trunk', 0.02, 0.18, 0.16), head: t('trunk', 0.02, 0.15, 0.07),
          leg: t('trunk', 0, 0.10, -0.02), horn: bone }
      ),
    },
    boar: {
      kind: 'ground', scale: [1.12, 1.38], sep: 2.4,
      speed: { graze: 0.5, walk: 1.7, run: 8.5 }, cadence: 2.4, gaitAmp: 0.42, grazeHead: 0.9,
      build: () => mammal(
        { bodyLen: 1.32, bodyR: 0.36, bodyW: 0.86, bodyH: 1.0, frontTaper: 1.1, rumpTaper: 0.78, bodyY: 0.70,
          hump: 0.22,
          neckY: 0.76, neckZ: 0.56, neckLen: 0.12, neckR: 0.18, neckTilt: 1.0,
          headLen: 0.52, headR: 0.15, headPitch: 1.20, ears: 0.6,
          legR: 0.086, hipY: 0.58, legZ: 0.66, legSpread: 0.6,
          tail: { len: 0.16, r: 0.04, up: -0.3 } },
        { body: t('trunk', 0, 0.02, -0.06), body2: t('trunk', 0, 0.02, -0.10),
          head: t('trunk', 0, 0.02, -0.09), leg: t('trunk', 0, 0.02, -0.12), horn: bone }
      ),
    },
    fox: {
      kind: 'ground', scale: [1.12, 1.32], sep: 2.8,
      speed: { graze: 0.55, walk: 2.0, run: 10.0 }, cadence: 2.6, gaitAmp: 0.52, grazeHead: 0.95,
      build: () => mammal(
        { bodyLen: 0.92, bodyR: 0.19, bodyW: 0.95, bodyH: 1.0, frontTaper: 0.95, rumpTaper: 1.0, bodyY: 0.48,
          neckY: 0.52, neckZ: 0.40, neckLen: 0.14, neckR: 0.11, neckTilt: 0.5,
          headLen: 0.32, headR: 0.10, headPitch: 0.45, ears: 0.9,
          legR: 0.065, hipY: 0.42, legZ: 0.68, legSpread: 0.6,
          tail: { len: 0.64, bushy: true, up: -0.45 } },
        { body: t('accent0', -0.02, 0.05, 0.02), head: t('accent0', -0.02, 0.05, 0.0),
          leg: t('rockShadow', 0, 0, -0.06), tail: pale, horn: bone }
      ),
    },
    wolf: {
      kind: 'ground', scale: [1.18, 1.38], sep: 3.2,
      speed: { graze: 0.6, walk: 2.4, run: 12.0 }, cadence: 2.1, gaitAmp: 0.54, grazeHead: 0.85,
      build: () => mammal(
        { bodyLen: 1.30, bodyR: 0.24, bodyW: 0.92, bodyH: 1.0, frontTaper: 1.02, rumpTaper: 0.94, bodyY: 0.78,
          neckY: 0.82, neckZ: 0.54, neckLen: 0.22, neckR: 0.14, neckTilt: 0.85,
          headLen: 0.40, headR: 0.12, headPitch: 0.92, ears: 0.8, ruff: 0.2,
          legR: 0.078, hipY: 0.72, legZ: 0.7, legSpread: 0.6,
          tail: { len: 0.52, bushy: true, up: -0.25 } },
        { body: t('rock', 0, 0.02, -0.10), head: t('rock', 0, 0.02, -0.14),
          ruff: t('rock', 0, 0, 0.06), leg: t('rock', 0, 0.02, -0.18), horn: bone }
      ),
    },
    coyote: {
      kind: 'ground', scale: [1.10, 1.30], sep: 3.0,
      speed: { graze: 0.6, walk: 2.2, run: 11.0 }, cadence: 2.4, gaitAmp: 0.52, grazeHead: 0.85,
      build: () => mammal(
        { bodyLen: 1.08, bodyR: 0.20, bodyW: 0.92, bodyH: 1.0, frontTaper: 1.0, rumpTaper: 0.95, bodyY: 0.64,
          neckY: 0.68, neckZ: 0.46, neckLen: 0.18, neckR: 0.12, neckTilt: 0.9,
          headLen: 0.36, headR: 0.11, headPitch: 0.98, ears: 0.9,
          legR: 0.068, hipY: 0.58, legZ: 0.7, legSpread: 0.6,
          tail: { len: 0.46, bushy: true, up: -0.15 } },
        { body: t('trunk', 0.02, 0.12, 0.16), head: t('trunk', 0.02, 0.10, 0.09),
          leg: t('trunk', 0.02, 0.10, 0.04), horn: bone }
      ),
    },
    reindeer: {
      kind: 'ground', scale: [1.18, 1.40], sep: 3.2, flag: true,
      speed: { graze: 0.40, walk: 1.9, run: 10.5 }, cadence: 1.6, gaitAmp: 0.52, grazeHead: 1.45,
      build: () => mammal(
        { bodyLen: 1.52, bodyR: 0.38, bodyW: 0.88, bodyH: 1.02, frontTaper: 0.94, rumpTaper: 1.0, bodyY: 1.02,
          twoTone: true,
          neckY: 1.18, neckZ: 0.60, neckLen: 0.52, neckR: 0.21, neckTilt: 0.55,
          headLen: 0.52, headR: 0.175, headPitch: 0.60, ears: 1.0, antler: 1.6, ruff: 0.33,
          legR: 0.106, hipY: 1.04, legZ: 0.72, legSpread: 0.7,
          tail: { len: 0.20, r: 0.06, up: -0.4 } },
        { body: t('trunk', 0, 0.0, 0.18), body2: t('trunk', 0, -0.03, 0.30),
          head: t('trunk', 0, 0.0, 0.08),
          neck: t('trunk', 0, -0.06, 0.34), ruff: t('trunk', 0, -0.08, 0.44),
          leg: t('trunk', 0, 0.0, 0.0), horn: bone }
      ),
    },
    seal: {
      kind: 'ground', scale: [1.15, 1.50], sep: 2.0, still: true,
      speed: { graze: 0.10, walk: 0.45, run: 2.0 }, cadence: 3.0, gaitAmp: 0.0, grazeHead: -0.5,
      build: () => seal({
        body: t('rock', 0, 0.03, -0.08), head: t('rock', 0, 0.03, -0.16),
        leg: t('rock', 0, 0.03, -0.20),
      }),
    },
    roadrunner: {
      kind: 'ground', scale: [1.20, 1.50], sep: 2.2,
      speed: { graze: 0.7, walk: 2.6, run: 9.0 }, cadence: 4.2, gaitAmp: 0.65, grazeHead: 0.9,
      build: () => groundBird(
        { bodyLen: 0.52, bodyR: 0.155, bodyY: 0.44, neckLen: 0.20, tailLen: 0.64, legR: 0.042 },
        { body: t('trunk', 0.02, 0.06, 0.08), head: t('rockShadow', 0, 0, 0.04),
          tail: t('trunk', 0.02, 0.06, -0.08), leg: t('accent2', 0, 0, -0.10) }
      ),
    },

    // ---- birds -------------------------------------------------------------
    eagle: {
      kind: 'air', scale: [1.10, 1.30], sep: 14,
      flap: { rate: 2.4, amp: 0.14 }, cruise: 15, alt: [72, 112],
      build: () => bird(
        { bodyLen: 1.0, bodyR: 0.15, span: 3.1, chord: 0.72, tailLen: 0.62, dihedral: 0.16, beak: true },
        { body: t('trunk', 0, 0.06, -0.10), head: pale,
          wing: t('trunk', 0, 0.06, -0.15), wing2: t('trunk', 0, 0.06, -0.18),
          tail: pale, beak: t('accent1', 0, 0.15, 0) }
      ),
    },
    vulture: {
      kind: 'air', scale: [1.15, 1.38], sep: 16,
      flap: { rate: 1.8, amp: 0.10 }, cruise: 13, alt: [80, 124],
      build: () => bird(
        { bodyLen: 1.05, bodyR: 0.16, span: 3.5, chord: 0.82, tailLen: 0.5, dihedral: 0.22, beak: true },
        { body: t('rockShadow', 0, 0, -0.04), head: t('accent1', 0, -0.25, -0.14),
          wing: t('rockShadow', 0, 0, -0.07), wing2: t('rockShadow', 0, 0, -0.10),
          tail: t('rockShadow', 0, 0, -0.02), beak: pale }
      ),
    },
    crow: {
      kind: 'air', scale: [1.05, 1.25], sep: 4.5,
      flap: { rate: 6.2, amp: 0.66 }, cruise: 11, alt: [26, 50],
      build: () => bird(
        { bodyLen: 0.62, bodyR: 0.105, span: 1.6, chord: 0.42, tailLen: 0.44, dihedral: 0.1, beak: true },
        { body: t('rockShadow', 0, 0.05, -0.16), wing: t('rockShadow', 0, 0.05, -0.19),
          wing2: t('rockShadow', 0, 0.05, -0.21), tail: t('rockShadow', 0, 0.05, -0.16),
          beak: t('rockShadow', 0, 0, -0.10) }
      ),
    },
    raven: {
      kind: 'air', scale: [1.12, 1.32], sep: 5.0,
      flap: { rate: 5.4, amp: 0.60 }, cruise: 11.5, alt: [28, 56],
      build: () => bird(
        { bodyLen: 0.74, bodyR: 0.12, span: 2.0, chord: 0.48, tailLen: 0.56, dihedral: 0.1, beak: true },
        { body: t('rockShadow', 0, 0.05, -0.22), wing: t('rockShadow', 0, 0.05, -0.24),
          wing2: t('rockShadow', 0, 0.05, -0.26), tail: t('rockShadow', 0, 0.05, -0.22),
          beak: t('rockShadow', 0, 0, -0.16) }
      ),
    },
    gull: {
      kind: 'air', scale: [1.05, 1.25], sep: 4.2,
      flap: { rate: 4.4, amp: 0.54 }, cruise: 12, alt: [22, 52],
      build: () => bird(
        { bodyLen: 0.64, bodyR: 0.105, span: 1.8, chord: 0.38, tailLen: 0.36, dihedral: 0.14, beak: true },
        { body: t('ground4', 0, -0.3, 0.12), head: t('ground4', 0, -0.3, 0.12),
          wing: t('ground4', 0, -0.2, 0.0), wing2: t('rock', 0, 0, 0.04),
          tail: t('ground4', 0, -0.3, 0.10), beak: t('accent2', 0, 0.2, 0) }
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Which animals live where, and how they group.
// ---------------------------------------------------------------------------
const FAUNA = {
  alpine: {
    ground: [
      { sp: 'sheep', w: 3.0, n: [12, 24], r: [7, 13] },
      { sp: 'deer', w: 2.5, n: [6, 12], r: [9, 16], mixin: { sp: 'stag', n: [1, 2] } },
      { sp: 'cow', w: 1.7, n: [5, 9], r: [10, 18] },
      { sp: 'marmot', w: 1.5, n: [3, 6], r: [5, 11] },
    ],
    air: [
      { sp: 'eagle', w: 1.2, mode: 'soar', n: [1, 2] },
      { sp: 'crow', w: 1.5, mode: 'flock', n: [7, 13] },
      { sp: 'crow', w: 1.5, mode: 'perched', n: [8, 15] },
    ],
  },
  autumn: {
    ground: [
      { sp: 'deer', w: 3.0, n: [6, 12], r: [9, 17], mixin: { sp: 'stag', n: [1, 2] } },
      { sp: 'boar', w: 2.2, n: [5, 10], r: [6, 12] },
      { sp: 'fox', w: 1.6, n: [1, 3], r: [7, 14] },
    ],
    air: [
      { sp: 'crow', w: 2.2, mode: 'flock', n: [8, 16] },
      { sp: 'crow', w: 2.0, mode: 'perched', n: [9, 17] },
      { sp: 'eagle', w: 0.7, mode: 'soar', n: [1, 1] },
    ],
  },
  desert: {
    ground: [
      { sp: 'coyote', w: 2.4, n: [3, 6], r: [9, 18] },
      { sp: 'roadrunner', w: 2.2, n: [1, 3], r: [8, 16] },
    ],
    air: [
      { sp: 'vulture', w: 2.2, mode: 'soar', n: [2, 4] },
      { sp: 'crow', w: 1.0, mode: 'flock', n: [6, 12] },
    ],
  },
  coast: {
    ground: [
      { sp: 'seal', w: 2.4, n: [5, 10], r: [5, 10], shore: true },
      { sp: 'sheep', w: 2.0, n: [9, 18], r: [7, 13] },
      { sp: 'fox', w: 1.0, n: [1, 2], r: [7, 13] },
    ],
    air: [
      { sp: 'gull', w: 3.0, mode: 'flock', n: [10, 20] },
      { sp: 'gull', w: 2.6, mode: 'perched', n: [10, 19] },
      { sp: 'eagle', w: 0.6, mode: 'soar', n: [1, 1] },
    ],
  },
  winter: {
    ground: [
      { sp: 'reindeer', w: 3.2, n: [8, 16], r: [9, 17] },
      { sp: 'wolf', w: 1.8, n: [4, 7], r: [8, 15] },
    ],
    air: [
      { sp: 'raven', w: 2.2, mode: 'flock', n: [7, 15] },
      { sp: 'raven', w: 1.8, mode: 'perched', n: [7, 14] },
      { sp: 'eagle', w: 0.8, mode: 'soar', n: [1, 2] },
    ],
  },
};

// Behaviour states
const GRAZE = 0, ALERT = 1, FLEE = 2, REGROUP = 3;

/** Simulation + draw radius around the car. The frame is ~170 m wide. */
const ACTIVE_R = 265;

const GROUND_GROUPS = 78;
const AIR_GROUPS = 17;

function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
function angleTo(from, to, k) {
  return from + angleDelta(from, to) * clamp(k, 0, 1);
}

// ---------------------------------------------------------------------------

export function createAnimals(ctx) {
  const group = new THREE.Group();
  group.name = 'animals';

  const { terrain, biome, palette } = ctx;
  const roads = ctx.roads ?? null;
  const seed = (ctx.seed ?? 1337) | 0;
  const rng = new Rng(seed * 7919 + 13);
  const t = makeTint(palette);
  const SPECIES = speciesTable(t);
  const fauna = FAUNA[biome.id] ?? FAUNA.alpine;

  const waterY = biome.waterLevel ?? -3;
  const half = biome.size / 2 - 60;

  const isBlocked = (x, z) => {
    try { return roads?.isBlocked?.(x, z) === true; } catch { return false; }
  };
  const onRoad = (x, z) => {
    try { return roads?.isOnRoad?.(x, z) === true; } catch { return false; }
  };

  // --- where the action is -------------------------------------------------
  // Every preset starts from the road spawn (or Game.findSpawn) and drives a
  // few hundred metres. Bias the population toward that corridor so a
  // 146 x 82 m frame usually has something living in it, without carpeting the
  // whole map.
  const corridor = buildCorridor();
  // How far from the corridor wildlife is worth placing. With a real road
  // network we hug the route; with the fallback spawn we cover the whole disc
  // the car can reach in a capture.
  const playRadius = corridor.length > 2 ? 165 : 470;

  function buildCorridor() {
    const pts = [];
    if (roads && (roads.length ?? 0) > 40 && roads.sample) {
      for (let i = 0; i <= 28; i++) {
        const p = roads.sample(i / 28);
        if (p && Number.isFinite(p.x)) pts.push([p.x, p.z]);
      }
      if (pts.length > 2) return pts;
    }
    // Mirror of Game.findSpawn(): the deterministic fallback start point.
    for (let r = 0; r < 500; r += 12) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * TAU;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        if (terrain.heightAt(x, z) < waterY + 2) continue;
        if (terrain.normalAt(x, z, 4).y < 0.94) continue;
        return [[x, z]];
      }
    }
    return [[0, 0]];
  }

  // --- site selection ------------------------------------------------------
  function siteOk(x, z, opts) {
    const shore = opts?.shore, air = opts?.air;
    if (Math.abs(x) > half || Math.abs(z) > half) return false;
    if (air) return true;
    const h = terrain.heightAt(x, z);
    if (shore) {
      if (h < waterY + 0.3 || h > waterY + 6.0) return false;
    } else {
      if (h < waterY + 2.2) return false;
      if (h > 118) return false;                            // above the grazing line
      if (terrain.normalAt(x, z, 5).y < 0.90) return false; // cliffs
    }
    if (isBlocked(x, z) || onRoad(x, z)) return false;
    return true;
  }

  /** Rejection sampler biased toward the drivable corridor, clumped by fBm. */
  function pickSite(opts = {}) {
    for (let i = 0; i < 120; i++) {
      let x, z;
      if (opts.hero) {
        // One herd is always parked just off the start, so even a tightly
        // zoomed capture that barely moves has something living in frame.
        const a = rng.float(0, TAU), d = rng.float(34, 82);
        x = corridor[0][0] + Math.cos(a) * d;
        z = corridor[0][1] + Math.sin(a) * d;
      } else if (i < 90 && !opts.anywhere) {
        const p = corridor[rng.int(0, corridor.length - 1)];
        const a = rng.float(0, TAU);
        const d = 20 + Math.pow(rng.float(0, 1), 0.62) * playRadius;
        x = p[0] + Math.cos(a) * d;
        z = p[1] + Math.sin(a) * d;
      } else {
        x = rng.float(-half, half);
        z = rng.float(-half, half);
      }
      if (!opts.shore && !opts.air && !opts.hero) {
        // Clumping mask: groups gather in a few meadows, not in even noise.
        const clump = fbm(x * 0.0035, z * 0.0035, { octaves: 2, seed: seed + 313 });
        if (clump < rng.float(-0.75, 0.2)) continue;
      }
      if (siteOk(x, z, opts)) return [x, z];
    }
    return null;
  }

  // --- build the population ------------------------------------------------
  const col = new THREE.Color();
  const byspecies = new Map();
  const herds = [];
  const animals = [];

  function ensure(spName) {
    let e = byspecies.get(spName);
    if (!e) { e = { def: SPECIES[spName], list: [] }; byspecies.set(spName, e); }
    return e;
  }

  function addAnimal(spName, herd, x, z, extra) {
    const def = SPECIES[spName];
    if (!def) return null;
    const e = ensure(spName);
    const a = {
      sp: spName, def, herd,
      idx: e.list.length,
      x, z, y: terrain.heightAt(x, z),
      vx: 0, vz: 0, vy: 0,
      heading: rng.float(0, TAU),
      pitch: 0, roll: 0,
      phase: rng.float(0, TAU),
      state: GRAZE, timer: rng.float(0, 5),
      head: 0, headTarget: 0,
      gait: 0, wing: 0,
      scale: rng.float(def.scale[0], def.scale[1]),
      tintRGB: null,
      react: rng.float(0, 1),
      grazing: rng.bool(0.6),
      speedMul: rng.float(0.80, 1.15),
      swerve: rng.float(-0.55, 0.55),
      alt: 0, orbitA: rng.float(0, TAU), orbitR: 40, orbitDir: rng.sign(),
      grounded: false,
    };
    if (extra) Object.assign(a, extra);
    col.setRGB(1, 1, 1).offsetHSL(0, 0, rng.float(-0.06, 0.06));
    a.tintRGB = [col.r, col.g, col.b];
    e.list.push(a);
    animals.push(a);
    herd.members.push(a);
    return a;
  }

  function weightedPick(list) {
    let total = 0;
    for (const g of list) total += g.w;
    let r = rng.float(0, total);
    for (const g of list) { r -= g.w; if (r <= 0) return g; }
    return list[list.length - 1];
  }

  // ---- ground groups ------------------------------------------------------
  const anchors = [];
  const minSpacing = 44;
  for (let g = 0; g < GROUND_GROUPS; g++) {
    const cfg = weightedPick(fauna.ground);
    if (!SPECIES[cfg.sp]) continue;
    let site = null;
    for (let tries = 0; tries < 4 && !site; tries++) {
      const s = pickSite({ shore: cfg.shore, hero: g === 0, anywhere: g > GROUND_GROUPS * 0.7 });
      if (!s) continue;
      let ok = true;
      for (const a of anchors) {
        if ((a[0] - s[0]) ** 2 + (a[1] - s[1]) ** 2 < minSpacing * minSpacing) { ok = false; break; }
      }
      if (ok) site = s;
    }
    if (!site) continue;
    anchors.push(site);

    const radius = rng.float(cfg.r[0], cfg.r[1]);
    const herd = {
      kind: 'ground', ax: site[0], az: site[1], radius,
      alarm: 0, threat: 1e9, members: [],
      wander: rng.float(0, TAU), wanderRate: rng.float(0.12, 0.35) * rng.sign(),
      shore: !!cfg.shore,
    };
    herds.push(herd);

    const n = rng.int(cfg.n[0], cfg.n[1]);
    for (let i = 0; i < n; i++) {
      const a = rng.float(0, TAU);
      const d = Math.sqrt(rng.float(0.05, 1)) * radius;
      const x = site[0] + Math.cos(a) * d, z = site[1] + Math.sin(a) * d;
      if (!siteOk(x, z, { shore: cfg.shore })) continue;
      addAnimal(cfg.sp, herd, x, z);
    }
    if (cfg.mixin && herd.members.length) {
      const mn = rng.int(cfg.mixin.n[0], cfg.mixin.n[1]);
      for (let i = 0; i < mn; i++) {
        const a = rng.float(0, TAU);
        const d = Math.sqrt(rng.float(0.1, 1)) * radius;
        const x = site[0] + Math.cos(a) * d, z = site[1] + Math.sin(a) * d;
        if (!siteOk(x, z, { shore: cfg.shore })) continue;
        addAnimal(cfg.mixin.sp, herd, x, z);
      }
    }
  }

  // ---- air groups ---------------------------------------------------------
  for (let g = 0; g < AIR_GROUPS; g++) {
    const cfg = weightedPick(fauna.air);
    const spDef = SPECIES[cfg.sp];
    if (!spDef) continue;
    const perched = cfg.mode === 'perched';
    const site = pickSite({ air: !perched, anywhere: g > AIR_GROUPS * 0.6 });
    if (!site) continue;

    const herd = {
      kind: cfg.mode, ax: site[0], az: site[1],
      radius: cfg.mode === 'soar' ? rng.float(46, 92) : rng.float(14, 30),
      alarm: 0, threat: 1e9, members: [],
      wander: rng.float(0, TAU), wanderRate: rng.float(0.05, 0.18) * rng.sign(),
      baseAlt: rng.float(spDef.alt[0], spDef.alt[1]),
      airborne: !perched,
      settle: 0,
    };
    herds.push(herd);

    const orbitDir = rng.sign();
    const n = rng.int(cfg.n[0], cfg.n[1]);
    for (let i = 0; i < n; i++) {
      const a = rng.float(0, TAU);
      const d = Math.sqrt(rng.float(0.02, 1)) * herd.radius;
      const x = site[0] + Math.cos(a) * d, z = site[1] + Math.sin(a) * d;
      if (Math.abs(x) > half || Math.abs(z) > half) continue;
      if (perched && !siteOk(x, z, {})) continue;
      addAnimal(cfg.sp, herd, x, z, {
        grounded: perched,
        alt: perched ? 0 : herd.baseAlt + rng.float(-9, 9),
        orbitR: herd.radius * rng.float(0.55, 1.15),
        orbitA: a,
        orbitDir,
        react: rng.float(0, 1),
      });
    }
  }

  // --- meshes --------------------------------------------------------------
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  material.onBeforeCompile = injectGait;
  material.customProgramCacheKey = () => 'driftlands-gait';

  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = injectGait;
  depthMaterial.customProgramCacheKey = () => 'driftlands-gait-depth';

  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';

  for (const [spName, entry] of byspecies) {
    const n = entry.list.length;
    if (!n) continue;
    const geo = entry.def.build();
    // Footprint, used to size the stylised contact shadow.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    entry.foot = [
      Math.max(0.3, (bb.max.x - bb.min.x) * 0.52),
      Math.max(0.3, (bb.max.z - bb.min.z) * 0.5),
    ];
    entry.midY = (bb.max.y + bb.min.y) * 0.42;
    // Instances roam; the bounding sphere is only a rough hint and culling is
    // off anyway.
    if (geo.boundingSphere) geo.boundingSphere.radius *= 3;

    const anim = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    anim.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAnim', anim);

    const mesh = new THREE.InstancedMesh(geo, material, n);
    mesh.name = `animals:${spName}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.customDepthMaterial = depthMaterial;

    const inst = new Float32Array(n * 3);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(inst, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    entry.mesh = mesh;
    entry.anim = anim.array;
    group.add(mesh);
  }

  // --- stylised contact shadows -------------------------------------------
  // The sun shadow map is tuned for trees; at 1 m tall an animal barely
  // registers in it. A projected blob, offset along the real sun vector read
  // from the Palette, is what actually ties wildlife to the ground — and for
  // birds it puts a dark speck racing across the meadow far from the bird,
  // which is most of what tells you something is flying.
  const sunAz = palette.sunAzimuth ?? 2.35;
  const sunEl = Math.max(0.12, palette.sunElevation ?? 0.7);
  const shadowOff = [-Math.cos(sunAz) / Math.tan(sunEl), -Math.sin(sunAz) / Math.tan(sunEl)];

  const blobGeo = new THREE.CircleGeometry(0.5, 9);
  blobGeo.rotateX(-Math.PI / 2);
  const blobMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const shadowMesh = new THREE.InstancedMesh(blobGeo, blobMat, Math.max(1, animals.length));
  shadowMesh.name = 'animals:shadows';
  shadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shadowMesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, animals.length) * 3), 3
  );
  shadowMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  shadowMesh.frustumCulled = false;
  shadowMesh.castShadow = false;
  shadowMesh.receiveShadow = false;
  shadowMesh.renderOrder = 2;
  group.add(shadowMesh);

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------
  let time = 0;
  const px = { x: 1e6, z: 1e6, speed: 0 };

  /** Move an animal if the destination is walkable; returns false if refused. */
  function tryStep(a, nx, nz) {
    if (Math.abs(nx) > half || Math.abs(nz) > half) return false;
    const h = terrain.heightAt(nx, nz);
    if (h < waterY + 0.9) return false;
    const dist = Math.hypot(nx - a.x, nz - a.z);
    if (dist > 1e-4 && Math.abs(h - a.y) / dist > 0.85) return false; // cliff
    a.x = nx; a.z = nz;
    a.pitch = dist > 1e-4 ? clamp(Math.atan2(h - a.y, dist) * 0.6, -0.4, 0.4) : a.pitch * 0.92;
    a.y = h;
    return true;
  }

  function updateGroundHerd(herd, dt) {
    const M = herd.members;
    const n = M.length;
    if (!n) return;
    const def = M[0].def;

    let threat = 1e9;
    for (let i = 0; i < n; i++) {
      const a = M[i];
      const d = Math.hypot(a.x - px.x, a.z - px.z);
      if (d < threat) threat = d;
    }
    herd.threat = threat;

    // Startle radius grows with the car's speed — a fast car spooks from further.
    const startle = 34 + Math.min(px.speed, 42) * 1.3;
    if (threat < startle) herd.alarm = 1;
    else if (threat < startle * 1.75) herd.alarm = Math.max(herd.alarm, 0.5);
    else herd.alarm = Math.max(0, herd.alarm - dt * 0.22);

    herd.wander += herd.wanderRate * dt;

    let cx = 0, cz = 0, mvx = 0, mvz = 0;
    for (const a of M) { cx += a.x; cz += a.z; mvx += a.vx; mvz += a.vz; }
    cx /= n; cz /= n; mvx /= n; mvz /= n;

    for (let i = 0; i < n; i++) {
      const a = M[i];
      const d = Math.hypot(a.x - px.x, a.z - px.z);
      a.timer -= dt;

      // ---- state machine ---------------------------------------------------
      const fleeR = startle * (0.7 + a.react * 0.55);
      if (herd.alarm > 0.9 && d < fleeR) {
        if (a.state !== FLEE) { a.state = FLEE; a.timer = 2.2 + a.react * 3.6; }
      } else if (herd.alarm > 0.3 && a.state !== FLEE && a.state !== ALERT) {
        a.state = ALERT; a.timer = 1.4 + a.react * 2.2;
      }
      if (a.state === FLEE && a.timer <= 0 && herd.alarm < 0.6) {
        a.state = REGROUP; a.timer = 3.5 + a.react * 5;
      } else if (a.state === ALERT && a.timer <= 0 && herd.alarm < 0.25) {
        a.state = REGROUP; a.timer = 2.5 + a.react * 4;
      } else if (a.state === REGROUP && a.timer <= 0) {
        const home = Math.hypot(a.x - herd.ax, a.z - herd.az);
        if (home < herd.radius * 1.3) { a.state = GRAZE; a.timer = 2 + a.react * 6; }
        else a.timer = 2.5;
      }

      // ---- steering --------------------------------------------------------
      let ax = 0, az = 0;
      const sep = def.sep;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const b = M[j];
        const dx = a.x - b.x, dz = a.z - b.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < sep * sep && d2 > 1e-5) {
          const inv = (sep * 2.4) / d2;
          ax += dx * inv; az += dz * inv;
        }
      }
      const cw = a.state === REGROUP ? 1.6 : a.state === FLEE ? 0.5 : 0.55;
      ax += (cx - a.x) * 0.06 * cw;
      az += (cz - a.z) * 0.06 * cw;
      const aw = a.state === FLEE ? 0.5 : 0.35;
      ax += (mvx - a.vx) * aw;
      az += (mvz - a.vz) * aw;

      // home tether — a herd belongs to a meadow, it does not migrate
      const hx = herd.ax - a.x, hz = herd.az - a.z;
      const hd = Math.hypot(hx, hz);
      if (hd > herd.radius) {
        const k = (a.state === FLEE ? 0.02 : 0.35) * Math.min(3, hd / herd.radius);
        ax += (hx / hd) * k * 2.0;
        az += (hz / hd) * k * 2.0;
      }

      // wander
      const wa = herd.wander + a.idx * 1.7 + Math.sin(time * 0.31 + a.idx * 2.3) * 1.4;
      ax += Math.cos(wa) * 0.5;
      az += Math.sin(wa) * 0.5;

      // flee from the car
      if (a.state === FLEE || a.state === ALERT) {
        const dx = a.x - px.x, dz = a.z - px.z;
        const dd = Math.hypot(dx, dz) || 1;
        // Every animal picks a slightly different escape line, so the herd
        // fans out from the car instead of marching away in formation.
        const sw = a.swerve + Math.sin(time * 0.8 + a.idx * 2.7) * 0.18;
        const cs = Math.cos(sw), sn = Math.sin(sw);
        const ex = (dx * cs - dz * sn) / dd, ez = (dx * sn + dz * cs) / dd;
        const k = (a.state === FLEE ? 46 : 4) * clamp(1 - dd / (startle * 2.2), 0.12, 1);
        ax += ex * k;
        az += ez * k;
      }

      // leave the road — animals cross it, they never loiter on it
      if (onRoad(a.x, a.z)) {
        let gx = 0, gz = 0;
        if (!onRoad(a.x + 10, a.z)) gx += 10;
        if (!onRoad(a.x - 10, a.z)) gx -= 10;
        if (!onRoad(a.x, a.z + 10)) gz += 10;
        if (!onRoad(a.x, a.z - 10)) gz -= 10;
        const gd = Math.hypot(gx, gz);
        if (gd > 0.001) { ax += (gx / gd) * 30; az += (gz / gd) * 30; }
        if (a.state === GRAZE) { a.state = REGROUP; a.timer = 3; }
      }

      // ---- integrate -------------------------------------------------------
      const S = def.speed;
      let vmax;
      if (a.state === FLEE) vmax = S.run * a.speedMul;
      else if (a.state === ALERT) vmax = 0;
      else if (a.state === REGROUP) vmax = S.walk * a.speedMul;
      else vmax = a.grazing ? 0 : S.graze;

      const accel = a.state === FLEE ? 3.2 : 0.75;
      a.vx += clamp(ax, -60, 60) * accel * dt;
      a.vz += clamp(az, -60, 60) * accel * dt;
      const damp = Math.exp(-dt * (a.state === FLEE ? 1.3 : 3.0));
      a.vx *= damp; a.vz *= damp;
      let sp = Math.hypot(a.vx, a.vz);
      if (sp > vmax) { const k = vmax / (sp || 1); a.vx *= k; a.vz *= k; sp = vmax; }

      if (sp > 0.02) {
        if (!tryStep(a, a.x + a.vx * dt, a.z + a.vz * dt)) {
          // Blocked by water or a cliff: turn back toward the meadow.
          const bx = herd.ax - a.x, bz = herd.az - a.z;
          const bd = Math.hypot(bx, bz) || 1;
          a.vx = (bx / bd) * sp * 0.8;
          a.vz = (bz / bd) * sp * 0.8;
          sp *= 0.8;
        }
        const want = Math.atan2(a.vx, a.vz);
        a.heading = angleTo(a.heading, want, dt * (a.state === FLEE ? 6 : 3));
      } else if (a.state === ALERT) {
        // Turn to face the threat — the pose that reads "it has seen you".
        const want = Math.atan2(px.x - a.x, px.z - a.z);
        a.heading = angleTo(a.heading, want, dt * 3.2);
        a.pitch *= 0.9;
      } else {
        a.heading += Math.sin(time * 0.23 + a.idx * 3.1) * dt * 0.45;
        a.pitch *= 0.96;
      }

      // ---- pose ------------------------------------------------------------
      if (a.state === GRAZE) {
        if (a.timer <= 0) {
          a.grazing = !a.grazing;
          a.timer = a.grazing ? 3 + a.react * 8 : 2 + a.react * 5;
        }
        a.headTarget = a.grazing ? def.grazeHead : def.grazeHead * 0.10 - 0.10;
      } else if (a.state === ALERT) {
        a.headTarget = -0.22;
      } else if (a.state === FLEE) {
        a.headTarget = def.still ? 0 : 0.05;
      } else {
        a.headTarget = def.grazeHead * 0.26;
      }
      a.head += (a.headTarget - a.head) * Math.min(1, dt * 3.4);

      const gaitTarget = def.still ? 0 : clamp(sp / (S.run * 0.5), 0, 1) * def.gaitAmp;
      a.gait += (gaitTarget - a.gait) * Math.min(1, dt * 8);
      a.phase += (sp * def.cadence + (a.gait > 0.03 ? 0.9 : 0)) * dt;
      if (a.phase > 1e5) a.phase -= 1e5;
      // Deer flag the white underside of the tail when they bolt.
      a.wing = (def.flag && a.state === FLEE) ? -1.15 : Math.sin(time * 1.7 + a.idx) * 0.12;
    }
  }

  function updateAirHerd(herd, dt) {
    const M = herd.members;
    const n = M.length;
    if (!n) return;
    const def = M[0].def;
    herd.wander += herd.wanderRate * dt;

    let threat = 1e9;
    for (const a of M) {
      const d = Math.hypot(a.x - px.x, a.z - px.z);
      if (d < threat) threat = d;
    }
    herd.threat = threat;

    const perched = herd.kind === 'perched';
    if (perched) {
      const startle = 42 + Math.min(px.speed, 42) * 1.5;
      if (!herd.airborne && threat < startle) { herd.airborne = true; herd.settle = 0; }
      if (herd.airborne) {
        herd.settle += dt;
        if (herd.settle > 30 && threat > startle * 2.4) herd.airborne = false;
      }
    }

    let cx = 0, cz = 0, mvx = 0, mvz = 0;
    if (herd.kind !== 'soar') {
      for (const b of M) { cx += b.x; cz += b.z; mvx += b.vx; mvz += b.vz; }
      cx /= n; cz /= n; mvx /= n; mvz /= n;
    }

    for (let i = 0; i < n; i++) {
      const a = M[i];
      const gy = terrain.heightAt(a.x, a.z);

      // --- perched and calm: pecking about on the ground --------------------
      if (perched && !herd.airborne && a.alt < 0.35) {
        a.timer -= dt;
        if (a.timer <= 0) { a.grazing = !a.grazing; a.timer = 0.6 + a.react * 2.2; }
        a.head += ((a.grazing ? 1.0 : -0.08) - a.head) * Math.min(1, dt * 8);
        a.alt = 0; a.vy = 0;
        a.y = gy;
        a.grounded = true;
        a.gait = 0;
        a.wing = 0.04;
        a.phase += dt * 0.7;
        a.pitch = 0; a.roll = 0;
        continue;
      }
      a.grounded = false;

      let wantX, wantZ, wantAlt;
      if (herd.kind === 'soar') {
        // Raptor on a thermal: a slow, wide, banked circle that drifts.
        a.orbitA += a.orbitDir * (def.cruise / Math.max(14, a.orbitR)) * dt;
        wantX = herd.ax + Math.cos(a.orbitA) * a.orbitR + Math.cos(herd.wander) * 8;
        wantZ = herd.az + Math.sin(a.orbitA) * a.orbitR + Math.sin(herd.wander) * 8;
        wantAlt = herd.baseAlt + Math.sin(time * 0.13 + a.idx) * 9;
        a.roll += (-a.orbitDir * 0.55 - a.roll) * Math.min(1, dt * 2);
      } else {
        let ax = (cx - a.x) * 0.05 + (mvx - a.vx) * 0.5;
        let az = (cz - a.z) * 0.05 + (mvz - a.vz) * 0.5;
        const sep = def.sep;
        for (const b of M) {
          if (b === a) continue;
          const dx = a.x - b.x, dz = a.z - b.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < sep * sep && d2 > 1e-5) {
            const inv = (sep * 1.8) / d2;
            ax += dx * inv; az += dz * inv;
          }
        }
        const wa = herd.wander * 2.2 + a.idx * 0.9;
        ax += Math.cos(wa) * 1.8; az += Math.sin(wa) * 1.8;
        const hx = herd.ax - a.x, hz = herd.az - a.z;
        const hd = Math.hypot(hx, hz);
        if (hd > herd.radius * 2.6) { ax += (hx / hd) * 8; az += (hz / hd) * 8; }
        if (threat < 80) {
          const dx = a.x - px.x, dz = a.z - px.z, dd = Math.hypot(dx, dz) || 1;
          ax += (dx / dd) * 16; az += (dz / dd) * 16;
        }
        wantX = a.x + ax; wantZ = a.z + az;
        wantAlt = herd.baseAlt + Math.sin(time * 0.4 + a.idx * 1.3) * 5;
        if (perched) {
          // Just lifted off: climb hard, staggered per bird so the flock peels
          // off the ground in a wave instead of as a solid slab.
          wantAlt = herd.airborne
            ? Math.min(herd.baseAlt, Math.max(0, (herd.settle - a.react * 0.9) * 7))
            : 0;
        }
      }

      const dx = wantX - a.x, dz = wantZ - a.z;
      const dd = Math.hypot(dx, dz) || 1;
      const launch = perched && herd.settle < 3 ? 0.4 + herd.settle * 0.25 : 1;
      const cruise = def.cruise * launch;
      const k = Math.min(1, dt * (herd.kind === 'soar' ? 3.5 : 2.2));
      a.vx += ((dx / dd) * cruise - a.vx) * k;
      a.vz += ((dz / dd) * cruise - a.vz) * k;
      a.x = clamp(a.x + a.vx * dt, -half, half);
      a.z = clamp(a.z + a.vz * dt, -half, half);

      const climb = clamp((wantAlt - a.alt) * 0.9, -6, 10);
      a.vy += (climb - a.vy) * Math.min(1, dt * 1.8);
      a.alt = Math.max(0, a.alt + a.vy * dt);
      a.y = gy + a.alt;

      const want = Math.atan2(a.vx, a.vz);
      const turn = angleDelta(a.heading, want);
      a.heading = angleTo(a.heading, want, dt * 3.4);
      if (herd.kind !== 'soar') a.roll += (clamp(-turn * 1.8, -0.75, 0.75) - a.roll) * Math.min(1, dt * 4);
      a.pitch = clamp(-a.vy * 0.05, -0.35, 0.35);

      // Wingbeat: hard flapping on the climb, near-still glide up high.
      const effort = clamp(0.3 + a.vy * 0.18 + (herd.kind === 'soar' ? -0.2 : 0.2), 0.04, 1.4);
      a.wing = def.flap.amp * effort + 0.05;
      a.phase += def.flap.rate * (0.7 + effort * 0.8) * dt;
      if (a.phase > 1e5) a.phase -= 1e5;
      a.head = 0;
      a.gait = 0;
    }
  }

  function update(dtRaw, player) {
    const dt = Math.min(0.05, Math.max(0, dtRaw || 0));
    if (dt <= 0) return;
    time += dt;
    if (player?.position) { px.x = player.position.x; px.z = player.position.z; }
    px.speed = player?.speed ?? 0;

    for (const herd of herds) {
      // Off-camera herds are not simulated at all. The camera only ever sees
      // ~170 m across, so ACTIVE_R is generous; this is what lets the world
      // carry a thousand animals for the price of a couple of hundred.
      const hd = Math.hypot(herd.ax - px.x, herd.az - px.z) - herd.radius * 2;
      if (hd > ACTIVE_R + 90) { herd.alarm = 0; continue; }
      if (herd.kind === 'ground') updateGroundHerd(herd, dt);
      else updateAirHerd(herd, dt);
    }

    let s = 0;
    const sc = shadowMesh.instanceColor.array;
    const R2 = ACTIVE_R * ACTIVE_R;
    for (const entry of byspecies.values()) {
      const mesh = entry.mesh;
      if (!mesh) continue;
      const anim = entry.anim;
      const tintArr = mesh.instanceColor.array;
      const list = entry.list;
      const [fw, fl] = entry.foot;
      const air = entry.def.kind === 'air';
      let k = 0;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        const dx = a.x - px.x, dz = a.z - px.z;
        if (dx * dx + dz * dz > R2) continue;

        dummy.position.set(a.x, a.y, a.z);
        dummy.rotation.set(a.pitch, a.heading, a.roll);
        dummy.scale.setScalar(a.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        const c = a.tintRGB;
        tintArr[k * 3] = c[0]; tintArr[k * 3 + 1] = c[1]; tintArr[k * 3 + 2] = c[2];
        const q = k * 4;
        anim[q] = a.phase;
        anim[q + 1] = a.gait;
        anim[q + 2] = a.head;
        anim[q + 3] = a.wing;
        k++;

        // --- ground shadow ---------------------------------------------------
        // Ground animals get a tight contact patch under the belly: the sun
        // shadow map already draws the cast shadow, this is the occlusion that
        // stops them floating. Birds instead get a small speck offset along the
        // real sun vector, which fades out as they climb.
        let sx, sz, sy, sw, sl, dark;
        if (air) {
          const fade = clamp(1 - a.alt / 72, 0, 1);
          if (fade <= 0.02) continue;
          const lift = a.alt + 0.4;
          sx = a.x + shadowOff[0] * lift;
          sz = a.z + shadowOff[1] * lift;
          sy = terrain.heightAt(sx, sz);
          const grow = 1 + (1 - fade) * 0.7;
          sw = fw * a.scale * 1.5 * grow;
          sl = fl * a.scale * 1.5 * grow;
          dark = 1 - 0.30 * fade;
        } else {
          const lift = entry.midY * a.scale * 0.45;
          sx = a.x + shadowOff[0] * lift;
          sz = a.z + shadowOff[1] * lift;
          sy = a.y;
          sw = fw * a.scale * 1.35;
          sl = fl * a.scale * 1.25;
          dark = 0.70;
        }
        dummy.position.set(sx, sy + 0.12, sz);
        dummy.rotation.set(0, a.heading, 0);
        dummy.scale.set(sw, 1, sl);
        dummy.updateMatrix();
        shadowMesh.setMatrixAt(s, dummy.matrix);
        // Multiply blending: 1 = invisible, lower = darker.
        sc[s * 3] = dark; sc[s * 3 + 1] = dark * 1.015; sc[s * 3 + 2] = dark * 1.05;
        s++;
      }
      mesh.count = k;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      mesh.geometry.attributes.aAnim.needsUpdate = true;
    }
    shadowMesh.count = s;
    shadowMesh.instanceMatrix.needsUpdate = true;
    shadowMesh.instanceColor.needsUpdate = true;
  }

  // Settle the poses so the very first rendered frame is never a row of
  // identical T-poses.
  for (let i = 0; i < 8; i++) update(0.05, null);

  return {
    group,
    update,
    count: animals.length,
    herds: herds.length,
    species: byspecies.size,
  };
}
