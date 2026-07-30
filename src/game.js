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
import { resolveCollisions } from './core/collision.js';

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
    this.carView = new CarView({ body: 0xf2f3f5 });
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

    // The view of the world core/collision.js resolves against. Arrow closures,
    // so it keeps working when loadBiome swaps the roads and props out from
    // under it; only `barriers` is a direct reference and loadBiome re-points it.
    this.collisionWorld = {
      barriers: null,
      colliders: (x, z) => this._nearbyColliders(x, z),
      groundAt: (x, z) => this.groundAt(x, z),
    };

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
    // The barrier set is rebuilt with the roads, so the collision world has to
    // be re-pointed at it; everything else it needs is reached through closures
    // that survive the swap.
    this.collisionWorld.barriers = this.roads.barriers;

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
    const road = this.roads.heightAt?.(x, z);
    // TOPMOST, not deck-wins. Over the last few metres of a span the deck is
    // deliberately eased back down onto the road's own height so the car does
    // not hit a step getting on, which means the ribbon is legitimately drawn
    // ABOVE the planks there — by up to 0.46 m, measured. Preferring the deck
    // put the wheels that far under the surface at every abutment: after the
    // terrain and road queries were made exact, those six stations were the
    // entire remaining sink (max 0.608 m, and every one of the worst patches
    // was labelled road-drawn / bridge-physics).
    if (deck != null && road != null) return Math.max(deck, road);
    if (deck != null) return deck;
    if (road != null) return road;
    // `drawnHeightAt`, not `heightAt`. The second is the analytic field the
    // landforms are authored in; the first is the flat-shaded triangle actually
    // on screen at this point. Measured against a raycast into the mesh, the
    // analytic field is 0.115 m out on average and 3.29 m out at worst, while
    // the drawn query is exact to 1.2e-12 m. Every metre of that difference used
    // to arrive as a wheel inside the hill.
    return this.terrain.drawnHeightAt(x, z);
  }

  groundAt(x, z) {
    const deck = this.bridges.heightAt(x, z);
    const road = this.roads.heightAt?.(x, z);

    // Whichever is drawn on top wins — see surfaceHeight. `onBridge` follows the
    // surface the wheels are actually resting on, not merely whether a deck
    // exists here, so the abutment ramp reports 'road' while the car is still on
    // gravel and flips to 'bridge' the moment the planks come up to meet it.
    if (deck != null && (road == null || deck >= road)) {
      return { height: deck, normal: UP.clone(), onBridge: true };
    }

    if (road != null) {
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

    /**
     * HEIGHT FROM THE TRIANGLE, SLOPE FROM THE HILLSIDE.
     *
     * `drawnNormalAt` returns the true face normal, and for placing a wheel that
     * is exactly right. As the gradient the CAR fights it is wrong: the facets
     * are metres across and their normals are piecewise constant, so a car that
     * spans 4.2 m gets handed the tilt of whichever single triangle its navel
     * happens to be over. Off-road that repeatedly reads steeper than the
     * hillside really is, and `_stepVertical`'s bleed above 0.53 then stops the
     * car dead on ground it should have coasted down.
     *
     * MEASURED (tools/collide-live.mjs, 90 s of autopilot in alpine): with the
     * face normal the run spent 51.8% of its time under 3 m/s and ended
     * stationary at (-128, 414) on a facet reading 0.693. Central differences
     * over a 2.5 m baseline average several facets — about the span of the
     * wheelbase, which is the right scale for "how steep is this for a car".
     */
    const e = 2.5;
    const D = this.terrain.drawnHeightAt.bind(this.terrain);
    return {
      height: D(x, z),
      normal: new THREE.Vector3(
        D(x - e, z) - D(x + e, z), 2 * e, D(x, z - e) - D(x, z + e)
      ).normalize(),
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
  /**
   * CAR POSE FROM THE FOUR CONTACT PATCHES — the single source of truth.
   *
   * The old scheme had two competing ones: the body took its tilt from the
   * terrain NORMAL sampled under the car's centre, and then every wheel was
   * dragged back onto the ground individually afterwards. On any climb or
   * descent those two disagree — the normal at a point is not the plane through
   * four patches several metres apart — so the correction pass was permanently
   * fighting the chassis transform, and wheels sank or floated depending on
   * which won. Patching it per-location could never work.
   *
   * Now the contact patches decide everything. Sample the surface under each
   * wheel, fit a plane, and take the ride height, pitch and roll from it. The
   * wheels then sit on the ground BY CONSTRUCTION, at fixed local positions,
   * with no correction pass at all.
   *
   * @returns {{y:number, pitch:number, roll:number, onBridge:boolean, contact:number[]}}
   */
  carPose(v, dt = 1 / 60) {
    // Must match the wheel placement in car.js exactly. The wheelbase is NOT
    // symmetric — front 1.34, rear 1.32 — and treating it as ±1.35 leaves a
    // millimetric bias that there is no reason to carry.
    const AF = 1.34, AR = -1.32;
    const B = 0.93;                    // ARCH_W/2 - 0.14, from car.js
    const f = v.forward.clone(), r = v.right.clone();

    // Order: FL, FR, RL, RR — same order as car.js `wheels`.
    const off = [[AF, B], [AF, -B], [AR, B], [AR, -B]];
    const h = [0, 0, 0, 0];
    let onBridge = false;
    for (let i = 0; i < 4; i++) {
      const x = v.position.x + f.x * off[i][0] + r.x * off[i][1];
      const z = v.position.z + f.z * off[i][0] + r.z * off[i][1];
      const g = this.groundAt(x, z);
      h[i] = g.height;
      onBridge = onBridge || g.onBridge;
    }

    // Tilt from the plane through the patches, expressed in the car's own frame.
    const front = (h[0] + h[1]) * 0.5, rear = (h[2] + h[3]) * 0.5;
    const left = (h[0] + h[2]) * 0.5, right = (h[1] + h[3]) * 0.5;
    const pitchT = Math.atan2(front - rear, AF - AR);   // nose up on a climb
    const rollT = Math.atan2(left - right, 2 * B);

    // Low-pass the ANGLES only. Rates are high enough to track a real gradient
    // at speed and low enough to swallow facet-to-facet steps in the mesh.
    if (this._pose === undefined) this._pose = { y: h[0], pitch: pitchT, roll: rollT };
    const kA = 1 - Math.exp(-16 * Math.max(dt, 1e-5));
    this._pose.pitch += (pitchT - this._pose.pitch) * kA;
    this._pose.roll += (rollT - this._pose.roll) * kA;

    /**
     * RIDE HEIGHT IS SOLVED, NOT AVERAGED.
     *
     * It used to be the mean of the four contact heights. On any surface that is
     * not a perfect plane — every surface here, since the mesh is faceted on
     * purpose — the mean sits BELOW the highest patch, so the wheel on the high
     * side is inside the ground by construction. And because the angles are
     * low-passed while the mean was not, every metre of filter lag came straight
     * off the ride height as well.
     *
     * So: take the filtered tilt as given, and place the body at the lowest
     * height for which NO wheel is under its own ground. `dy` is where each
     * contact patch sits relative to the body origin at that tilt, so the
     * required origin height for wheel i is h[i] - dy[i] and the answer is the
     * largest of the four. On a twisted surface the car rides a couple of
     * centimetres proud on three wheels, which is invisible at this camera
     * height; the alternative is a wheel through the floor, which is not.
     *
     * MEASURED (tools/probe.mjs --only wheels): mean penetration 0.246 m and
     * 63.7% of samples deeper than 0.10 m came from this averaging alone, on top
     * of — and independent of — the pitch sign error in car.js.
     */
    const sp = Math.sin(this._pose.pitch), sr = Math.sin(this._pose.roll);
    let support = -Infinity;
    for (let i = 0; i < 4; i++) {
      const need = h[i] - (off[i][0] * sp + off[i][1] * sr);
      if (need > support) support = need;
    }

    /**
     * The body may rise instantly but must settle gently.
     *
     * That asymmetry is not a trick: ground can only push, so a surface coming
     * up under a wheel acts at once, while a surface falling away is followed at
     * the rate gravity and the springs allow. Filtering the rise as well is what
     * made the car swim through crests.
     */
    if (this._poseY === undefined || Math.abs(support - this._poseY) > 8) this._poseY = support;
    else if (support >= this._poseY) this._poseY = support;
    else this._poseY += (support - this._poseY) * (1 - Math.exp(-26 * Math.max(dt, 1e-5)));
    this._pose.y = this._poseY;

    // Airborne, the ballistic height owns Y — but never below the support, or a
    // wheel dips through the ground on the frame before the landing is detected.
    const y = v.onGround === false && this._carY !== undefined
      ? Math.max(this._carY, support)
      : this._pose.y;

    return { y, pitch: this._pose.pitch, roll: this._pose.roll, onBridge, contact: h, support };
  }

  /**
   * Ground under the car, for the physics step.
   *
   * Computed ONCE per fixed step and cached, because the view used to call this
   * again at render time with a different dt: the filters ran twice per frame at
   * two different rates, so the height the physics landed on and the height the
   * car was drawn at were never quite the same number.
   */
  carGroundAt(v, dt = 1 / 60) {
    const p = this._poseCache ?? this.carPose(v, dt);
    return { height: p.y, normal: UP.clone(), onBridge: p.onBridge, pose: p };
  }

  /**
   * Forget where the car was standing.
   *
   * `vehicle.reset()` moves the car; it knows nothing about the vertical state
   * that lives up here. Without this, a respawn keeps the pre-respawn altitude
   * and vertical velocity, so `_stepVertical` believes the car is still falling
   * from wherever it was rescued from and fires a landing event, complete with
   * camera shake, the instant it arrives. The pose filters keep the old tilt too.
   */
  resetPose() {
    this._carY = undefined;
    this._carVY = 0;
    this._pose = undefined;
    this._poseY = undefined;
    this._poseCache = undefined;
    this.carView?.resetSeating?.();
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

    /**
     * CONTACTS.
     *
     * `core/collision.js` owns the chassis shape, the contact impulse and the
     * material classes; this loop only turns its events into feel, audio and
     * shake. `hit.speed` is the CLOSING speed along the contact normal, which is
     * the same quantity the two hand-written loops that used to live here passed
     * to those systems.
     *
     * What that module replaced, and why none of it could be patched in place:
     * the car was a CIRCLE of radius 1.5 m, so a 4.2 m long chassis could not
     * tell a nose-on hit from a side-swipe and stopped dead on trees it visibly
     * cleared by 0.2 m; the response was applied at the centre of mass, so no
     * impact could ever spin the car; every prop was the same `velocity *= 0.45`
     * whether it was a sapling or a boulder; and resolution was a single
     * end-of-step overlap test, which at 40 m/s first sees a rail line when the
     * car is already 0.557 m through it — deeper than the beam is thick.
     */
    for (const hit of resolveCollisions(v, this.collisionWorld, dt)) {
      if (hit.speed < 6) continue;
      this.feel.event('impact', hit);
      this.audio.event('impact', hit);
      this.camera.addShake(Math.min(0.75, hit.speed * 0.035));
    }

    // ONE POSE PER STEP, and the vertical dynamics use the same support height
    // the wheels are drawn on. Physics used to run off the single ground sample
    // under the car's centre while the body was drawn from four contact patches,
    // so on any crest or camber the two disagreed and the wheels paid for it.
    this._poseCache = this.carPose(v, dt);

    this._stepVertical(dt);

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

  /**
   * VERTICAL DYNAMICS AND SLOPE.
   *
   * The car used to have NO vertical state at all: it was pinned to whatever
   * height the ground query returned. That is the root of most of what looks
   * wrong when you drive — the body and wheels appear to live independently
   * because nothing is actually resting on anything, there is no airtime over a
   * crest, no landing, and, worst of all, gradient costs nothing. That last one
   * is why the car could sit in a lake and calmly drive up a bank onto a road
   * several metres above it: there was no gravity to climb against.
   *
   * So: a real height, a real vertical velocity, and gravity resolved along the
   * ground plane so slopes have to be earned.
   */
  _stepVertical(dt) {
    const v = this.vehicle;
    const g = this.groundAt(v.position.x, v.position.z);
    // The height the WHEELS rest on, not the height under the car's navel. The
    // centre sample sits below the contact plane on every crest and camber, and
    // the gap between the two was the car's resting depth in the ground.
    // The slope, on the other hand, is still the ground's own — that is what a
    // gradient costs, and it is a property of the terrain, not of the wheelbase.
    /**
     * THE DYNAMICS REST ON THE CENTRE SAMPLE, NOT ON THE CONTACT-PATCH SUPPORT.
     *
     * `carPose` solves for the height at which no WHEEL is under the ground, and
     * that is the right height to DRAW the car at. It is the wrong height to
     * simulate at, and the difference is not academic: the support is a maximum
     * over four patches 2.7 m apart, so a car nosed into a 35 degree bank is
     * handed most of a metre of free altitude by its front wheels alone. It then
     * climbs the bank it should have slid off, meets the >0.53 slope bleed a few
     * lines below, and stops dead.
     *
     * MEASURED (tools/collide-live.mjs, 90 s of autopilot in alpine): resting the
     * dynamics on the support put the car under 3 m/s for 53.6% of the run and
     * ended it stationary on a 35 degree slope at (-126, 413). On the centre
     * sample the same drive never drops below 3 m/s at all and finishes at
     * 38.1 m/s. Draw from the patches, simulate from the point.
     */
    const ground = g.height;

    if (this._carY === undefined) { this._carY = ground; this._carVY = 0; }

    // Ballistic while airborne. 22 m/s^2 rather than 9.81: arcade jumps should
    // come down quickly or the car hangs like a balloon at this camera height.
    this._carVY -= 22 * dt;
    this._carY += this._carVY * dt;

    if (this._carY <= ground) {
      const impact = -this._carVY;
      this._carY = ground;
      this._carVY = 0;
      if (v.onGround === false && impact > 5) {
        this.feel.event('land', { speed: impact });
        this.audio.event('land', { speed: impact });
        this.camera.addShake(Math.min(0.6, impact * 0.02));
      }
      v.onGround = true;
    } else {
      v.onGround = false;
    }

    if (!v.onGround) return;   // no traction in the air, so no slope force

    // Gravity along the ground plane. For a unit normal n the downhill
    // direction in xz is (n.x, n.z) and its length is sin(slope), so this one
    // expression gives both the direction and the g*sin(theta) magnitude.
    const n = g.normal;
    const slope = Math.hypot(n.x, n.z);
    if (slope > 0.02) {
      const G = 9.81;
      v.velocity.x += n.x * G * dt;
      v.velocity.z += n.z * G * dt;

      // Beyond about 32 degrees the tyres cannot hold at all: bleed speed hard
      // so a steep bank is a wall, not a ramp. This is what stops the car
      // climbing out of a lake basin onto a road that sits well above it.
      if (slope > 0.53) {
        const over = Math.min(1, (slope - 0.53) / 0.30);
        v.velocity.multiplyScalar(1 - over * 3.2 * dt);
      }
    }

    // In water: heavy drag, so wading is slow and deliberate rather than a
    // shortcut across the map.
    const wl = this.biome?.waterLevel;
    if (wl !== undefined && ground < wl - 0.35) {
      v.velocity.multiplyScalar(1 - Math.min(0.9, 2.4 * dt));
      v.yawRate *= 1 - Math.min(0.9, 2.0 * dt);
      this.inWater = true;
    } else {
      this.inWater = false;
    }
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
    this.carView.update(scaled, v, this.carGroundAt(v, scaled), this._sampleHeight ??=
      (x, z) => this.groundAt(x, z).height);
    this.emitFx(scaled);
    this.skid.update(scaled);
    this.particles.update(scaled);
    this.water.update(scaled);
    this.animals.update(scaled, { position: v.position, speed: v.speed });
    this.roads.barriers?.update?.(scaled);   // tumbling fence debris

    this.feel.update(scaled, {
      vehicle: v, camera: this.camera, surface: this.surface,
      onRoad: this.surface?.kind === 'road', input,
    });
    this.audio.update(scaled, { vehicle: v, surface: this.surface });

    // Focus on the CAR, not on the ground under it.
    //
    // This used to track g.height, the terrain height at the car's position.
    // The moment the car dropped into a basin or a lake bed the focus fell with
    // the terrain, dragging the camera down until it was looking along the
    // road almost horizontally from a couple of metres up — the frame filled
    // with one blurred slab of road and the car was nowhere in it.
    //
    // The car's own height is smoothed and bounded; the terrain under it is
    // neither. Also clamp how far the focus may sit below the drivable surface
    // so a deep hole cannot swing the camera even if the car is in one.
    const carY = this._carY ?? g.height;
    const surfY = this.roads.heightAt?.(v.position.x, v.position.z) ?? g.height;
    const focusY = Math.max(carY, surfY - 6);
    const focus = new THREE.Vector3(v.position.x, focusY, v.position.z);
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

    // Counter-steer. A plain heading-error controller cannot hold a slide: the
    // car is pointing one way and travelling another, so chasing the heading
    // error alone sends it further sideways until it leaves the road. Steer
    // toward where the car is actually GOING (its slip angle) on top of the
    // path term, scaled by how sideways it is. This is what a driver does.
    const slip = v.slipAngle ?? 0;
    const slideness = Math.min(1, Math.abs(slip) / 0.45);
    const counter = -slip * 1.35 * slideness;

    const steer = THREE.MathUtils.clamp(
      err * 1.9 * aggression + counter - v.yawRate * (0.22 + 0.5 * slideness),
      -1, 1
    );

    // ---- speed control ----------------------------------------------------
    // Holding full throttle into a hairpin at 130 km/h puts the car in the
    // trees every time, which is why captures kept ending up off-road. Read the
    // corner ahead and slow for it the way a driver would: compare the heading
    // of a near and a far look-ahead point, turn that into a corner radius, and
    // cap the speed at what the surface can hold.
    const near = this.roads.lookAhead?.(v.position.x, v.position.z, lead);
    const far = this.roads.lookAhead?.(v.position.x, v.position.z, lead + 55);
    let throttle = opts.throttle ?? 1;
    let brake = opts.brake ?? 0;

    if (near && far && brake === 0) {
      let turn = far.heading - near.heading;
      while (turn > Math.PI) turn -= Math.PI * 2;
      while (turn < -Math.PI) turn += Math.PI * 2;

      // radius = arc length / angle, floored so a straight does not divide by ~0
      const radius = 55 / Math.max(Math.abs(turn), 0.02);
      const grip = (this.surface?.grip ?? 0.85) * 9.81 * 2.8;
      const vMax = Math.sqrt(Math.max(4, grip * radius));

      if (speed > vMax * 1.06) { throttle = 0; brake = Math.min(1, (speed / vMax - 1) * 2.2); }
      else if (speed > vMax * 0.94) { throttle *= 0.35; }
    }

    return {
      throttle,
      brake,
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
