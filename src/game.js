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
import { createJump } from './world/jump.js';
import { Vehicle } from './entities/vehicle.js';
import { CarView } from './entities/car.js';
import { createAnimals } from './entities/animals.js';
import { SkidMarks } from './fx/skidmarks.js';
import { ParticleSystem } from './fx/particles.js';
import { createFeel } from './fx/feel.js';
import { createAudio } from './audio/audio.js';
import { createMusic } from './audio/music.js';
import { Hud } from './ui/hud.js';
import { resolveCollisions } from './core/collision.js';
import { createRace } from './core/race.js';

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
    // The player's own soundtrack, from the music/ folder. Separate from the
    // engine synth on purpose — see the note at the top of audio/music.js.
    this.music = createMusic();

    this.hud = uiRoot ? new Hud(uiRoot) : null;
    // Laps, timing and the results table. Owns its own key and overlay; the
    // shell only has to honour its pause and let it see the car each step.
    this.race = createRace();
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

    // BEFORE the props: the ford's bed is carved into the terrain, and anything
    // scattered first would end up standing in the stream.
    this.jump = createJump({ ...ctx, roads: this.roads, water: this.water });
    this.worldGroup.add(this.jump.group);

    const blocked = (x, z) =>
      this.roads.isBlocked(x, z) || this.bridges.isBlocked(x, z)
      || this.landmarks.isBlocked(x, z) || this.jump.isBlocked(x, z);

    this.props = new PropScatter(this.terrain, palette, biome, seed + 11);
    this.worldGroup.add(this.props.build(blocked));

    this.animals = createAnimals({ ...ctx, roads: this.roads });
    this.worldGroup.add(this.animals.group);

    this.colliders = [
      ...this.props.colliders,
      ...this.bridges.colliders,
      ...this.landmarks.colliders,
      // roads.js publishes sign posts and the marker boards at hairpins and
      // NOTHING WAS READING THEM. They were built, drawn and documented, and the
      // collision grid never saw one: the boards a car meets when it runs wide
      // out of a hairpin were scenery you drove straight through.
      ...(this.roads.colliders ?? []),
      // The start gantry's posts and marker boards.
      ...(this.race.colliders ?? []),
    ];
    this._buildColliderGrid();
    // The barrier set is rebuilt with the roads, so the collision world has to
    // be re-pointed at it; everything else it needs is reached through closures
    // that survive the swap.
    /**
     * ONE BARRIER VIEW OVER TWO OWNERS.
     *
     * roads.js publishes the road's fences and guardrails; bridges.js now
     * publishes its parapets, which until this round were drawn and not solid —
     * so three of five spans let the car leave the deck at speed with no
     * collision event at all and fall 8.5 to 11.3 m into the lake.
     *
     * The solver takes one `barriers`, so this composes them. Bridge rails are
     * `guard`: `hit()` is never true for them, exactly as for the road's steel,
     * so the id space only has to be unambiguous for the breakable ones — and
     * those are all roads'. Bridge ids are offset clear of them anyway.
     */
    const roadBarriers = this.roads.barriers;
    const bridgeRails = (this.bridges.rails ?? []).map((r, i) => ({ ...r, id: -1 - i }));
    this.collisionWorld.barriers = {
      get segments() { return roadBarriers.segments.concat(bridgeRails); },
      hit: (id, load) => (id >= 0 ? roadBarriers.hit(id, load) : false),
      update: (dt) => roadBarriers.update?.(dt),
    };

    this.carView.setHeadlights(palette.sunElevation < 0.18);

    const spawn = this.roads.spawn() ?? this.findSpawn();
    this.vehicle.reset(spawn.x, spawn.z, spawn.heading);
    // The gate is sited from the route, so it can only be built once the roads
    // and bridges are up; attach re-sites it and resets the ledger.
    this.race.attach(this);

    /**
     * AND THE CAR STARTS ON THE LINE.
     *
     * startline.js sites the gate 15 to 48 m AHEAD of `roads.spawn()`, so that
     * lap 1 is a full circuit like the other four rather than a short one. That
     * is right for the table and wrong for the player, who was left staring at
     * `TO THE LINE` and driving fifty metres of nothing before the clock even
     * started.
     *
     * Both can be true: keep the gate where it is and move the CAR to it. Four
     * metres back along the gate's own forward direction — a car length, so it
     * begins wholly behind the line and the very first crossing is unambiguous,
     * and close enough that the clock starts within a few tenths of the flag.
     */
    const gate = this.race.gate;
    if (gate) {
      const BACK = 4.0;
      const heading = Math.atan2(-gate.fz, gate.fx);
      this.vehicle.reset(gate.x - gate.fx * BACK, gate.z - gate.fz * BACK, heading);
      this.resetPose();
      this.race.attach(this);      // re-seed the crossing test at the new position
    }
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
    let road = this.roads.heightAt?.(x, z);
    // THE JUMP CROWN JOINS THE ROAD, NOT THE BRIDGE.
    //
    // It is an embankment built ON the carriageway, so it is simply the topmost
    // drawn surface there and belongs in the same max. It must NOT go in the
    // deck branch: that branch returns a hard UP normal, and a jump ramp is
    // nothing but gradient — with UP the car would climb the 1:4 face for free
    // and get nothing back down the landing.
    const ramp = this.jump?.heightAt(x, z);
    if (ramp != null && (road == null || ramp > road)) road = ramp;

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
    let road = this.roads.heightAt?.(x, z);
    // THE JUMP CROWN JOINS THE ROAD, NOT THE BRIDGE.
    //
    // It is an embankment built ON the carriageway, so it is simply the topmost
    // drawn surface there and belongs in the same max. It must NOT go in the
    // deck branch: that branch returns a hard UP normal, and a jump ramp is
    // nothing but gradient — with UP the car would climb the 1:4 face for free
    // and get nothing back down the landing.
    const ramp = this.jump?.heightAt(x, z);
    if (ramp != null && (road == null || ramp > road)) road = ramp;


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
    // `let`, because the airborne branch below replaces both — see the note there.
    let pitchT = Math.atan2(front - rear, AF - AR);   // nose up on a climb
    let rollT = Math.atan2(left - right, 2 * B);

    /**
     * IN THE AIR THERE ARE NO CONTACT PATCHES, AND THIS IS THE "NON-WORKING JUMP".
     *
     * `pitchT` above is the plane through four ground samples 2.7 m apart. That is
     * the right answer on the ground and it is NONSENSE in the air, because the
     * ground it samples is whatever happens to be scrolling past 3 m below the
     * car. TRACED over the real driven flight (tools/jump-trace.mjs, the
     * `jump_alpine` autopilot drive, frame for frame):
     *
     *   wall 106.583  on the lip      pitch  -1.78°
     *   wall 106.767  0.05 s airborne pitch -14.15°   <- NOSE DOWN off the ramp
     *   wall 107.400  mid-flight      pitch  +5.21°
     *   wall 108.183  falling         pitch  -7.22°
     *
     * The car dives its nose 14 degrees at the exact instant it leaves the lip —
     * the front patches drop into the ford while the rears are still on the crown
     * — and then wanders with the terrain underneath for the rest of the flight.
     * Nothing in that sequence is a jump. Height was never the problem: the apex
     * measures 3.18 m and the client still calls the take-off non-working, because
     * from 140 m up the eye reads ROTATION, not altitude, and this rotation was
     * both backwards and uncorrelated with the flight.
     *
     * So while ballistic, the attitude comes from the TRAJECTORY: the flight-path
     * angle atan2(vy, v_horizontal), which is nose-up by construction on the way
     * up, passes through level at the apex, and is nose-down on the way in. It
     * needs no knowledge of the jump module and it is right for a launch off any
     * crest, a drop off a bank, or a fall down a hillside.
     *
     * GAIN 2.0, CLAMPED TO 24°. The raw flight-path angle of the design jump is
     * +10.6° off the lip and -15.4° at touchdown: a 26° swing spread over 0.9 s,
     * on a body that is 90 px long on screen. Doubling it gives +21°/-24°, a 45°
     * swing, which at this camera visibly opens the underside on the way up and
     * buries the nose on the way down. It is a lie about the moment of inertia and
     * an honest one about the trajectory, which is the only thing the player is
     * being told.
     *
     * ROLL RELAXES. The bank a car is carrying when it leaves the ground has
     * nothing holding it up, so it unwinds over the flight rather than tracking
     * facets it is nowhere near — and a level roll is what makes the pitch read.
     *
     * IT IS WEIGHTED BY HEIGHT, NOT SWITCHED ON `ballisticAir`, AND THAT MATTERS.
     * `ballisticAir` is true for a large fraction of ordinary fast driving: traced
     * over the same lap, the flag flickers on for runs of eight to sixteen frames
     * at a time with the car 0.02-0.34 m off the road — real micro-hops off facet
     * crests, correctly reported. Swinging the whole car's attitude on those would
     * flatten its camber on every rough straight, which is a regression dressed as
     * a feature. So the flight attitude fades in between 0.25 m and 1.00 m of
     * daylight: a 0.34 m hop gets 12% of it and is imperceptible, the design jump
     * is fully committed 0.09 s after the lip and stays there for 3.18 m of apex.
     *
     * THE BLEND IS ASYMMETRIC: 22/s while committed (a launch is a snap) against
     * the ground's own 16/s, and the fast rate is held for a sixth of a second
     * after touchdown so the nose-down attitude survives the landing and the car
     * visibly slams level. At the landing frame slow motion is still at 0.40, so
     * those two dozen degrees play over about 0.4 s of wall clock. THAT is the
     * visible compression — 0.30 m of body squat is six pixels at this camera and
     * could never have been it.
     */
    const gTop = Math.max(h[0], h[1], h[2], h[3]);
    const airH = (this._carY ?? gTop) - gTop;
    const airW = THREE.MathUtils.clamp((airH - 0.25) / 0.75, 0, 1);
    if (airW > 0) {
      const vh = Math.hypot(v.velocity.x, v.velocity.z);
      const flight = vh > 1 ? Math.atan2(this._carVY ?? 0, vh) : 0;
      const pitchAir = THREE.MathUtils.clamp(flight * 2.0, -0.42, 0.42);
      pitchT += (pitchAir - pitchT) * airW;
      rollT += (0 - rollT) * airW;
    }

    // Low-pass the ANGLES only. Rates are high enough to track a real gradient
    // at speed and low enough to swallow facet-to-facet steps in the mesh.
    if (this._pose === undefined) this._pose = { y: h[0], pitch: pitchT, roll: rollT };
    // 0.16 s of the fast rate after the last committed airborne frame, so the
    // slam-to-level is not swallowed by the ground filter it lands into.
    this._airPose = airW > 0.5 ? 0.16 : Math.max(0, (this._airPose ?? 0) - dt);
    const rate = (airW > 0.5 || this._airPose > 0) ? 22 : 16;
    const k = 1 - Math.exp(-rate * Math.max(dt, 1e-5));
    this._pose.pitch += (pitchT - this._pose.pitch) * k;
    this._pose.roll += (rollT - this._pose.roll) * k;

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

    // `airW` is published because car.js needs the SAME committed-flight weight
    // for the suspension droop; two independent notions of "is it flying" would
    // disagree on exactly the frames where it matters.
    return { y, pitch: this._pose.pitch, roll: this._pose.roll, onBridge, contact: h, support, airW };
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
      // 1.8, down from 6, because the chain ceiling went from x6 to x100.
      //
      // Left alone, a maxed chain would have scored sixteen times faster than
      // before and made every other part of the stage irrelevant by arithmetic
      // rather than by design. Cutting the base moves the reward decisively into
      // CONTINUITY: a casual slide now banks about a third of what it used to,
      // and a chain held to the top of the ladder banks five times the old
      // maximum. That spread is the point of raising the ceiling at all.
      this.driftScore += v.driftAngle * v.speed * dt * 1.8 * (this.feel.chainMultiplier ?? 1);
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
   *
   * ---------------------------------------------------------------------------
   * LAUNCH: A RAMP HAS TO THROW THE CAR, AND A BUMP MUST NOT
   *
   * The clamp below used to write `_carVY = 0` on every grounded frame, so a car
   * arrived at the lip of a ramp with EXACTLY zero vertical velocity and the
   * ramp's angle contributed nothing whatsoever. Measured before this change
   * (tools/jump-test.mjs): apex over the take-off lip 0.00 m at every approach
   * speed from 15.8 to 39.6 m/s. That is not a jump, it is a horizontal throw off
   * a ledge, and it is exactly why there was no feeling of flight.
   *
   * The fix is one quantity: the rate at which the ground under the wheels is
   * RISING. A car following a surface climbing at `rise/dt` already has that much
   * vertical velocity; the old clamp threw it away every frame. Carry it, and the
   * instant the surface stops climbing — the lip — the car keeps it and leaves.
   * No impulse, no special case for the jump module, no new force: a ramp
   * launches because a ramp is a rising surface that ends.
   *
   * WHICH MAKES EVERY CREST IN THE WORLD A LAUNCHER, and most of them must not
   * be. Two gates separate a built ramp from a bumpy road, and both are needed:
   *
   *   STEEP     — the rise per metre travelled must exceed `LAUNCH_GRADE`. This
   *               is speed-independent, which matters: a bump should not become
   *               a ramp merely because you hit it faster.
   *   SUSTAINED — and it must have been that steep CONTINUOUSLY for
   *               `LAUNCH_RISE` metres of gained height. One steep facet is a
   *               bump; two thirds of a metre of unbroken climb is an earthwork.
   *
   * THAT SEPARATES A RAMP FROM A BUMP. IT DOES NOT SEPARATE A RAMP FROM A HILL,
   * AND IT SHOULD NOT. Measured (tools/jump-test.mjs --control, 150 s of
   * flat-out autopilot over the whole alpine route with the jump's footprint
   * excluded): the gate opens 23 times, and only twice does the climb behind it
   * throw the car at more than 4 m/s — both on the same feature, a carriageway
   * that climbs at 0.17 for eight metres and gains 1.35 m doing it. A car
   * cresting that at 125 km/h leaves the ground at 7.4 m/s, and it should; that
   * is a rally stage. What it never does is skip: the share of the drive spent
   * off the ground is 24.25% after against 24.80% before, i.e. slightly LESS,
   * because a car that follows the ground up also lands where the ground put it.
   *
   * The SPECTACLE needs a stricter test than the physics does, and it gets one
   * at the point of separation — see the note down there.
   * ---------------------------------------------------------------------------
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

    if (this._carY === undefined) {
      this._carY = ground; this._carVY = 0;
      // resetPose() clears `_carY`, so this is also the respawn path: forget the
      // ramp the car was climbing before it was rescued.
      this._prevGround = ground; this._rampRise = 0; this._rampGate = 0;
      this._airborne = false;
    }

    // ---- how fast the ground itself is moving under the wheels -------------
    // `rise` is the change in the surface the car is standing on, which on a
    // slope is the car's own travel across it. `grade` is that per metre driven,
    // so it is the surface's gradient along the line the car is actually taking.
    const rise = ground - this._prevGround;
    this._prevGround = ground;
    const run = Math.hypot(v.velocity.x, v.velocity.z) * dt;
    const grade = run > 1e-4 ? rise / run : 0;
    /**
     * Anything steeper than this is a STEP, not a surface.
     *
     * The car flies over a 15.5 m hole in the earthwork and the ground sample
     * under it is the carriageway the whole way; the far bank's sill then appears
     * as 0.30 m of rise in one 0.33 m step, a grade of 0.9. Fed to the landing
     * softener below that reads as ground rushing up at 36 m/s and turns a gentle
     * touchdown into a 47 m/s impact. 0.60 is just past `_stepVertical`'s own
     * 0.53 traction wall — steeper than the car can hold anyway — so nothing that
     * can legitimately be driven is excluded.
     */
    const GRADE_MAX = 0.60;
    // `noLaunch` is the diagnostic switch tools/jump-test.mjs flips to reproduce
    // the pre-launch build exactly, so the before/after table is one binary
    // measuring itself rather than two builds measuring each other.
    const surfaceVY = !this.noLaunch && Math.abs(grade) <= GRADE_MAX ? rise / dt : 0;

    // Ballistic while airborne. 22 m/s^2 rather than 9.81: arcade jumps should
    // come down quickly or the car hangs like a balloon at this camera height.
    this._carVY -= 22 * dt;
    this._carY += this._carVY * dt;

    const wasAir = this._airborne === true;

    if (this._carY <= ground) {
      /**
       * IMPACT IS A CLOSING SPEED, NOT A FALL SPEED.
       *
       * It used to be `-_carVY`, which is only right when the thing you land on
       * is level. A car coming down at 11 m/s onto a run-out that is itself
       * falling away at 5 m/s meets it at 6, and that difference is the whole
       * reason a landing ramp exists. With real launch velocities in the model
       * the fall speeds roughly doubled, so this term is what keeps the landing
       * from becoming brutal: measured on the design jump, 11.2 m/s of fall
       * arrives as 6.3 m/s of impact on the run-out.
       */
      const impact = -(this._carVY - surfaceVY);
      this._carY = ground;

      // Continuous steep climb, in metres of height gained. Broken by any step
      // that is not steep — a ramp is unbroken, a rough road is not.
      const LAUNCH_GRADE = 0.155;
      const LAUNCH_RISE = 0.62;      // where the gate starts to open
      const LAUNCH_FADE = 0.30;      // and where it is fully open
      if (grade >= LAUNCH_GRADE && grade <= GRADE_MAX) this._rampRise += rise;
      else this._rampRise = 0;
      this._rampGate = THREE.MathUtils.clamp(
        (this._rampRise - LAUNCH_RISE) / LAUNCH_FADE, 0, 1,
      );
      // THE ONE LINE THAT MAKES A RAMP A RAMP. Ungated this is `0` and every
      // number in the build is exactly what it was before.
      this._carVY = this._rampGate > 0 ? Math.max(0, surfaceVY) * this._rampGate : 0;

      if (wasAir && impact > 5) {
        this.feel.event('land', { speed: impact });
        this.audio.event('land', { speed: impact });
        this.camera.addShake(Math.min(0.6, impact * 0.02));
      }
      v.onGround = true;
      /**
       * AND THE FLAG THAT IS ACTUALLY TRUE.
       *
       * `onGround` is written twice per step — vehicle.updateVertical sets it
       * from the SUSPENSION and this clamp sets it from the ballistics — and the
       * suspension's copy is the one a later reader sees. Measured over this
       * jump: `v.onGround` reads `true` for the whole 0.9 s flight, with the car
       * 3.11 m above the ground at the apex. Anything downstream that needs to
       * know whether the wheels are on the surface (fx/feel.js holds slow motion
       * on exactly that question) has to read a flag nothing else touches.
       */
      v.ballisticAir = false;
      this._airborne = false;
    } else {
      /**
       * SEPARATION — and the second, tighter gate, the one the SPECTACLE hangs
       * off. Slow motion and fireworks must not fire on a road crest.
       *
       * The launch gate above cannot tell them apart and should not try: over a
       * 150 s autopilot lap the route's own carriageway throws the car at
       * 7.35 m/s off a bank at (-33, 181) and 6.29 m/s off another at (-67, 254),
       * against the built ramp's 7.43. The two are indistinguishable by launch
       * velocity, by grade and by sustained rise.
       *
       * What separates them is what is BEHIND the lip. A built take-off ends in a
       * drop; a hill rolls over. So the discriminator is the hole the car is
       * suddenly standing over at the instant of separation: 1.49 m at the ramp,
       * 0.03 m at both of those crests. 0.80 m sits between them with room to
       * spare and needs no knowledge of the jump module at all — any future ramp
       * on any stage earns its fireworks the same way. MEASURED over the same
       * 150 s lap: one celebration, on the ramp, and zero anywhere else.
       *
       * (A bridge deck is level and reports a hard UP normal, so it cannot make
       * rise — but the ramp state can survive onto one, so it is excluded too.)
       */
      const drop = this._carY - ground;
      if (!wasAir && this._rampGate > 0.5 && this._carVY > 2.5 && drop > 0.80 && !g.onBridge) {
        this.feel.event('jump', { vy: this._carVY, speed: v.speed, drop, y: this._carY });
      }
      this._rampRise = 0;
      this._rampGate = 0;
      v.onGround = false;
      v.ballisticAir = true;
      this._airborne = true;
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
    // PAUSE STOPS THE SIMULATION, NOT THE RENDERER. render() is called from the
    // frame loop separately, so the world stays on screen behind the table.
    if (this.race.paused) return;
    /**
     * THE ACCUMULATOR MAY NEVER GO NEGATIVE, AND IT HAD.
     *
     * MEASURED on a running page: `accumulator = -5.86`, i.e. seven hundred
     * fixed steps in debt. The loop below only runs while it is at or above
     * FIXED_DT, so once it is negative NOTHING STEPS EVER AGAIN — simTime frozen
     * at 0, the car at 0.00 m/s with the throttle wide open, and a world that
     * renders perfectly while being completely dead. That is the worst shape a
     * bug can have: the picture looks fine.
     *
     * It only takes ONE negative `scaled` to get there and there is no way back,
     * because the recovery has to climb out at real time. Both inputs are now
     * pinned: a time scale cannot be negative (it is a rate, and the slow-motion
     * easing added this round is the obvious way one could transiently go under
     * zero), and dt cannot be either. The clamp on the accumulator itself is the
     * belt to that pair of braces — whatever future code gets this wrong, the
     * simulation keeps running.
     */
    const ts = Math.max(0, this.feel.timeScale ?? 1);
    const scaled = Math.max(0, dt) * ts;
    this.accumulator = Math.max(0, this.accumulator + Math.min(scaled, 0.1));
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
    this.race.update(this);
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
