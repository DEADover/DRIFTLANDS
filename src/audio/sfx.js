/**
 * PLAYER SFX — optional engine samples, from the `sfx/` folder.
 *
 * CONTRACT:
 *   createSfx() -> {
 *     names            [string]              which slots the folder filled
 *     load(ctx)        -> Promise<void>      fetch + decode, once
 *     get(name)        -> { buffer, refRpm } | null
 *     hasEngine        boolean               true once an engine_* slot decoded
 *   }
 *
 * WHY THIS EXISTS. The synth in audio.js is the product and stands on its own —
 * the project ships no asset files and generates everything, which is what keeps
 * it self-contained and its licensing simple. But a client who owns a licensed
 * engine recording should be able to use it WITHOUT a code change, and the
 * music/ folder had already established how that is done here. Same mechanism,
 * same reason: Vite's `import.meta.glob` expands at transform time into a
 * literal map of the files present and re-expands when the folder changes, so
 * dropping a WAV in and letting the dev server reload is the whole procedure.
 * No manifest, no fetch of an index that can go stale, works the same in a
 * production build.
 *
 * THE SLOTS. Base filename before any extension or suffix:
 *
 *   engine_idle       closed throttle, low revs — a steady idle loop
 *   engine_onload     wide open throttle — a steady loop, one gear, no shifts
 *   engine_overrun    trailing throttle at speed, crackle and all
 *   shift             one-shot, upshift
 *   shift_down        one-shot, downshift (falls back to `shift`)
 *
 * Any subset. Providing `engine_onload` alone is enough to take the engine off
 * the synth; the missing states fall back to the nearest slot that is present.
 *
 * THE ENGINE LOOPS MUST BE STEADY-STATE AND SEAMLESS, because they are played
 * back at a varying rate to follow the revs — the whole rev range comes from
 * one recording, which is how every driving game does this. A loop with a shift
 * or a rev change inside it will be audibly stretched.
 *
 * REFERENCE RPM. Playback rate is crank rpm divided by the rpm the sample was
 * recorded at, so that number has to be known. State it in the filename:
 *
 *   engine_onload@4200rpm.wav
 *
 * Without the suffix, DEFAULT_REF_RPM below is assumed, and a sample recorded
 * somewhere else will simply be transposed — audible, not fatal.
 *
 * Formats: whatever the browser will decode. wav, mp3, ogg, m4a, aac, flac,
 * webm, opus.
 *
 * FAILURE IS ALWAYS SILENT AND ALWAYS FALLS BACK TO THE SYNTH. A file that will
 * not decode is reported once to the console and skipped. There is no state in
 * which a bad drop in sfx/ leaves the game without an engine.
 */

const FILES = import.meta.glob('/sfx/*.{wav,mp3,ogg,oga,m4a,aac,flac,webm,opus}', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** Assumed recording speed when the filename does not say. */
const DEFAULT_REF_RPM = 3000;

const SLOTS = ['engine_idle', 'engine_onload', 'engine_overrun', 'shift', 'shift_down'];

/**
 * `/sfx/engine_onload@4200rpm.wav` -> { slot: 'engine_onload', refRpm: 4200 }
 * Unknown slots are ignored rather than guessed at, so a stray file in the
 * folder cannot end up wired to the engine.
 */
function parseName(path) {
  const base = (path.split('/').pop() ?? path).replace(/\.[a-z0-9]+$/i, '');
  const m = /^(.*?)(?:@(\d+)\s*rpm)?$/i.exec(base);
  const slot = (m?.[1] ?? base).trim().toLowerCase();
  if (!SLOTS.includes(slot)) return null;
  return { slot, refRpm: m?.[2] ? Number(m[2]) : DEFAULT_REF_RPM };
}

export function createSfx() {
  return new Sfx();
}

class Sfx {
  constructor() {
    this.entries = new Map();          // slot -> { url, refRpm, buffer|null }
    for (const [path, url] of Object.entries(FILES)) {
      const p = parseName(path);
      // First one wins, so two files claiming a slot is not a coin toss.
      if (p && !this.entries.has(p.slot)) this.entries.set(p.slot, { url, refRpm: p.refRpm, buffer: null });
    }
    this.names = [...this.entries.keys()];
    this.hasEngine = false;
    this._loaded = false;
  }

  /**
   * Fetch and decode everything the folder offered. Called once, from the same
   * gesture that starts the engine; never awaited by the caller, because the
   * synth is already playing and the samples take over when and if they arrive.
   */
  async load(ctx) {
    if (this._loaded || !this.entries.size) return;
    this._loaded = true;
    await Promise.all([...this.entries].map(async ([slot, e]) => {
      try {
        const res = await fetch(e.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        e.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (err) {
        console.warn(`[sfx] cannot use ${slot}:`, err?.message ?? err);
        this.entries.delete(slot);
      }
    }));
    this.names = [...this.entries.keys()];
    this.hasEngine = this.names.some((n) => n.startsWith('engine_'));
  }

  /**
   * A slot's buffer, following the documented fallbacks so callers do not each
   * reimplement them: any engine slot stands in for any other, and a downshift
   * falls back to the upshift sample.
   */
  get(name) {
    const direct = this.entries.get(name);
    if (direct?.buffer) return direct;
    const alt = name === 'shift_down' ? ['shift']
      : name.startsWith('engine_') ? ['engine_onload', 'engine_idle', 'engine_overrun']
      : [];
    for (const a of alt) {
      const e = this.entries.get(a);
      if (e?.buffer) return e;
    }
    return null;
  }
}
