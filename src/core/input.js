// Input abstraction. Real keyboard in play mode; a scripted deterministic tape
// in capture mode so screenshots reproduce exactly.

export const NEUTRAL = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: 0,
  reset: false,
});

export class KeyboardInput {
  constructor(target = window) {
    this.keys = new Set();
    this._down = (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    };
    this._up = (e) => this.keys.delete(e.code);
    this._blur = () => this.keys.clear();
    target.addEventListener('keydown', this._down, { passive: false });
    target.addEventListener('keyup', this._up);
    target.addEventListener('blur', this._blur);
  }

  has(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  sample() {
    const left = this.has('KeyA', 'ArrowLeft');
    const right = this.has('KeyD', 'ArrowRight');
    return {
      throttle: this.has('KeyW', 'ArrowUp') ? 1 : 0,
      brake: this.has('KeyS', 'ArrowDown') ? 1 : 0,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      handbrake: this.has('Space') ? 1 : 0,
      reset: this.has('KeyR'),
    };
  }

  dispose() {
    window.removeEventListener('keydown', this._down);
    window.removeEventListener('keyup', this._up);
    window.removeEventListener('blur', this._blur);
  }
}

/**
 * Deterministic input tape: a list of [untilSeconds, partialInput] segments.
 * Used by capture presets to drive the car into a known state (mid-drift, etc).
 */
export class TapeInput {
  constructor(segments = []) {
    this.segments = segments;
    this.t = 0;
  }
  advance(dt) {
    this.t += dt;
  }
  sample() {
    for (const [until, input] of this.segments) {
      if (this.t < until) return { ...NEUTRAL, ...input };
    }
    return { ...NEUTRAL };
  }
}
