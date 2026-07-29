import * as THREE from 'three';

/**
 * BUILDKIT — shared low-poly construction helpers for props.js and landmarks.js.
 *
 * Everything here produces flat-shadable, vertex-coloured BufferGeometry. No
 * textures, ever. A whole chalet or a whole fir tree ends up as ONE geometry
 * with a `color` attribute, so it can be drawn as a single instanced mesh or
 * merged into a single static batch.
 *
 * Colour policy: nothing in here invents a hex. Callers pass THREE.Color values
 * derived from the biome palette (see `derivePalette` below), so art direction
 * stays in render/palette.js.
 */

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/** Triangle in the XY plane extruded along Z. The workhorse for roofs/signs. */
export function triPrism(ax, ay, bx, by, cx, cy, depth) {
  const h = depth / 2;
  const A0 = [ax, ay, -h], B0 = [bx, by, -h], C0 = [cx, cy, -h];
  const A1 = [ax, ay, h], B1 = [bx, by, h], C1 = [cx, cy, h];
  const v = [];
  const tri = (p, q, r) => { v.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); };
  tri(A0, C0, B0);
  tri(A1, B1, C1);
  tri(A0, B0, B1); tri(A0, B1, A1);
  tri(B0, C0, C1); tri(B0, C1, B1);
  tri(C0, A0, A1); tri(C0, A1, C1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/** Convex polygon in XY, extruded along Z. Points must wind counter-clockwise. */
export function prism(points, depth) {
  const geos = [];
  for (let i = 1; i < points.length - 1; i++) {
    geos.push(triPrism(
      points[0][0], points[0][1],
      points[i][0], points[i][1],
      points[i + 1][0], points[i + 1][1],
      depth
    ));
  }
  return mergePlain(geos);
}

/** Gable (ridged) roof. Ridge runs along local X. */
export function gableRoof(width, height, depth) {
  const g = triPrism(-depth / 2, 0, depth / 2, 0, 0, height, width);
  g.rotateY(Math.PI / 2);
  return g;
}

/** Hipped / pyramid roof over a rectangular plan. */
export function pyramidRoof(width, height, depth) {
  const hw = width / 2, hd = depth / 2;
  const apex = [0, height, 0];
  const c = [[-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd]];
  const v = [];
  const tri = (p, q, r) => v.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
  for (let i = 0; i < 4; i++) tri(c[i], c[(i + 1) % 4], apex);
  tri(c[0], c[2], c[1]); tri(c[0], c[3], c[2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
  g.computeVertexNormals();
  return g;
}

/** Merge without colour (position + normal only). */
export function mergePlain(geos) {
  let total = 0;
  const prep = [];
  for (const g0 of geos) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    prep.push(g);
  }
  const pos = new Float32Array(total * 3), nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of prep) {
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return out;
}

/** Merge with a flat colour per part -> one geometry, `color` attribute filled. */
export function mergeColored(parts) {
  let total = 0;
  const prep = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo;
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    prep.push({ g, c: p.color });
  }
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const { g, c } of prep) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < n; i++) {
      col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b;
    }
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/**
 * Accumulates coloured primitives under a transform stack, then bakes them into
 * one geometry. `push(...)` / `pop()` behave like an immediate-mode matrix stack
 * so a building can be authored in local coordinates and dropped anywhere.
 */
export class GeoBuilder {
  constructor() {
    this.parts = [];
    this._stack = [new THREE.Matrix4()];
    this.tris = 0;
  }

  get m() { return this._stack[this._stack.length - 1]; }

  push(x = 0, y = 0, z = 0, yaw = 0, scale = 1) {
    const m = new THREE.Matrix4().compose(
      _v.set(x, y, z),
      _q.setFromEuler(_e.set(0, yaw, 0)),
      _s.set(scale, scale, scale)
    );
    this._stack.push(this.m.clone().multiply(m));
    return this;
  }

  /** Push with an extra tilt about X and Z (for leaning poles, wonky ruins). */
  pushTilt(x, y, z, yaw, pitch, roll, scale = 1) {
    const m = new THREE.Matrix4().compose(
      _v.set(x, y, z),
      _q.setFromEuler(_e.set(pitch, yaw, roll, 'YXZ')),
      _s.set(scale, scale, scale)
    );
    this._stack.push(this.m.clone().multiply(m));
    return this;
  }

  pop() { if (this._stack.length > 1) this._stack.pop(); return this; }

  raw(geo, color) {
    geo.applyMatrix4(this.m);
    const c = color.isColor ? color : new THREE.Color(color);
    this.parts.push({ geo, color: c });
    this.tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    return this;
  }

  box(w, h, d, color, o = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    return this.raw(place(g, o), color);
  }

  cyl(rTop, rBot, h, seg, color, o = {}) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, o.open ?? false);
    return this.raw(place(g, o), color);
  }

  /** `o.open` drops the base cap — halves the triangle count on anything whose
   *  underside is buried in grass (flower heads, stems, tufts). */
  cone(r, h, seg, color, o = {}) {
    const g = new THREE.ConeGeometry(r, h, seg, 1, o.open ?? false);
    return this.raw(place(g, o), color);
  }

  blob(r, color, o = {}) {
    const g = new THREE.IcosahedronGeometry(r, o.detail ?? 0);
    return this.raw(place(g, o), color);
  }

  gable(w, h, d, color, o = {}) { return this.raw(place(gableRoof(w, h, d), o), color); }
  pyramid(w, h, d, color, o = {}) { return this.raw(place(pyramidRoof(w, h, d), o), color); }
  tri(ax, ay, bx, by, cx, cy, depth, color, o = {}) {
    return this.raw(place(triPrism(ax, ay, bx, by, cx, cy, depth), o), color);
  }

  build() { return mergeColored(this.parts); }
}

/** Local rotate-then-translate for a primitive inside the builder's frame. */
function place(g, o) {
  if (o.sx || o.sy || o.sz) g.scale(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  if (o.rx) g.rotateX(o.rx);
  if (o.rz) g.rotateZ(o.rz);
  if (o.ry) g.rotateY(o.ry);
  g.translate(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  return g;
}

/**
 * Per-CORNER displacement table for a polyhedron.
 *
 * THREE's IcosahedronGeometry (PolyhedronGeometry) is NON-INDEXED: each of the
 * twelve corners appears five times, once per adjacent face, as five separate
 * vertices at the same position. Jittering `pos` vertex-by-vertex therefore
 * pulls the five copies of a corner in five different directions, which tears
 * the solid open into folded, self-intersecting sheets whose recomputed normals
 * point every which way. That — not a scale bug — is what produced the large
 * pale angular "scraps of paper" scattered through the alpine meadow: a rock
 * with +/-42% independent corner jitter is not a rock, it is confetti.
 *
 * So: hash the ORIGINAL position, and hand every copy of a corner the SAME
 * displacement. The result stays a closed convex-ish solid with clean facets.
 */
function cornerTable(rng, pos, make) {
  const table = new Map();
  const key = (x, y, z) =>
    `${Math.round(x * 512)},${Math.round(y * 512)},${Math.round(z * 512)}`;
  const out = [];
  for (let i = 0; i < pos.count; i++) {
    const k = key(pos.getX(i), pos.getY(i), pos.getZ(i));
    let v = table.get(k);
    if (!v) table.set(k, (v = make()));
    out.push(v);
  }
  return out;
}

/** Randomised faceted rock — a chunky closed solid, never a folded sheet. */
export function rockGeom(rng, opts = {}) {
  const g = new THREE.IcosahedronGeometry(1, opts.detail ?? 0);
  const pos = g.attributes.position;
  const jx = opts.jitter ?? 0.30;
  const J = cornerTable(rng, pos, () => ({
    kx: rng.float(1 - jx, 1 + jx),
    ky: rng.float(0.62, 1.02),
    kz: rng.float(1 - jx, 1 + jx),
  }));
  for (let i = 0; i < pos.count; i++) {
    const j = J[i];
    const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
    // A gentle coherent swell so the facets are not all the same size.
    const k = 1 + Math.sin(x0 * 3.1 + z0 * 2.3) * jx * 0.30;
    pos.setXYZ(i, x0 * k * j.kx, y0 * j.ky, z0 * k * j.kz);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Faceted rock with a FLAT-ISH TOP — the shape that dominates the alpine
 * reference: a half-buried block whose upper faces have been planed off, so it
 * catches the key light as one bright polygon instead of a busy sparkle. The
 * top is squashed toward a plane rather than cut, which keeps the silhouette
 * irregular where it meets the grass.
 */
export function slabGeom(rng, opts = {}) {
  const g = new THREE.IcosahedronGeometry(1, opts.detail ?? 0);
  const pos = g.attributes.position;
  const jx = opts.jitter ?? 0.24;
  const top = opts.top ?? 0.66;      // height at which the plane starts
  const squash = opts.squash ?? 0.45; // how much of the peak survives
  // Same corner-coherent jitter as rockGeom. The old per-vertex version at
  // jitter 0.42 was the single worst-looking thing in the alpine frame.
  const J = cornerTable(rng, pos, () => ({
    kx: rng.float(1 - jx, 1 + jx),
    ky: rng.float(0.86, 1.14),
    kz: rng.float(1 - jx, 1 + jx),
  }));
  for (let i = 0; i < pos.count; i++) {
    const j = J[i];
    // The old shape ran y from -1.15 to +0.60 and was then dropped with its
    // origin 0.11 BELOW the ground, so five sixths of the rock was buried and
    // what showed was a 2.4-wide, 0.45-tall wafer: a chunky boulder rendered as
    // a beer mat. The mass is lifted so roughly the top 60% stands proud, and
    // the horizontal is pulled in, giving a block about twice as wide as it is
    // tall — which is what the reference's meadow boulders measure.
    let x = pos.getX(i) * j.kx * 0.88;
    let y = pos.getY(i) * j.ky * 0.86 + 0.16;
    let z = pos.getZ(i) * j.kz * 0.88;
    if (y > top) y = top + (y - top) * squash;
    // Flare the base outward so the rock looks bedded into the ground.
    if (y < 0) { const k = 1 + (-y) * 0.16; x *= k; z *= k; }
    pos.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------
// Palette derivation. Landmarks and props need more materials than the Palette
// declares (plaster, roof tile, rusted metal...). Rather than invent hexes we
// derive every one from an existing palette entry, so an art-direction change
// in palette.js still moves the whole world.
// ---------------------------------------------------------------------------

const C = (hex) => new THREE.Color(hex);
const off = (c, h, s, l) => c.clone().offsetHSL(h, s, l);

export function derivePalette(p, biomeId) {
  const rock = C(p.rock);
  const rockDark = C(p.rockShadow);
  const trunk = C(p.trunk);
  const accent0 = C(p.accents[0]);
  const accent1 = C(p.accents[1] ?? p.accents[0]);
  const white = C(p.accents[p.accents.length - 1]);
  const edge = C(p.roadEdge);

  return {
    trunk,
    trunkDark: off(trunk, 0, 0.02, -0.09),
    bark: off(trunk, 0.01, -0.04, 0.05),
    birch: off(edge, 0.0, -0.22, 0.16),
    dead: off(trunk, 0.0, -0.30, 0.14),

    rock,
    rockDark,
    scree: off(rock, 0, -0.05, -0.05),
    stone: off(rock, 0, -0.04, -0.02),
    stoneDark: off(rockDark, 0, 0, -0.04),

    // Man-made
    plaster: off(edge, 0, -0.10, 0.16),
    plasterWarm: off(edge, -0.02, 0.05, 0.10),
    wood: off(trunk, 0.005, 0.06, 0.02),
    woodDark: off(trunk, 0, 0.04, -0.11),
    woodPale: off(trunk, 0.01, -0.10, 0.20),
    roofTile: off(accent0, -0.01, -0.12, -0.20),
    roofSlate: off(rockDark, 0.02, 0.02, -0.05),
    roofMetal: off(rock, 0.01, -0.12, 0.06),
    rust: off(accent0, -0.03, -0.18, -0.26),
    metal: off(rock, 0.0, -0.22, 0.04),
    metalDark: off(rockDark, 0, -0.15, -0.02),
    white,
    signRed: accent0,
    signYellow: accent1,
    tar: off(rockDark, 0, -0.1, -0.16),
    glass: off(C(p.skyHorizon), 0, 0.05, -0.28),
    hay: off(C(p.ground[3] ?? p.ground[2]), 0.01, 0.12, 0.02),
    snow: off(C(p.ground[p.ground.length - 1]), 0, 0, 0.02),
    accents: p.accents.map(C),
    biomeId,
  };
}
