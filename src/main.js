import { Game } from './game.js';
import { BIOME_IDS } from './world/biomes.js';
import { KeyboardInput, TapeInput } from './core/input.js';
import { PRESETS } from './capture/presets.js';

const container = document.getElementById('app');
const uiRoot = document.getElementById('ui');
const params = new URLSearchParams(location.search);
const shotId = params.get('shot');

if (shotId) {
  // ------------------------------------------------------------------ capture
  const preset = PRESETS[shotId];
  if (!preset) throw new Error(`Unknown capture preset: ${shotId}`);

  // The title overlay must never appear in a capture: its darkening gradient
  // lands on every pixel and silently wrecks every measurement taken from the
  // shot. (It cost one round's readings before this was spotted.)
  document.getElementById('title')?.remove();

  const showHud = params.get('hud') !== '0';
  const game = new Game(container, showHud ? uiRoot : null, { capture: true });
  window.__GAME = game;

  game.loadBiome(preset.biome, preset.seed);
  game.cameraZoom = preset.camera?.zoom ?? 1;
  if (preset.camera?.pitchDeg) game.camera.pitch = (preset.camera.pitchDeg * Math.PI) / 180;

  const tape = new TapeInput(preset.tape);
  const dt = 1 / 60;
  // `?t=` overrides the preset's settle time. Shooting one preset at several
  // values of t gives a motion sequence — the only way to judge a drift from
  // stills.
  const warmup = params.has('t') ? Number(params.get('t')) : preset.warmup;
  const frames = Math.round(warmup / dt);
  for (let i = 0; i < frames; i++) {
    // A preset either scripts its inputs, or hands steering to the route
    // autopilot and only scripts throttle/handbrake on top of it.
    const scripted = tape.sample();
    const input = preset.autopilot
      ? game.autopilotInput({
          throttle: scripted.throttle,
          brake: scripted.brake,
          handbrake: scripted.handbrake,
          aggression: preset.autopilot.aggression,
        })
      : scripted;
    tape.advance(dt);
    game.update(dt, input);
  }
  game.render();
  game.render(); // second pass so shader compiles never land in the capture

  window.__SHOT_INFO = { preset: preset.id, biome: preset.biome, t: warmup, ...game.stats() };
  window.__SHOT_READY = true;
} else {
  // -------------------------------------------------------------- interactive
  const game = new Game(container, uiRoot);
  window.__GAME = game;
  game.loadBiome(params.get('biome') ?? 'alpine');

  const kb = new KeyboardInput();

  /**
   * Title screen. The world is already rendering behind it, so the backdrop is
   * the live game. Starting on a click (or any key) also supplies the user
   * gesture WebAudio requires before an AudioContext is allowed to run — doing
   * it here means the engine note is there from the first metre.
   */
  let started = false;
  const titleEl = document.getElementById('title');
  const start = () => {
    if (started) return;
    started = true;
    titleEl?.classList.add('gone');
    game.audio.start?.();
    window.removeEventListener('keydown', onAnyKey);
  };
  const onAnyKey = (e) => { if (e.code !== 'Tab') start(); };
  document.getElementById('play')?.addEventListener('click', start);
  window.addEventListener('keydown', onAnyKey);

  /**
   * Respawn on the route. Also used to rescue the player: at this camera height
   * it is easy to end up in a lake or wedged somewhere with no way to tell what
   * went wrong, and a demo must never dead-end.
   */
  const respawn = () => {
    const s = game.roads.spawn?.() ?? game.findSpawn();
    game.vehicle.reset(s.x, s.z, s.heading);
    game.resetPose();            // vertical + pose state lives on the game, not the vehicle
    game.skid.clear();
    game.particles.clear();
    game.driftScore = 0;
    game.camera.calmShake?.();   // a crash must not follow you through a respawn
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR') respawn();
    // Biome switching is deliberately NOT bound. This build is a single-world
    // demo; the other biomes exist in the codebase but none of them has had the
    // art pass alpine has, so offering them would only show unfinished work.
  });

  // Auto-rescue: if the car is submerged or stuck for a few seconds, put it back
  // on the road rather than leaving the player stranded.
  let stuckFor = 0;
  const watchdog = (dt, input) => {
    const v = game.vehicle;
    const g = game.groundAt(v.position.x, v.position.z);
    const submerged = g.height < (game.biome.waterLevel ?? -Infinity) - 0.5;
    // Only "stuck" if the player is ASKING to move and nothing is happening.
    // Parking to look at the view must never teleport you.
    const wedged = v.speed < 1.2 && (input.throttle > 0 || input.brake > 0);
    stuckFor = (submerged || wedged) ? stuckFor + dt : 0;
    if (stuckFor > 5) { respawn(); stuckFor = 0; }
  };

  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const input = kb.sample();
    game.update(dt, input);
    watchdog(dt, input);
    game.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
