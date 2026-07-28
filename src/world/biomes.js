import * as THREE from 'three';
import { HeightFns } from './terrain.js';
import { fbm } from '../core/rng.js';

/**
 * A "place" = palette + heightfield + water level + prop mix + road character.
 * Each one must feel like somewhere else, not a recolour.
 */

const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;

function rampColor(target, ramp, t) {
  const n = ramp.length - 1;
  const f = clamp(t, 0, 1) * n;
  const i = Math.min(n - 1, Math.floor(f));
  return target.copy(ramp[i]).lerp(ramp[i + 1], f - i);
}

export const BIOMES = {
  alpine: {
    id: 'alpine',
    palette: 'alpine',
    label: 'Alpine Meadows',
    waterLevel: -3.0,
    size: 1700,
    segments: 300,
    treeDensity: 1.0,
    rockDensity: 0.7,
    height(x, z, seed) {
      const base = HeightFns.rollingHills(x, z, seed, { scale: 0.0021, amp: 22 });
      const peaks = HeightFns.mountains(x, z, seed, { scale: 0.0011, amp: 150 });
      // Push the mountains to the rim so the drivable middle stays open.
      const r = Math.hypot(x, z) / 850;
      const rim = clamp((r - 0.42) / 0.5, 0, 1);
      return base + peaks * rim * rim + HeightFns.detail(x, z, seed, 1.4);
    },
    colorAt(c, ramp, rock, h, slope, x, z, seed) {
      const t = clamp((h + 6) / 120, 0, 1);
      rampColor(c, ramp, Math.pow(t, 0.75));
      const patch = fbm(x * 0.006, z * 0.006, { octaves: 2, seed: seed + 41 });
      c.offsetHSL(patch * 0.018, patch * 0.05, patch * 0.035);
      if (slope > 0.34) c.lerp(rock, clamp((slope - 0.34) / 0.3, 0, 1) * 0.9);
      return c;
    },
  },

  autumn: {
    id: 'autumn',
    palette: 'autumn',
    label: 'Ember Woodland',
    waterLevel: -1.5,
    size: 1500,
    segments: 280,
    treeDensity: 1.9,
    rockDensity: 0.5,
    height(x, z, seed) {
      const base = HeightFns.rollingHills(x, z, seed + 3, { scale: 0.0028, amp: 30 });
      const ridge = HeightFns.mountains(x, z, seed + 3, { scale: 0.0014, amp: 70 });
      const r = Math.hypot(x, z) / 760;
      return base + ridge * clamp((r - 0.5) / 0.5, 0, 1) + HeightFns.detail(x, z, seed, 1.8);
    },
    colorAt(c, ramp, rock, h, slope, x, z, seed) {
      const t = clamp((h + 12) / 80, 0, 1);
      rampColor(c, ramp, t);
      const patch = fbm(x * 0.009, z * 0.009, { octaves: 3, seed: seed + 55 });
      c.offsetHSL(patch * 0.03, patch * 0.06, patch * 0.05);
      if (slope > 0.3) c.lerp(rock, clamp((slope - 0.3) / 0.32, 0, 1) * 0.85);
      return c;
    },
  },

  desert: {
    id: 'desert',
    palette: 'desert',
    label: 'Vermilion Mesa',
    waterLevel: -2.5,
    size: 1900,
    segments: 300,
    treeDensity: 0.18,
    rockDensity: 1.6,
    height(x, z, seed) {
      const plate = HeightFns.plateau(x, z, seed + 9, { scale: 0.0013, amp: 78, sharpness: 4.5 });
      const dunes = HeightFns.rollingHills(x, z, seed + 9, { scale: 0.004, amp: 7 });
      // Terrace the plateaus into mesa steps — the silhouette signature.
      const stepped = Math.round(plate / 13) * 13 * 0.75 + plate * 0.25;
      return stepped + dunes + HeightFns.detail(x, z, seed, 1.0);
    },
    colorAt(c, ramp, rock, h, slope, x, z, seed) {
      const t = clamp(h / 80, 0, 1);
      rampColor(c, ramp, Math.pow(t, 0.9));
      const strata = Math.sin(h * 0.42 + fbm(x * 0.003, z * 0.003, { seed }) * 3) * 0.5 + 0.5;
      c.offsetHSL(strata * 0.012 - 0.006, 0.03, (strata - 0.5) * 0.05);
      if (slope > 0.26) c.lerp(rock, clamp((slope - 0.26) / 0.28, 0, 1));
      return c;
    },
  },

  coast: {
    id: 'coast',
    palette: 'coast',
    label: 'Cobalt Coast',
    waterLevel: 0.0,
    size: 1700,
    segments: 300,
    treeDensity: 0.75,
    rockDensity: 0.9,
    height(x, z, seed) {
      // Land in the north-west, sea to the south-east: a real coastline.
      const shore = (x * 0.6 + z * 0.8) / 700;
      const wobble = fbm(x * 0.0026, z * 0.0026, { octaves: 4, seed: seed + 17 }) * 0.55;
      const land = clamp(-shore + wobble + 0.35, -1, 1);
      const hills = HeightFns.rollingHills(x, z, seed + 17, { scale: 0.0032, amp: 34 });
      const cliff = Math.pow(clamp(land, 0, 1), 0.6);
      return land < 0 ? land * 26 : cliff * 30 + hills * cliff + HeightFns.detail(x, z, seed, 1.2);
    },
    colorAt(c, ramp, rock, h, slope, x, z, seed) {
      const t = clamp((h + 8) / 60, 0, 1);
      rampColor(c, ramp, t);
      if (h < 2.5 && h > -1.5) c.lerp(new THREE.Color(0xd8c9a0), 0.6); // beach
      const patch = fbm(x * 0.007, z * 0.007, { octaves: 2, seed: seed + 63 });
      c.offsetHSL(patch * 0.02, patch * 0.04, patch * 0.03);
      if (slope > 0.36) c.lerp(rock, clamp((slope - 0.36) / 0.3, 0, 1) * 0.95);
      return c;
    },
  },

  winter: {
    id: 'winter',
    palette: 'winter',
    label: 'Glacier Pass',
    waterLevel: -4.0,
    size: 1800,
    segments: 300,
    treeDensity: 0.85,
    rockDensity: 1.1,
    height(x, z, seed) {
      const base = HeightFns.rollingHills(x, z, seed + 23, { scale: 0.0019, amp: 20 });
      const peaks = HeightFns.mountains(x, z, seed + 23, { scale: 0.0012, amp: 170 });
      const r = Math.hypot(x, z) / 880;
      return base + peaks * Math.pow(clamp((r - 0.38) / 0.55, 0, 1), 1.6) + HeightFns.detail(x, z, seed, 1.1);
    },
    colorAt(c, ramp, rock, h, slope, x, z, seed) {
      const t = clamp((h + 8) / 110, 0, 1);
      rampColor(c, ramp, t);
      // Snow reads faintly blue — a touch of cool saturation, never grey.
      const patch = fbm(x * 0.005, z * 0.005, { octaves: 2, seed: seed + 77 });
      c.lerp(new THREE.Color(0xbcd6ef), 0.10 + patch * 0.06);
      if (slope > 0.42) c.lerp(rock, clamp((slope - 0.42) / 0.26, 0, 1));
      return c;
    },
  },
};

export const BIOME_IDS = Object.keys(BIOMES);
export const getBiome = (id) => BIOMES[id] ?? BIOMES.alpine;
