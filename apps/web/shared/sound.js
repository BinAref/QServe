/**
 * Sound engine (spec §20, §21).
 *
 * Alerts are synthesised with the Web Audio API rather than shipped as files.
 * That is a deliberate choice for an offline product: nothing to download,
 * nothing to lose in a backup, and every tone is defined by data that a
 * restaurant can later replace with its own recording — `playFor` accepts a
 * `url:` asset key, so custom sounds need no code change.
 *
 * Repetition and "keep alerting until acknowledged" are handled here, so a
 * cook who has walked away from the pass still hears the order.
 */

const RECIPES = {
  'builtin:chime':     [{ f: 880,  d: 0.12 }, { f: 1320, d: 0.18 }],
  'builtin:new-order': [{ f: 660,  d: 0.14 }, { f: 880,  d: 0.14 }, { f: 1180, d: 0.22 }],
  'builtin:ready':     [{ f: 1180, d: 0.12 }, { f: 880,  d: 0.20 }],
  'builtin:urgent':    [{ f: 980,  d: 0.10 }, { f: 740,  d: 0.10 }, { f: 980, d: 0.10 }, { f: 740, d: 0.18 }],
  'builtin:success':   [{ f: 700,  d: 0.10 }, { f: 1050, d: 0.16 }],
  'builtin:error':     [{ f: 320,  d: 0.18 }, { f: 240,  d: 0.26 }],
  'builtin:alert':     [{ f: 520,  d: 0.16 }, { f: 520,  d: 0.16 }],
};

export class SoundEngine {
  #context = null;
  #profile = { enabled: false, masterVolume: 0.8, bindings: {} };
  #repeating = new Map();
  #unlocked = false;

  setProfile(profile) {
    if (profile) this.#profile = { bindings: {}, ...profile };
  }

  get profile() {
    return this.#profile;
  }

  /**
   * Browsers refuse to make noise before a user gesture. Every terminal calls
   * this on the first tap; until then alerts are silent, which is why kitchen
   * screens show a one-time "tap to enable sound" prompt.
   */
  unlock() {
    if (this.#unlocked) return true;
    try {
      this.#context = this.#context ?? new (window.AudioContext ?? window.webkitAudioContext)();
      void this.#context.resume();
      this.#unlocked = this.#context.state === 'running';
    } catch {
      this.#unlocked = false;
    }
    return this.#unlocked;
  }

  get unlocked() {
    return this.#unlocked;
  }

  /** Play the sound bound to a logical event, honouring its repeat settings. */
  playFor(soundEvent) {
    const binding = this.#profile.bindings?.[soundEvent];
    if (!this.#profile.enabled || !binding) return null;

    this.stop(soundEvent);

    const play = () => this.#playAsset(binding.asset, binding.volume);
    play();

    const repeats = binding.untilAcknowledged
      ? Number.POSITIVE_INFINITY
      : Math.max(1, binding.repeatCount ?? 1);

    if (repeats > 1) {
      let played = 1;
      const timer = setInterval(() => {
        played += 1;
        play();
        if (played >= repeats) this.stop(soundEvent);
      }, Math.max(400, binding.repeatIntervalMs ?? 1500));
      this.#repeating.set(soundEvent, timer);
    }
    return soundEvent;
  }

  /** Silence a repeating alert — what "acknowledge" does on a kitchen screen. */
  stop(soundEvent) {
    const timer = this.#repeating.get(soundEvent);
    if (timer) {
      clearInterval(timer);
      this.#repeating.delete(soundEvent);
    }
  }

  stopAll() {
    for (const soundEvent of [...this.#repeating.keys()]) this.stop(soundEvent);
  }

  get isAlerting() {
    return this.#repeating.size > 0;
  }

  #playAsset(asset, volume = 0.8) {
    if (!this.#unlocked || !this.#context) return;

    // A restaurant's own recording, dropped in later, plays through the same path.
    if (typeof asset === 'string' && asset.startsWith('url:')) {
      const audio = new Audio(asset.slice(4));
      audio.volume = Math.min(1, (volume ?? 1) * this.#profile.masterVolume);
      void audio.play().catch(() => {});
      return;
    }

    const recipe = RECIPES[asset] ?? RECIPES['builtin:chime'];
    const gainPeak = Math.min(1, (volume ?? 0.8) * (this.#profile.masterVolume ?? 1)) * 0.35;
    let at = this.#context.currentTime;

    for (const note of recipe) {
      const oscillator = this.#context.createOscillator();
      const gain = this.#context.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.f, at);

      // Short attack and exponential decay: a clean "ding" rather than a click.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(gainPeak, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.d);

      oscillator.connect(gain).connect(this.#context.destination);
      oscillator.start(at);
      oscillator.stop(at + note.d + 0.02);
      at += note.d;
    }
  }
}

export const AVAILABLE_SOUNDS = Object.keys(RECIPES);
export const sound = new SoundEngine();
