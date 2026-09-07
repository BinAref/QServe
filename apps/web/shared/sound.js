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

/**
 * The built-in alerts, as notes rather than files.
 *
 * These are heard a hundred times a shift, which is the only design constraint
 * that matters: a tone that is merely *noticeable* becomes a tone that is muted
 * by Wednesday. So they are built like small bells — a struck partial over a
 * fundamental, decaying — and they use intervals from the same major scale, so
 * that eight hours of them sound like one instrument rather than eight alarms.
 *
 *   f     frequency in Hz
 *   d     how long the note lasts, seconds
 *   gap   silence after it; a rest is what makes a phrase rather than a run
 *   bell  strike a fifth above as well, which reads as warm rather than thin
 */
const A4 = 440;
const NOTE = (semitonesFromA4) => Math.round(A4 * 2 ** (semitonesFromA4 / 12));

const RECIPES = {
  // Two rising notes, quiet: "something happened, at your convenience".
  'builtin:chime': [
    { f: NOTE(4), d: 0.10, bell: true },
    { f: NOTE(11), d: 0.34, bell: true },
  ],
  // Three rising notes: unmistakably an arrival, without being an alarm.
  'builtin:new-order': [
    { f: NOTE(-1), d: 0.10 },
    { f: NOTE(4), d: 0.10 },
    { f: NOTE(9), d: 0.40, bell: true },
  ],
  // Falling: the phrase a human uses for "here you are". Carries across a pass.
  'builtin:ready': [
    { f: NOTE(12), d: 0.12, bell: true },
    { f: NOTE(7), d: 0.36, bell: true },
  ],
  // Somebody is asking for you. Two knocks, spaced like a person knocking.
  'builtin:call': [
    { f: NOTE(9), d: 0.09 },
    { f: NOTE(9), d: 0.28, gap: 0.06, bell: true },
  ],
  // Urgent is faster and lower, not louder: loudness is the volume control's
  // job, and a shrill alert is the one people disable.
  'builtin:urgent': [
    { f: NOTE(7), d: 0.09 },
    { f: NOTE(2), d: 0.09 },
    { f: NOTE(7), d: 0.09 },
    { f: NOTE(2), d: 0.26 },
  ],
  'builtin:success': [
    { f: NOTE(4), d: 0.08 },
    { f: NOTE(9), d: 0.08 },
    { f: NOTE(16), d: 0.30, bell: true },
  ],
  // Low and short. An error tone should sound like a door closing, not a buzzer.
  'builtin:error': [
    { f: NOTE(-8), d: 0.14 },
    { f: NOTE(-13), d: 0.30 },
  ],
  'builtin:alert': [
    { f: NOTE(2), d: 0.13 },
    { f: NOTE(2), d: 0.24, gap: 0.05 },
  ],
};

export class SoundEngine {
  #context = null;
  #profile = { enabled: false, masterVolume: 0.8, bindings: {} };
  #repeating = new Map();
  #unlocked = false;
  #muted = false;

  setProfile(profile) {
    if (profile) this.#profile = { bindings: {}, ...profile };
  }

  /**
   * The restaurant's own switch, above every station's profile: a dining room
   * that wants silence gets silence, whatever each tablet was configured with.
   * Anything already repeating stops now rather than at its next interval.
   */
  setMuted(muted) {
    this.#muted = Boolean(muted);
    if (this.#muted) this.stopAll();
  }

  get muted() { return this.#muted; }

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
    if (this.#muted || !this.#profile.enabled || !binding) return null;

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
    const level = Math.min(1, (volume ?? 0.8) * (this.#profile.masterVolume ?? 1));

    // A gentle low-pass takes the glassy edge off a synthesised tone, which is
    // the difference between a sound somebody can hear all day and one they
    // turn off after an hour.
    const filter = this.#context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 3200;
    const master = this.#context.createGain();
    master.gain.value = level * 0.32;
    filter.connect(master).connect(this.#context.destination);

    let at = this.#context.currentTime + 0.01;

    for (const note of recipe) {
      this.#strike(note.f, at, note.d, 1, filter);
      // A quiet fifth above the fundamental. Nobody hears it as a second note;
      // they hear the first one as warmer.
      if (note.bell) this.#strike(note.f * 1.5, at, note.d * 0.7, 0.28, filter);
      at += note.d + (note.gap ?? 0);
    }
  }

  /** One struck note: instant attack, long decay, like something hit once. */
  #strike(frequency, at, duration, weight, destination) {
    const oscillator = this.#context.createOscillator();
    const gain = this.#context.createGain();

    // Triangle over sine: a little more body, still nothing harsh.
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(frequency, at);

    // 8ms attack avoids the click of an instant start; the exponential tail is
    // what makes it read as a struck object rather than a switched-on tone.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(weight, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    oscillator.connect(gain).connect(destination);
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }
}

export const AVAILABLE_SOUNDS = Object.keys(RECIPES);
export const sound = new SoundEngine();
