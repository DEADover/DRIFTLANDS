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
    const input = tape.sample();
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
  const startAudio = () => { game.audio.start?.(); window.removeEventListener('keydown', startAudio); };
  window.addEventListener('keydown', startAudio);

  window.addEventListener('keydown', (e) => {
    const idx = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(e.code);
    if (idx >= 0 && BIOME_IDS[idx]) game.loadBiome(BIOME_IDS[idx]);
    if (e.code === 'KeyR') {
      const s = game.roads.spawn?.() ?? game.findSpawn();
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
