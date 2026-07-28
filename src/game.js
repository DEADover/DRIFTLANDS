import * as THREE from 'three';
import { createRenderer, LightRig } from './render/renderer.js';
import { ChaseCamera } from './render/camera.js';
import { Sky, applyFog } from './render/sky.js';
import { getPalette } from './render/palette.js';
import { createPostFX } from './render/post.js';
import { getBiome } from './world/biomes.js';
import { Terrain } from './world/terrain.js';
import { Water } from './world/water.js';
import { PropScatter } from './world/props.js';
import { createRoadNetwork } from './world/roads.js';
import { createBridges } from './world/bridges.js';
import { createLandmarks } from './world/landmarks.js';
import { Vehicle } from './entities/vehicle.js';
import { CarView } from './entities/car.js';
import { createAnimals } from './entities/animals.js';
import { SkidMarks } from './fx/skidmarks.js';
import { ParticleSystem } from './fx/particles.js';
import { createFeel } from './fx/feel.js';
import { createAudio } from './audio/audio.js';
import { Hud } from './ui/hud.js';

const FIXED_DT = 1 / 120;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * The game shell. It OWNS the wiring between systems and nothing else — every
 * subsystem lives in its own module behind a fixed interface (see the CONTRACT
 * comment at the top of each). Builders edit their module; this file rarely
 * changes. If you find yourself needing to edit game.js to add a feature, the
 * interface is probably wrong — say so rather than widening this file.
 */
export class Game {
  constructor(container, uiRoot, { capture = false } = {}) {
    this.container = container;
    this.capture = capture;
    this.renderer = createRenderer(container);
    this.scene = new THREE.Scene();
    this.camera = new ChaseCamera(container.clientWidth / container.clientHeight);
    this.lights = new LightRig(this.scene);

    this.vehicle = new Vehicle();
    this.carView = new CarView({ body: 0xef4d4d });
    this.scene.add(this.carView.root);

    this.skid = new SkidMarks();
    this.scene.add(this.skid.mesh);
    this.particles = new ParticleSystem(4000);
    this.scene.add(this.particles.points);

    this.feel = createFeel({ camera: this.camera, vehicle: this.vehicle, particles: this.particles });
    this.audio = createAudio();

    this.hud = uiRoot ? new Hud(uiRoot) : null;
    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.post = createPostFX({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera.camera,
      palette: getPalette('alpine'),
    });

    this.driftScore = 0;
    this.bestDrift = 0;
    this.accumulator = 0;
    this.simTime = 0;
    this.cameraZoom = 1;
    this._wasDrifting = false;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._watchSize();
  }

  /**
   * Resize is defensive on purpose.
   *
   * If the page is constructed while its container has zero size — a background
   * tab, a collapsed pane, a hidden iframe — three.js bakes `width:0px;
   * height:0px` into the canvas's inline style. Because we then resize with
   * updateStyle=false (correct: the stylesheet should own layout), that inline
   * 0px is never cleared and the canvas stays invisible forever, showing a
   * black page even though the renderer is happily drawing every frame.
   *
   * So: never trust a zero container, and keep the canvas CSS under our control.
   */
  resize() {
    let w = this.container.clientWidth;
    let h = this.container.clientHeight;
    if (w < 2 || h < 2) { w = window.innerWidth || 1280; h = window.innerHeight || 720; }

    const el = this.renderer.domElement;
    if (el.style.width !== '100%' || el.style.height !== '100%') {
      el.style.width = '100%';
      el.style.height = '100%';
    }

    this.renderer.setSize(w, h, false);
    this.camera.setAspect(w / h);
    this.post.setSize(w, h);
    this._sized = { w, h };
  }

  /** Re-fit whenever the container actually gains or changes size. */
  _watchSize() {
    this.resize();
    if (typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(() => {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      if (w > 1 && h > 1 && (w !== this._sized?.w || h !== this._sized?.h)) this.resize();
    });
    this._ro.observe(this.container);
  }

  // -------------------------------------------------------------------------
  // World construction. Order matters: terrain -> roads -> water -> bridges ->
  // landmarks -> props (props fill whatever space is left) -> animals.
  // -------------------------------------------------------------------------
  loadBiome(id, seed = 1337) {
    this.worldGroup.clear();
    this.skid.clear();
    this.particles.clear();

    const biome = getBiome(id);
    const palette = getPalette(biome.palette);
    this.biome = biome;
    this.palette = palette;
    this.seed = seed;

    applyFog(this.scene, palette);
    this.lights.applyPalette(palette);
    this.renderer.toneMappingExposure = palette.exposure;
    this.post.applyPalette(palette);

    this.sky = new Sky(palette);
    this.worldGroup.add(this.sky.mesh);

    this.terrain = new Terrain({ size: biome.size, segments: biome.segments, seed }, palette, biome);
    this.worldGroup.add(this.terrain.build());

    const ctx = { terrain: this.terrain, biome, palette, seed };

    this.roads = createRoadNetwork(ctx);
    this.worldGroup.add(this.roads.group);

    this.water = new Water(palette, biome);
    this.worldGroup.add(this.water.mesh);

    this.bridges = createBridges({ ...ctx, roads: this.roads });
    this.worldGroup.add(this.bridges.group);

    this.landmarks = createLandmarks({ ...ctx, roads: this.roads, water: this.water });
    this.worldGroup.add(this.landmarks.group);

    const blocked = (x, z) =>
      this.roads.isBlocked(x, z) || this.bridges.isBlocked(x, z) || this.landmarks.isBlocked(x, z);

    this.props = new PropScatter(this.terrain, palette, biome, seed + 11);
    this.worldGroup.add(this.props.build(blocked));

    this.animals = createAnimals({ ...ctx, roads: this.roads });
    this.worldGroup.add(this.animals.group);

    this.colliders = [
      ...this.props.colliders,
      ...this.bridges.colliders,
      ...this.landmarks.colliders,
    ];
    this._buildColliderGrid();

    this.carView.setHeadlights(palette.sunElevation < 0.18);

    const spawn = this.roads.spawn() ?? this.findSpawn();
    this.vehicle.reset(spawn.x, spawn.z, spawn.heading);
    this.driftScore = 0;
    if (this.hud) this.hud.setPlace(biome.label);
    this.currentBiome = id;
  }

  /** Uniform grid so collision lookup stays O(1) with thousands of props. */
  _buildColliderGrid() {
    this._cell = 24;
    this._grid = new Map();
    for (const c of this.colliders) {
      const k = `${Math.floor(c.x / this._cell)},${Math.floor(c.z / this._cell)}`;
      let a = this._grid.get(k);
      if (!a) this._grid.set(k, (a = []));
      a.push(c);
    }
  }

  _nearbyColliders(x, z) {
    const cx = Math.floor(x / this._cell), cz = Math.floor(z / this._cell);
    const out = [];
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const a = this._grid.get(`${cx + i},${cz + j}`);
        if (a) out.push(...a);
      }
    return out;
  }

  findSpawn() {
    for (let r = 0; r < 500; r += 12) {
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
        const h = this.terrain.heightAt(x, z);
        if (h < this.biome.waterLevel + 2) continue;
        if (this.terrain.normalAt(x, z, 4).y < 0.94) continue;
        return { x, z, heading: ang + Math.PI / 2 };
      }
    }
    return { x: 0, z: 0, heading: 0 };
  }

  /**
   * Height of whatever surface is actually DRAWN at (x, z): bridge deck, then
   * road carriageway, then bare terrain.
   *
   * This used to return the terrain height unconditionally, ignoring
   * `roads.heightAt` entirely. The road ribbon is cut and filled into the
   * landscape and carries its own banking, so the drawn surface and the queried
   * surface disagreed everywhere the route did any work — the car sank into the
   * road, and worse, it took its roll from the TERRAIN normal underneath, so it
   * sat visibly tilted while parked on a flat road.
   */
  surfaceHeight(x, z) {
    const deck = this.bridges.heightAt(x, z);
    if (deck !== null && deck !== undefined) return deck;
    const road = this.roads.heightAt?.(x, z);
    if (road !== null && road !== undefined) return road;
    return this.terrain.heightAt(x, z);
  }

  groundAt(x, z) {
    const deck = this.bridges.heightAt(x, z);
    if (deck !== null && deck !== undefined) {
      return { height: deck, normal: UP.clone(), onBridge: true };
    }

    const road = this.roads.heightAt?.(x, z);
    if (road !== null && road !== undefined) {
      // Normal from the surface we are actually on, sampled wide enough to
      // ignore facet tooth but tight enough to keep real banking.
      const e = 2.2;
      const n = new THREE.Vector3(
        this.surfaceHeight(x - e, z) - this.surfaceHeight(x + e, z),
        2 * e,
        this.surfaceHeight(x, z - e) - this.surfaceHeight(x, z + e)
      ).normalize();
      return { height: road, normal: n, onBridge: false, onRoad: true };
    }

    return {
      height: this.terrain.heightAt(x, z),
      normal: this.terrain.normalAt(x, z),
      onBridge: false,
      onRoad: false,
    };
  }

  /**
   * Ground height that keeps every WHEEL on or above the surface.
   *
   * The body used to be placed using the terrain height sampled at the car's
   * centre only. On a flat-shaded heightfield the surface between facet
   * vertices is a plane, so on any slope or facet ridge the corners of a 2.7 x
   * 1.8 m wheelbase sit below that centre sample and the wheels visibly sink
   * into the ground. Sampling the four contact patches and taking the highest
   * means the car may ride a few centimetres proud on a crest — which is
   * invisible at this camera height — instead of clipping through, which is not.
   */
  carGroundAt(v) {
    const f = v.forward.clone(), r = v.right.clone();
    let h = -Infinity;
    let onBridge = false;
    for (const [fwd, side] of [[1.35, 0.92], [1.35, -0.92], [-1.35, 0.92], [-1.35, -0.92]]) {
      const x = v.position.x + f.x * fwd + r.x * side;
      const z = v.position.z + f.z * fwd + r.z * side;
      const g = this.groundAt(x, z);
      if (g.height > h) h = g.height;
      onBridge = onBridge || g.onBridge;
    }
    const centre = this.groundAt(v.position.x, v.position.z);
    return { height: h, normal: centre.normal, onBridge };
  }

  surfaceAt(x, z) {
    if (this.bridges.heightAt(x, z) != null) return { grip: 1.0, kind: 'bridge' };
    if (this.roads.isOnRoad(x, z)) return { grip: this.roads.gripAt(x, z), kind: 'road' };
    const base = this.biome.id === 'winter' ? 0.60 : this.biome.id === 'desert' ? 0.78 : 0.86;
    return { grip: base, kind: this.biome.id === 'winter' ? 'snow' : 'dirt' };
  }

  // -------------------------------------------------------------------------
  step(dt, input) {
    const v = this.vehicle;
    v._braking = input.brake > 0;

    const surf = this.surfaceAt(v.position.x, v.position.z);
    v.surfaceGrip = surf.grip;
    this.surface = surf;

    v.step(dt, input);

    // Prop collision: push out and bleed speed.
    for (const c of this._nearbyColliders(v.position.x, v.position.z)) {
      const dx = v.position.x - c.x, dz = v.position.z - c.z;
      const d2 = dx * dx + dz * dz;
      const r = c.r + 1.4;
      if (d2 < r * r && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const push = (r - d) / d;
        v.position.x += dx * push;
        v.position.z += dz * push;
        const impact = v.velocity.length();
        v.velocity.multiplyScalar(0.45);
        v.yawRate *= 0.5;
        if (impact > 6) {
          this.feel.event('impact', { speed: impact });
          this.audio.event('impact', { speed: impact });
          this.camera.addShake(Math.min(0.75, impact * 0.035));
        }
      }
    }

    const lim = this.biome.size / 2 - 40;
    v.position.x = THREE.MathUtils.clamp(v.position.x, -lim, lim);
    v.position.z = THREE.MathUtils.clamp(v.position.z, -lim, lim);

    if (v.isDrifting) {
      this.driftScore += v.driftAngle * v.speed * dt * 6 * (this.feel.chainMultiplier ?? 1);
      if (!this._wasDrifting) { this.feel.event('driftStart'); this.audio.event('driftStart'); }
    } else {
      if (this._wasDrifting) {
        this.bestDrift = Math.max(this.bestDrift, this.driftScore);
        this.feel.event('driftEnd', { score: this.driftScore });
        this.audio.event('driftEnd', { score: this.driftScore });
      }
      this.driftScore *= Math.exp(-dt * 2.2);
    }
    this._wasDrifting = v.isDrifting;

    this.simTime += dt;
  }

  emitFx(dt) {
    const v = this.vehicle;
    const fwd = v.forward.clone(), right = v.right.clone();
    const pts = [];
    for (const side of [1, -1]) {
      const x = v.position.x - fwd.x * 1.35 + right.x * 0.92 * side;
      const z = v.position.z - fwd.z * 1.35 + right.z * 0.92 * side;
      pts.push({ x, z, y: this.groundAt(x, z).height });
    }
    const slip = [v.wheelSlip[2], v.wheelSlip[3]];
    this.skid.emit(pts, slip, { surface: this.surface, speed: v.speed });

    const inten = Math.max(slip[0], slip[1]);
    if (inten > 0.25 && v.speed > 5) {
      const n = Math.min(8, Math.ceil(inten * v.speed * dt * 7));
      const dustCol = this.surface?.kind === 'road' ? 0xbfb8ab : this.palette.ground[1];
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
      this.camera.addShake(inten * dt * 0.3);
    }
  }

  update(dt, input) {
    const scaled = dt * (this.feel.timeScale ?? 1);
    this.accumulator += Math.min(scaled, 0.1);
    while (this.accumulator >= FIXED_DT) {
      this.step(FIXED_DT, input);
      this.accumulator -= FIXED_DT;
    }

    const v = this.vehicle;
    const g = this.groundAt(v.position.x, v.position.z);
    this.carView.update(scaled, v, this.carGroundAt(v), this._sampleHeight ??=
      (x, z) => this.groundAt(x, z).height);
    this.emitFx(scaled);
    this.skid.update(scaled);
    this.particles.update(scaled);
    this.water.update(scaled);
    this.animals.update(scaled, { position: v.position, speed: v.speed });

    this.feel.update(scaled, {
      vehicle: v, camera: this.camera, surface: this.surface,
      onRoad: this.surface?.kind === 'road', input,
    });
    this.audio.update(scaled, { vehicle: v, surface: this.surface });

    const focus = new THREE.Vector3(v.position.x, g.height, v.position.z);
    this.camera.update(scaled, {
      position: focus, velocity: v.velocity, heading: v.heading, lateralSlip: v.lateralSlip,
    }, { zoom: this.cameraZoom, fovBoost: this.feel.fovBoost ?? 0 });

    this.lights.follow(focus);
    this.sky.follow(this.camera.camera.position);
    if (this.hud) this.hud.update(v, this.driftScore, { surface: this.surface, feel: this.feel });
  }

  render() {
    this.post.setCamera?.(this.camera.camera);
    this.post.render();
  }

  /**
   * ROUTE AUTOPILOT — used by capture presets.
   *
   * A fixed input tape drives the car straight off the road within a couple of
   * seconds, so every screenshot ended up in an empty field with the route
   * nowhere in frame. This steers along the road spline instead, which is what
   * the client references show: the car ON the road, mid-corner.
   *
   * @param {{throttle?:number, handbrake?:number, brake?:number, aggression?:number}} opts
   */
  autopilotInput(opts = {}) {
    const v = this.vehicle;
    const speed = Math.max(v.speed, 6);
    // Look further ahead the faster we go, so the line stays smooth.
    const lead = THREE.MathUtils.clamp(speed * 1.15, 14, 46);

    const ahead = this.roads.lookAhead?.(v.position.x, v.position.z, lead);
    if (!ahead) return { throttle: opts.throttle ?? 1, brake: 0, steer: 0, handbrake: 0, reset: false };

    const dx = ahead.x - v.position.x, dz = ahead.z - v.position.z;
    const want = Math.atan2(-dz, dx);
    let err = want - v.heading;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;

    const aggression = opts.aggression ?? 1;
    const steer = THREE.MathUtils.clamp(err * 1.9 * aggression - v.yawRate * 0.22, -1, 1);

    return {
      throttle: opts.throttle ?? 1,
      brake: opts.brake ?? 0,
      steer,
      handbrake: opts.handbrake ?? 0,
      reset: false,
    };
  }

  /** Telemetry embedded in every screenshot manifest — critics read this. */
  stats() {
    const info = this.renderer.info;
    return {
      speedKmh: Math.round(this.vehicle.speed * 3.6),
      driftAngleDeg: Math.round((this.vehicle.driftAngle * 180) / Math.PI),
      driftScore: Math.round(this.driftScore),
      surface: this.surface?.kind ?? '?',
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      animals: this.animals.count ?? 0,
      roadLength: Math.round(this.roads.length ?? 0),
      post: this.post.enabled === true,
    };
  }
}
