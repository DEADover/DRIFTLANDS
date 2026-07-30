import { createStartLine } from '../world/startline.js';
import { createResults } from '../ui/results.js';

/**
 * RACE — laps, lap times, per-lap drift, and the end of the stage.
 *
 * CONTRACT (called by game.js — four lines, see the block at the bottom):
 *   createRace()                 -> Race          (constructed once, in the shell)
 *   race.attach(game)            build the gate into game.worldGroup, reset state
 *   race.update(game)            once per frame, AFTER the sim has stepped
 *   race.paused                  boolean — game.update() must return early on it
 *
 * Also public, for anything that wants to read the race rather than run it:
 *   race.state       'staging' | 'running' | 'finished'
 *   race.laps        [{ n, time, drift }]   completed laps, in order
 *   race.lapTime     seconds elapsed in the current lap (0 while staging)
 *   race.totals      { time, drift, best }  best is the 1-based index of the
 *                                           quickest lap, or 0
 *   race.gate        the line, from world/startline.js
 *   race.colliders   the two gantry posts
 *   race.toggleTable() / openTable() / closeTable() / restart()
 *
 * ---------------------------------------------------------------------------
 * HOW A LAP IS DETECTED, AND WHY IT IS NOT A RADIUS TEST
 *
 * A circle around the start point is wrong in both directions at once. At
 * 40 m/s a frame is 0.67 m, so the car can be inside a 6 m circle for ten
 * consecutive frames — every one of which looks like "arrived" — and a car that
 * takes a wide line misses the circle entirely and never scores the lap it just
 * drove. Neither problem has a threshold that fixes it: shrink the radius and
 * you lose more laps, grow it and you double-count more.
 *
 * So the gate is a real LINE SEGMENT across the road, and the test is a
 * SEGMENT-SEGMENT crossing between where the car was last frame and where it is
 * now:
 *
 *     s = (p - G) . f          signed distance along the route direction
 *     u = (p - G) . a          offset across the line
 *
 * A crossing is a sign change in s between the two samples, with the |u| of the
 * interpolated crossing point inside the gate's half-length. That is exactly
 * one event per pass, at any speed, from any line across the road, and it comes
 * with the fraction of the frame at which it happened — so lap times are
 * sub-frame accurate and the five of them sum to the total exactly.
 *
 * BACKWARDS COUNTS AS UN-LAPPING, and it does so because the alternative is
 * exploitable. If a backward crossing were merely ignored, a driver could sit
 * on the line, reverse over it and drive forward again to bank a "lap" every
 * three seconds. Un-lapping makes the ledger signed: net laps can never exceed
 * net forward passes, whatever order they happen in. Concretely, a backward
 * crossing pops the most recent completed lap off the table and resumes it —
 * the clock and the drift bucket are restored to that lap's own start, so the
 * driver has to go round and earn it again. This is what a real timing loop
 * does when a car reverses through the beam: the lap is voided, not credited.
 *
 * THE BACKSTOP IS GEOMETRIC, NOT TEMPORAL.
 *
 * A minimum LAP TIME cannot be right here: it has to be below the quickest lap
 * anyone might drive, so it is always far too generous to stop the thing it is
 * for (a car parked across the line), and if it is ever wrong it eats a real
 * lap. What actually rules out a straddle is that the car never went anywhere.
 * So a crossing is only acted on if the car has been at least AWAY_MIN metres
 * from the gate since the last one it acted on. 60 m is chosen against two
 * measurements: the gate's own half-length is at most 16 m, so no amount of
 * wobbling on the line reaches it; and the alpine route is 3577 m round, so a
 * real lap exceeds it by a factor of sixty. It is speed-independent, which a
 * time guard is not.
 */

const MAX_LAPS = 5;
const AWAY_MIN = 60;            // metres — see the essay above

/** The key that opens the table. Free: W A S D, SPACE, R, M, N, H, P, [ ] - = and Tab are taken. */
const TABLE_KEY = 'KeyL';       // L for LAPS

export function createRace(opts = {}) {
  return new Race(opts);
}

export class Race {
  constructor({ lapsTotal = MAX_LAPS } = {}) {
    this.lapsTotal = lapsTotal;
    this.state = 'staging';
    this.laps = [];
    this.gate = null;
    this.colliders = [];
    this.group = null;
    this.results = null;
    this.tableOpen = false;
    this.capture = false;
    this.key = TABLE_KEY;

    // Diagnostics — tools/race-test.mjs reads these.
    this.crossings = 0;         // net forward passes of the line
    this.rejected = 0;          // crossings dropped by the away guard
    this.ignoredAfterFinish = 0;
    this.unlaps = 0;

    this._reset();
  }

  // -------------------------------------------------------------------------
  _reset() {
    this.state = 'staging';
    this.laps = [];
    this.crossings = 0;
    this.rejected = 0;
    this.ignoredAfterFinish = 0;
    this.unlaps = 0;
    this.raceStartT = 0;
    this.finishT = 0;
    this.lapStartT = 0;
    this.lapStartDrift = 0;
    this.driftTotal = 0;        // every point of drift ever banked, cumulative
    this._prevDriftTotal = 0;
    this._prevScore = 0;
    this._prev = null;          // {x, z, t}
    this._away = Infinity;      // armed, so the very first crossing always counts
    this._nowT = 0;
  }

  /**
   * Build the gate for the world that has just been loaded and start a new race.
   *
   * Called from the END of game.loadBiome, after `roads.spawn()` has been used
   * to place the car: the gate is positioned relative to that spawn, so it has
   * to be built after it, and it goes into `worldGroup` so the next
   * `loadBiome` disposes of it with everything else.
   */
  attach(game) {
    this.capture = !!game.capture;
    const line = createStartLine({
      roads: game.roads,
      terrain: game.terrain,
      bridges: game.bridges,
      palette: game.palette,
      biome: game.biome,
    });
    this.group = line.group;
    this.gate = line.gate;
    this.colliders = line.colliders;
    game.worldGroup.add(line.group);

    this._reset();
    this._prev = { x: game.vehicle.position.x, z: game.vehicle.position.z, t: game.simTime };
    this._prevScore = game.driftScore ?? 0;

    // A capture is a deterministic screenshot, not a session: no key handler, no
    // overlay, and `paused` is never true, so nothing here can freeze a shot.
    if (!this.capture && typeof window !== 'undefined') {
      if (!this.results) {
        this.results = createResults({
          onRestart: () => { this.closeTable(); this.restart(game); },
          onClose: () => this.closeTable(),
          key: 'L',
        });
      }
      if (!this._onKey) {
        this._onKey = (e) => {
          if (e.repeat) return;
          if (e.code === TABLE_KEY) { this.toggleTable(); e.preventDefault(); }
          else if (e.code === 'Escape' && this.tableOpen) { this.closeTable(); }
          else if (e.code === 'Enter' && this.tableOpen && this.state === 'finished') {
            this.closeTable(); this.restart(game);
          }
        };
        window.addEventListener('keydown', this._onKey);
      }
      this._game = game;
    }
    this._pushHud(game);
  }

  dispose() {
    if (this._onKey && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKey);
      this._onKey = null;
    }
    this.results?.dispose?.();
  }

  // -------------------------------------------------------------------- pause
  /**
   * PAUSE IS A FLAG THE SHELL HONOURS, NOT SOMETHING THE UI DOES.
   *
   * The overlay never touches the loop. game.js returns early from `update`
   * while this is true, so the simulation stops advancing — `simTime` included,
   * which is what every deterministic clock in the build is keyed off — and
   * main.js goes on calling `render()`, so the frame behind the table stays
   * live rather than freezing into a still.
   */
  get paused() {
    return !this.capture && this.tableOpen;
  }

  openTable() {
    if (this.capture) return;
    this.tableOpen = true;
    this.results?.open(this.model());
  }

  closeTable() {
    this.tableOpen = false;
    this.results?.close();
  }

  toggleTable() {
    if (this.tableOpen) this.closeTable();
    else this.openTable();
  }

  /**
   * Back to the line. The race ending at five laps must not dead-end, so this
   * is reachable from the results table (a button, or Enter) and does the whole
   * job: car on the route, vertical state forgotten, marks and dust cleared,
   * live drift zeroed, ledger empty.
   */
  restart(game = this._game) {
    if (!game) return;
    // Always unpause. The table is open and the sim frozen whenever a race has
    // just finished, which is the commonest way anyone reaches this method — if
    // restart left `tableOpen` alone the world would stay stopped behind a
    // fresh, empty results table and the stage really would dead-end.
    this.closeTable();
    const s = game.roads.spawn?.() ?? game.findSpawn();
    game.vehicle.reset(s.x, s.z, s.heading);
    game.resetPose?.();
    game.skid?.clear?.();
    game.particles?.clear?.();
    game.driftScore = 0;
    game.bestDrift = 0;
    game.camera?.calmShake?.();
    this._reset();
    this._prev = { x: game.vehicle.position.x, z: game.vehicle.position.z, t: game.simTime };
    this._prevScore = 0;
    this._pushHud(game);
  }

  // ------------------------------------------------------------------- update
  /**
   * One sample per frame. Called from the end of game.update(), so `simTime`
   * has already absorbed this frame's fixed steps and the vehicle is where the
   * renderer is about to draw it.
   */
  update(game) {
    if (!this.gate) return;
    const v = game.vehicle;
    const x = v.position.x, z = v.position.z, t = game.simTime;
    this._nowT = t;

    /**
     * DRIFT, BUCKETED — NOT RE-SCORED.
     *
     * game.driftScore is the LIVE score of the slide in progress: it climbs
     * while `isDrifting` and decays at exp(-2.2 dt) the moment it is not, so it
     * is not a running total and cannot be differenced across a lap boundary.
     * What IS a running total is the sum of its RISES. Taking only the positive
     * part of the frame-to-frame change reproduces exactly the points game.js
     * accumulated — chain multiplier and all — without this file knowing
     * anything about slip angles or fx/feel.js's multiplier, and it stays right
     * if either of those is retuned. The decay contributes nothing, which is
     * correct: a slide that fades away was still driven.
     */
    const score = game.driftScore ?? 0;
    this._prevDriftTotal = this.driftTotal;
    if (score > this._prevScore) this.driftTotal += score - this._prevScore;
    this._prevScore = score;

    const p0 = this._prev;
    this._prev = { x, z, t };
    if (!p0) return;

    const g = this.gate;

    /**
     * A TELEPORT IS NOT A CROSSING.
     *
     * main.js binds R to a respawn and runs an auto-rescue watchdog that puts a
     * submerged or wedged car back on the route after five seconds; neither
     * tells this module anything. Both move the car hundreds of metres between
     * one sample and the next, and the segment they draw can pass straight
     * through the gate — in the wrong direction as often as the right one, so a
     * rescue could un-lap you.
     *
     * The threshold is 12 m per frame. main.js clamps dt to 0.05 s, and the car
     * tops out well under 60 m/s, so a driven frame is at most about 3 m; 12 m
     * asks for 240 m/s, which nothing in this build can do.
     *
     * The away guard is also zeroed, which is the anti-cheat half: the gate sits
     * 15-48 m past the spawn, so a car respawned just before the line has not
     * been AWAY_MIN from the gate and the crossing that follows is dropped. You
     * cannot rescue yourself into a free lap; you drive the loop again, and the
     * crossing at the end of it counts normally.
     */
    if (Math.hypot(x - p0.x, z - p0.z) > 12) {
      this._away = 0;
      this._pushHud(game);
      return;
    }

    const d = Math.hypot(x - g.x, z - g.z);
    if (d > this._away) this._away = d;

    // Signed distance along the direction of travel, before and after.
    const s0 = (p0.x - g.x) * g.fx + (p0.z - g.z) * g.fz;
    const s1 = (x - g.x) * g.fx + (z - g.z) * g.fz;
    if ((s0 < 0) === (s1 < 0)) { this._pushHud(game); return; }
    if (s1 === s0) { this._pushHud(game); return; }

    // Where on the line it happened, and when.
    const frac = (0 - s0) / (s1 - s0);
    const cx = p0.x + (x - p0.x) * frac;
    const cz = p0.z + (z - p0.z) * frac;
    const u = (cx - g.x) * g.ax + (cz - g.z) * g.az;
    if (Math.abs(u) > g.half) { this._pushHud(game); return; }

    if (this._away < AWAY_MIN) { this.rejected++; this._pushHud(game); return; }

    const tCross = p0.t + (t - p0.t) * frac;
    const driftCross = this._prevDriftTotal
      + (this.driftTotal - this._prevDriftTotal) * frac;
    this._away = 0;

    if (s1 > s0) this._forward(tCross, driftCross);
    else this._backward(tCross, driftCross);

    this._pushHud(game);
  }

  _forward(tCross, driftCross) {
    if (this.state === 'finished') { this.ignoredAfterFinish++; return; }

    if (this.state === 'staging') {
      // THE FIRST PASS STARTS THE RACE, IT DOES NOT COMPLETE A LAP.
      //
      // The gate sits 15-48 m AHEAD of where game.js parks the car (see
      // world/startline.js), so the car stages behind the line and the clock
      // starts when it goes through. That is the only arrangement in which all
      // five laps are the same distance — one full circuit each — which is the
      // whole point of putting them in a table next to each other.
      this.state = 'running';
      this.crossings = 1;
      this.raceStartT = tCross;
      this.lapStartT = tCross;
      this.lapStartDrift = driftCross;
      return;
    }

    this.crossings++;
    this.laps.push({
      n: this.laps.length + 1,
      time: tCross - this.lapStartT,
      drift: driftCross - this.lapStartDrift,
      _startT: this.lapStartT,
      _startDrift: this.lapStartDrift,
    });
    this.lapStartT = tCross;
    this.lapStartDrift = driftCross;

    if (this.laps.length >= this.lapsTotal) {
      this.state = 'finished';
      this.finishT = tCross;
      this.openTable();
    }
  }

  _backward() {
    // A finished race is finished; the ledger is closed and reversing through
    // the beam cannot reopen it.
    if (this.state === 'finished') { this.ignoredAfterFinish++; return; }
    if (this.state !== 'running') return;

    this.unlaps++;
    this.crossings--;
    if (this.laps.length === 0) {
      // Backwards out of lap 1 puts the car behind the line again, which is
      // where it started. Un-start rather than leave a lap running that the
      // driver is no longer on.
      this.state = 'staging';
      this.crossings = 0;
      this.lapStartT = 0;
      this.lapStartDrift = 0;
      return;
    }
    const last = this.laps.pop();
    this.lapStartT = last._startT;
    this.lapStartDrift = last._startDrift;
  }

  // -------------------------------------------------------------------- model
  get lapTime() {
    if (this.state === 'staging') return 0;
    if (this.state === 'finished') return 0;
    return Math.max(0, this._nowT - this.lapStartT);
  }

  get lapDrift() {
    if (this.state !== 'running') return 0;
    return Math.max(0, this.driftTotal - this.lapStartDrift);
  }

  get totals() {
    let time = 0, drift = 0, best = 0, bestT = Infinity;
    for (const l of this.laps) {
      time += l.time;
      drift += l.drift;
      if (l.time < bestT) { bestT = l.time; best = l.n; }
    }
    let bestD = 0, bestDv = -Infinity;
    for (const l of this.laps) if (l.drift > bestDv) { bestDv = l.drift; bestD = l.n; }
    return { time, drift, best, bestDrift: bestD };
  }

  /** Everything the results table and the HUD need, in one plain object. */
  model() {
    const T = this.totals;
    return {
      state: this.state,
      lapsTotal: this.lapsTotal,
      lap: Math.min(this.lapsTotal, this.laps.length + (this.state === 'running' ? 1 : 0)),
      laps: this.laps.map((l) => ({ n: l.n, time: l.time, drift: l.drift })),
      lapTime: this.lapTime,
      lapDrift: this.lapDrift,
      totals: T,
      key: 'L',
    };
  }

  _pushHud(game) {
    game.hud?.setRace?.(this.model());
    if (this.tableOpen) this.results?.update?.(this.model());
  }
}

/**
 * WIRING (game.js, four lines):
 *
 *   import { createRace } from './core/race.js';
 *
 *   // constructor, after `this.hud = ...`
 *   this.race = createRace();
 *
 *   // end of loadBiome(), after `this.vehicle.reset(...)`
 *   this.race.attach(this);
 *
 *   // first line of update(dt, input)
 *   if (this.race.paused) return;
 *
 *   // last line of update(dt, input)
 *   this.race.update(this);
 *
 * OPTIONAL fifth line — makes the two gantry posts solid, in loadBiome's
 * `this.colliders = [...]` list:
 *
 *   ...(this.race.colliders ?? []),
 *
 * They stand outside the drawn earthworks, so without it they are scenery you
 * can drive through; nothing else depends on it.
 */
