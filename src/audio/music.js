/**
 * PLAYER MUSIC — your own soundtrack, from the `music/` folder.
 *
 * CONTRACT:
 *   createMusic() -> {
 *     tracks            [{ name, url }]   whatever is in music/, sorted by name
 *     start()                             begin playback; needs a user gesture
 *     next() / prev()                     change track
 *     toggle()                            pause / resume
 *     setEnabled(on)                      follows the global mute key
 *     volumeUp() / volumeDown()
 *     onTrack(fn)                         called with ({ name, index, count })
 *   }
 *
 * WHY AN <audio> ELEMENT AND NOT THE WEBAUDIO GRAPH.
 *
 * audio.js synthesises the engine: a dozen oscillators, filters and noise
 * sources hanging off one master gain, rebuilt from scratch on start(). Feeding
 * a decoded MP3 through that graph would mean sharing its lifecycle, its mute,
 * its suspend/resume and its failure modes with a system whose whole job is to
 * be reconstructed at will — and a music track that dies because a tyre-squeal
 * node threw is a bad trade. An <audio> element streams, seeks, survives a
 * context failure, and costs nothing while paused.
 *
 * HOW THE FOLDER IS READ.
 *
 * A browser cannot list a directory, so something has to enumerate it at build
 * time. Vite's `import.meta.glob` does exactly that: it expands at transform
 * time into a literal map of the files present, and it re-expands when the
 * folder changes, so dropping an MP3 into `music/` and letting the dev server
 * reload is genuinely all a player has to do. No manifest to hand-edit, no
 * fetch of a JSON index that can go stale, and it works identically in a
 * production build because the files are emitted as assets.
 */

const FILES = import.meta.glob('/music/*.{mp3,ogg,oga,m4a,aac,wav,flac,webm}', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** Human-readable track name from a path: strip folders, extension and hash. */
function prettyName(path) {
  const base = path.split('/').pop() ?? path;
  return base
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildList() {
  return Object.entries(FILES)
    .map(([path, url]) => ({ name: prettyName(path), url }))
    // Sorted by name so the order is the player's own, not the bundler's.
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function createMusic() {
  return new Music();
}

class Music {
  constructor() {
    this.tracks = buildList();
    this.index = 0;
    this.enabled = true;
    this.started = false;
    this.volume = 0.55;          // under the engine on purpose; it is a game, not a player
    this._el = null;
    this._listeners = [];
    this._failed = false;
    /** Tracks that would not decode; each is reported and skipped once. */
    this._failedUrls = new Set();
  }

  get current() {
    const t = this.tracks[this.index];
    return t ? { name: t.name, index: this.index, count: this.tracks.length } : null;
  }

  onTrack(fn) { if (typeof fn === 'function') this._listeners.push(fn); }

  _emit() {
    const c = this.current;
    for (const fn of this._listeners) {
      try { fn(c); } catch { /* a HUD bug must never stop the music */ }
    }
  }

  /**
   * Start playing. MUST be called from a user gesture — the same click or
   * keypress that dismisses the title screen and starts the engine audio, which
   * is exactly when a race begins.
   *
   * Silently does nothing when the folder is empty. That is the normal state of
   * a fresh checkout and is not an error.
   */
  async start() {
    if (this.started || this._failed || !this.tracks.length) return;
    try {
      const el = new window.Audio();
      el.preload = 'auto';
      el.volume = this.enabled ? this.volume : 0;
      // One track at a time, advancing on its own. `loop` is deliberately off:
      // with several tracks the player expects a playlist, and with exactly one
      // `ended` wraps straight back to it anyway.
      el.addEventListener('ended', () => this.next());
      // A file that will not decode must not end the playlist: skip it and say
      // so, rather than leaving the player in silence wondering.
      //
      // GUARDED, because a freshly constructed <audio> has src === '' and
      // Chromium fires `error` on that empty load the moment a listener exists.
      // Measured: without the guard the game opened on track 2 of 2 — the first
      // track was skipped every single time, by an error that had nothing to do
      // with the file. So an error only counts when it names the track we
      // actually asked for, and each track may fail exactly once, or a playlist
      // of unplayable files would spin through itself forever.
      el.addEventListener('error', () => {
        const failed = el.currentSrc || el.src;
        const want = this.tracks[this.index]?.url;
        if (!failed || !want || !failed.endsWith(want)) return;
        if (this._failedUrls.has(want)) return;
        this._failedUrls.add(want);
        console.warn('[music] cannot play', this.tracks[this.index]?.name);
        if (this._failedUrls.size >= this.tracks.length) return;   // nothing left to try
        this.next();
      });
      this._el = el;
      this.started = true;

      window.addEventListener('keydown', (e) => this._onKey(e));
      await this._play(this.index);
    } catch (err) {
      this._failed = true;
      console.warn('[music] disabled:', err);
    }
  }

  _onKey(e) {
    // Never steal a key while the player is typing somewhere, and never fight
    // a browser shortcut.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.code) {
      case 'BracketRight': this.next(); break;
      case 'BracketLeft': this.prev(); break;
      case 'KeyP': this.toggle(); break;
      case 'Equal': case 'NumpadAdd': this.volumeUp(); break;
      case 'Minus': case 'NumpadSubtract': this.volumeDown(); break;
      // The global mute key owns the music too — it says "mute", not "mute the
      // engine". audio.js keeps its own flag; both read the same key, and both
      // are installed at the same moment, so they cannot drift apart.
      case 'KeyN': this.setEnabled(!this.enabled); break;
      default: return;
    }
  }

  async _play(i) {
    const t = this.tracks[i];
    if (!this._el || !t) return;
    this.index = i;
    this._el.src = t.url;
    this._emit();
    try {
      await this._el.play();
    } catch {
      // Autoplay was refused — the gesture did not count, or the tab is hidden.
      // Leave it cued; the next keypress will start it.
    }
  }

  next() {
    if (!this.tracks.length) return;
    this._play((this.index + 1) % this.tracks.length);
  }

  prev() {
    if (!this.tracks.length) return;
    this._play((this.index - 1 + this.tracks.length) % this.tracks.length);
  }

  toggle() {
    if (!this._el || !this.started) return;
    if (this._el.paused) this._el.play().catch(() => {});
    else this._el.pause();
    this._emit();
  }

  get paused() { return !this._el || this._el.paused; }

  setEnabled(on) {
    this.enabled = !!on;
    if (this._el) this._el.volume = this.enabled ? this.volume : 0;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this._el && this.enabled) this._el.volume = this.volume;
    this._emit();
  }

  volumeUp() { this.setVolume(this.volume + 0.1); }
  volumeDown() { this.setVolume(this.volume - 0.1); }
}
