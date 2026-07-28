import * as THREE from 'three';

/**
 * FX ENVIRONMENT PROBE  (owned by the fx builder)
 * -----------------------------------------------
 * Dust that is not lit by the same sun as the world looks like a sticker.
 * Skid marks that ignore the ground colour look like paint.
 *
 * The fx modules are handed no palette by `game.js` (their contract is just
 * `spawn()` / `emit()` / `update()`), so instead of widening that contract we
 * read the lighting rig straight off the scene graph our own object belongs to.
 * Everything here is read-only observation of three.js objects that the render
 * owner already maintains: the sun `DirectionalLight`, the `HemisphereLight`,
 * `scene.fog` and the mesh named `water`.
 *
 * Result is cached and refreshed a few times a second — this is not a hot path.
 */

const _v = new THREE.Vector3();

export const SURF = {
  EARTH: 0,   // grass / meadow topsoil  — pale khaki dust
  SAND: 1,   // desert / dry ochre      — warm bright dust
  SNOW: 2,   // powder                  — white-blue spray
  TARMAC: 3,   // sealed road             — grey-white tyre smoke
  GRAVEL: 4,   // loose stone road        — grey dust + chips
  WATER: 5,   // shallows                — spray + wake
};

const DEFAULT_ENV = {
  ready: false,
  sunDir: new THREE.Vector3(0.5, 0.7, 0.5).normalize(),
  sunColor: new THREE.Color(0xfff2d6),
  sunIntensity: 3.0,
  skyColor: new THREE.Color(0x9ccbf0),
  groundColor: new THREE.Color(0x5f7a3c),
  ambIntensity: 1.1,
  fogColor: new THREE.Color(0xbfe0f2),
  fogDensity: 0.0016,
  waterLevel: -9999,
  biome: SURF.EARTH,
};

/** Walk to the scene root from any object. */
function rootOf(obj) {
  let o = obj;
  while (o && o.parent) o = o.parent;
  return o;
}

/**
 * Sample the lighting rig. `state` is a plain object owned by the caller so
 * each fx module keeps its own cache.
 */
export function sampleEnv(obj, state, now) {
  if (!state.env) state.env = { ...DEFAULT_ENV, sunDir: DEFAULT_ENV.sunDir.clone(), sunColor: DEFAULT_ENV.sunColor.clone(), skyColor: DEFAULT_ENV.skyColor.clone(), groundColor: DEFAULT_ENV.groundColor.clone(), fogColor: DEFAULT_ENV.fogColor.clone() };
  const env = state.env;
  if (state.at !== undefined && now - state.at < 0.35) return env;
  state.at = now;

  const scene = rootOf(obj);
  if (!scene || !scene.isScene) return env;

  let sun = null, hemi = null;
  for (const c of scene.children) {
    if (!sun && c.isDirectionalLight && c.castShadow) sun = c;
    else if (!hemi && c.isHemisphereLight) hemi = c;
  }
  if (!sun) for (const c of scene.children) if (c.isDirectionalLight) { sun = c; break; }

  if (sun) {
    const t = sun.target ? sun.target.position : _v.set(0, 0, 0);
    env.sunDir.set(sun.position.x - t.x, sun.position.y - t.y, sun.position.z - t.z).normalize();
    env.sunColor.copy(sun.color);
    env.sunIntensity = sun.intensity;
  }
  if (hemi) {
    env.skyColor.copy(hemi.color);
    env.groundColor.copy(hemi.groundColor);
    env.ambIntensity = hemi.intensity;
  }
  if (scene.fog) {
    env.fogColor.copy(scene.fog.color);
    env.fogDensity = scene.fog.density ?? 0.0016;
  }
  const water = scene.getObjectByName?.('water');
  env.waterLevel = water ? water.position.y : -9999;

  env.biome = classifyBiome(env.groundColor);
  env.ready = true;
  return env;
}

/**
 * The hemisphere light's ground colour is the render owner's own summary of
 * "what the dirt under this world looks like" — a perfect biome fingerprint.
 */
function classifyBiome(c) {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  const hue = hsl.h * 360;
  if (hsl.l > 0.55 && (hue > 175 && hue < 265)) return SURF.SNOW;
  if (hsl.l > 0.42 && hsl.s < 0.14) return SURF.SNOW;
  if (hue >= 10 && hue <= 54 && hsl.s > 0.20) return hsl.l > 0.28 ? SURF.SAND : SURF.EARTH;
  return SURF.EARTH;
}

/**
 * Per-surface art direction. Everything the plume and the tyre marks need to
 * look like they belong to *this* ground.
 *
 * @returns {{dust:THREE.Color, dustHot:THREE.Color, grit:THREE.Color,
 *            markCore:THREE.Color, markBerm:THREE.Color, loose:number,
 *            rise:number, life:number, puff:number, bermStrength:number}}
 */
const _pal = {};
export function surfaceStyle(env, kind, grip) {
  // `kind` comes from game.surfaceAt(): 'road' | 'bridge' | 'snow' | 'dirt'
  let s;
  if (kind === 'bridge') s = SURF.TARMAC;
  else if (kind === 'road') s = grip >= 0.94 ? SURF.TARMAC : SURF.GRAVEL;
  else if (kind === 'snow' || env.biome === SURF.SNOW) s = SURF.SNOW;
  else s = env.biome;
  return styleForSurface(s);
}

/** The raw art-directed style block for one surface class. */
export function styleForSurface(s) {
  let st = _pal[s];
  if (!st) {
    st = _pal[s] = {
      surf: s,
      dust: new THREE.Color(),
      dustHot: new THREE.Color(),
      grit: new THREE.Color(),
      markCore: new THREE.Color(),
      markBerm: new THREE.Color(),
    };
    switch (s) {
      case SURF.SAND:
        st.dust.setHex(0xf0cf95); st.dustHot.setHex(0xfff6e0); st.grit.setHex(0xb07a44);
        st.markCore.setHex(0x8f5330); st.markBerm.setHex(0xf7dcae);
        st.loose = 1.25; st.rise = 1.0; st.life = 1.25; st.puff = 1.0; st.bermStrength = 0.55;
        st.markAlpha = 0.55; st.width = 1.3;
        break;
      case SURF.SNOW:
        st.dust.setHex(0xf4f9ff); st.dustHot.setHex(0xffffff); st.grit.setHex(0xdfeaf5);
        st.markCore.setHex(0x9fb6cc); st.markBerm.setHex(0xffffff);
        st.loose = 1.15; st.rise = 1.25; st.life = 1.5; st.puff = 1.15; st.bermStrength = 0.85;
        st.markAlpha = 0.62; st.width = 1.35;
        break;
      case SURF.TARMAC:
        st.dust.setHex(0xdcdde0); st.dustHot.setHex(0xffffff); st.grit.setHex(0x6a6a70);
        st.markCore.setHex(0x14141a); st.markBerm.setHex(0x32323c);
        st.loose = 0.55; st.rise = 1.9; st.life = 2.2; st.puff = 1.3; st.bermStrength = 0.25;
        st.markAlpha = 0.78; st.width = 0.92;
        break;
      case SURF.GRAVEL:
        st.dust.setHex(0xcdbfa4); st.dustHot.setHex(0xf6ecd6); st.grit.setHex(0x8b7f6c);
        st.markCore.setHex(0x6a5c48); st.markBerm.setHex(0xd6c9ac);
        st.loose = 1.35; st.rise = 0.95; st.life = 1.2; st.puff = 1.0; st.bermStrength = 0.6;
        st.markAlpha = 0.52; st.width = 1.25;
        break;
      default: // EARTH
        st.dust.setHex(0xdccaa0); st.dustHot.setHex(0xfbf2dc); st.grit.setHex(0x866c46);
        st.markCore.setHex(0x5a4a2c); st.markBerm.setHex(0xbfae83);
        st.loose = 1.0; st.rise = 1.0; st.life = 1.15; st.puff = 1.0; st.bermStrength = 0.5;
        st.markAlpha = 0.58; st.width = 1.18;
        break;
    }
  }
  return st;
}
