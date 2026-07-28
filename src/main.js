import * as THREE from 'three';
import { createRenderer, LightRig } from './render/renderer.js';
import { ChaseCamera } from './render/camera.js';
import { Sky, applyFog } from './render/sky.js';
import { getPalette } from './render/palette.js';
import { getBiome, BIOME_IDS } from './world/biomes.js';
import { Terrain } from './world/terrain.js';
import { Water } from './world/water.js';
import { PropScatter } from './world/props.js';
import { Vehicle } from './entities/vehicle.js';
import { CarView } from './entities/car.js';
import { SkidMarks } from './fx/skidmarks.js';
import { ParticleSystem } from './fx/particles.js';
import { Hud } from './ui/hud.js';
import { KeyboardInput, TapeInput, NEUTRAL } from './core/input.js';
import { PRESETS } from './capture/presets.js';

const FIXED_DT = 1 / 120;

class Game {
  constructor(container, uiRoot) {
    this.container = container;
    this.renderer = createRenderer(container);
    this.scene = new THREE.Scene();
    this.camera = new ChaseCamera(container.clientWidth / container.clientHeight);
    this.lights = new LightRig(this.scene);

    this.vehicle = new Vehicle();
    this.carView = new CarView({ body: 0xef4d4d });
    this.scene.add(this.carView.root);

    this.skid = new SkidMarks();
    this.scene.add(this.skid.mesh);
    this.particles = new ParticleSystem(3000);
    this.scene.add(this.particles.points);

    this.hud = new Hud(uiRoot);
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.driftScore = 0;
    this.accumulator = 0;
    this.simTime = 0;
    this.paused = false;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.setAspect(w / h);
  }

  loadBiome(id, seed = 1337) {
    // Tear down the previous world.
    this.worldGroup.clear();
    this.skid.clear();
    this.particles.clear();

    const biome = getBiome(id);
    const palette = getPalette(biome.palette);
    this.biome = biome;
    this.palette = palette;

    applyFog(this.scene, palette);
    this.lights.applyPalette(palette);
    this.renderer.toneMappingExposure = palette.exposure;

    this.sky = new Sky(palette);
    this.worldGroup.add(this.sky.mesh);

    this.terrain = new Terrain({ size: biome.size, segments: biome.segments, seed }, palette, biome);
    this.worldGroup.add(this.terrain.build());

    this.water = new Water(palette, biome);
    this.worldGroup.add(this.water.mesh);

    this.props = new PropScatter(this.terrain, palette, biome, seed + 11);
    this.worldGroup.add(this.props.build());

    // Headlights on for the dusk biome.
    this.carView.setHeadlights(palette.sunElevation < 0.18);

    // Drop the car on a reasonable bit of ground.
    const spawn = this.findSpawn();
    this.vehicle.reset(spawn.x, spawn.z, spawn.heading);
    this.hud.setPlace(biome.label);
    this.currentBiome = id;
  }

  findSpawn() {
    // Walk outward from the origin until we find dry, flat-ish ground.
    for (let r = 0; r < 400; r += 12) {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        const h = this.terrain.heightAt(x, z);
        if (h < this.biome.waterLevel + 2) continue;
        if (this.terrain.normalAt(x, z, 4).y < 0.94) continue;
        return { x, z, heading: ang + Math.PI / 2 };
      }
    }
    return { x: 0, z: 0, heading: 0 };
  }

  groundAt(x, z) {
    return { height: this.terrain.heightAt(x, z), normal: this.terrain.normalAt(x, z) };
  }

  step(dt, input) {
    const v = this.vehicle;
    v._braking = input.brake > 0;

    // Surface grip from the terrain type under the wheels.
    const g = this.groundAt(v.position.x, v.position.z);
    v.surfaceGrip = this.biome.id === 'winter' ? 0.62 : this.biome.id === 'desert' ? 0.8 : 1.0;
    v.step(dt, input);

    // Keep the car inside the world.
    const lim = this.biome.size / 2 - 40;
    v.position.x = THREE.MathUtils.clamp(v.position.x, -lim, lim);
    v.position.z = THREE.MathUtils.clamp(v.position.z, -lim, lim);

    // Drift scoring.
    if (v.isDrifting) this.driftScore += v.driftAngle * v.speed * dt * 6;
    else this.driftScore *= Math.exp(-dt * 2.2);

    this.simTime += dt;
  }

  emitFx(dt) {
    const v = this.vehicle;
    const g = this.groundAt(v.position.x, v.position.z);
    const fwd = v.forward.clone(), right = v.right.clone();

    // Rear wheel contact points.
    const pts = [];
    for (const side of [1, -1]) {
      const x = v.position.x - fwd.x * 1.35 + right.x * 0.92 * side;
      const z = v.position.z - fwd.z * 1.35 + right.z * 0.92 * side;
      pts.push({ x, z, y: this.terrain.heightAt(x, z) });
    }
    const slip = [v.wheelSlip[2], v.wheelSlip[3]];
    this.skid.emit(pts, slip);

    // Dust plume behind the sliding wheels.
    const inten = Math.max(slip[0], slip[1]);
    if (inten > 0.25 && v.speed > 5) {
      const n = Math.min(6, Math.ceil(inten * v.speed * dt * 6));
      const dustCol = this.palette.ground[1];
      for (let i = 0; i < n; i++) {
        const p = pts[i % 2];
        this.particles.spawn({
          x: p.x + (Math.random() - 0.5) * 1.2,
          y: p.y + 0.3,
          z: p.z + (Math.random() - 0.5) * 1.2,
          vx: -fwd.x * v.speed * 0.22 + (Math.random() - 0.5) * 4,
          vy: Math.random() * 2.2 + 0.6,
          vz: -fwd.z * v.speed * 0.22 + (Math.random() - 0.5) * 4,
          size: 2.4 + Math.random() * 2.6,
          life: 0.85 + Math.random() * 0.7,
          color: dustCol,
          drag: 1.5,
          grow: 2.4,
        });
      }
      this.camera.addShake(inten * dt * 0.35);
    }
  }

  update(dt, input) {
    this.accumulator += Math.min(dt, 0.1);
    while (this.accumulator >= FIXED_DT) {
      this.step(FIXED_DT, input);
      this.accumulator -= FIXED_DT;
    }
    const v = this.vehicle;
    const g = this.groundAt(v.position.x, v.position.z);
    this.carView.update(dt, v, g);
    this.emitFx(dt);
    this.skid.update(dt);
    this.particles.update(dt);
    this.water.update(dt);

    const focus = new THREE.Vector3(v.position.x, g.height, v.position.z);
    this.camera.update(dt, {
      position: focus,
      velocity: v.velocity,
      heading: v.heading,
      lateralSlip: v.lateralSlip,
    }, { zoom: this.cameraZoom ?? 1 });

    this.lights.follow(focus);
    this.sky.follow(this.camera.camera.position);
    this.hud.update(v, this.driftScore);
  }

  render() {
    this.renderer.render(this.scene, this.camera.camera);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const container = document.getElementById('app');
const uiRoot = document.getElementById('ui');
const params = new URLSearchParams(location.search);
const shotId = params.get('shot');

const game = new Game(container, uiRoot);
window.__GAME = game;

if (shotId) {
  // ---- deterministic capture mode ----
  const preset = PRESETS[shotId];
  if (!preset) throw new Error(`Unknown capture preset: ${shotId}`);
  game.loadBiome(preset.biome, preset.seed);
  game.cameraZoom = preset.camera?.zoom ?? 1;
  if (params.get('hud') === '0') game.hud.setVisible(false);

  const tape = new TapeInput(preset.tape);
  const dt = 1 / 60;
  const frames = Math.round(preset.warmup / dt);
  for (let i = 0; i < frames; i++) {
    const input = tape.sample();
    tape.advance(dt);
    game.update(dt, input);
  }
  game.render();
  // Render twice so any first-frame shader compile is out of the way.
  game.render();
  window.__SHOT_READY = true;
  window.__SHOT_INFO = {
    preset: preset.id,
    biome: preset.biome,
    speedKmh: Math.round(game.vehicle.speed * 3.6),
    driftAngleDeg: Math.round((game.vehicle.driftAngle * 180) / Math.PI),
    drawCalls: game.renderer.info.render.calls,
    triangles: game.renderer.info.render.triangles,
  };
} else {
  // ---- interactive mode ----
  game.loadBiome('alpine');
  const kb = new KeyboardInput();
  window.addEventListener('keydown', (e) => {
    const idx = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(e.code);
    if (idx >= 0 && BIOME_IDS[idx]) game.loadBiome(BIOME_IDS[idx]);
    if (e.code === 'KeyR') {
      const s = game.findSpawn();
      game.vehicle.reset(s.x, s.z, s.heading);
      game.skid.clear();
    }
  });

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    game.update(dt, kb.sample());
    game.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
