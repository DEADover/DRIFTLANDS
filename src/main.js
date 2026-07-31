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

  // A capture is a fixed number of steps from a fixed pose. The auto-rescue in
  // game.js may not fire inside one — a teleport mid-warm-up would change what
  // the shot is of. Cleared afterwards so a harness that boots this page and
  // then drives the game itself (every tool in tools/) still gets rescued.
  game.noRescue = true;

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
  game.noRescue = false;
  game.render();
  game.render(); // second pass so shader compiles never land in the capture

  window.__SHOT_INFO = { preset: preset.id, biome: preset.biome, t: warmup, ...game.stats() };
  window.__SHOT_READY = true;
} else {
  // -------------------------------------------------------------- interactive
  const game = new Game(container, uiRoot);
  window.__GAME = game;
  game.loadBiome(params.get('biome') ?? 'alpine');

  // The music module knows nothing about the HUD and the HUD knows nothing about
  // where audio comes from; this line is the whole of the coupling.
  game.music.onTrack?.((t) => game.hud?.setTrack(t));

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
    // Same gesture, same moment: a browser will not let any audio play before
    // one, and the race beginning is exactly when the music should.
    game.music.start?.();
    window.removeEventListener('keydown', onAnyKey);
  };
  const onAnyKey = (e) => { if (e.code !== 'Tab') start(); };
  document.getElementById('play')?.addEventListener('click', start);
  window.addEventListener('keydown', onAnyKey);

  /**
   * Respawn on the route. At this camera height it is easy to end up in a lake
   * or wedged somewhere with no way to tell what went wrong, and a demo must
   * never dead-end.
   *
   * The act itself lives on the game (`respawnCar`), because the auto-rescue
   * that used to sit a few lines below this one now lives there too — see
   * § THE RESCUE BELONGS TO THE SIMULATION in game.js. It was rescuing the
   * player and no headless harness in the project, which meant every audit we
   * have taken could be quietly distorted by a car that stopped moving.
   */
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR') game.respawnCar();
    // Biome switching is deliberately NOT bound. This build is a single-world
    // demo; the other biomes exist in the codebase but none of them has had the
    // art pass alpine has, so offering them would only show unfinished work.
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
