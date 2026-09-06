/**
 * Sound and alert model (spec §20, §21).
 *
 * Sounds are never hard-coded. Each terminal stores a `SoundProfile`; the
 * client resolves a `SoundEvent` to a file through that profile, so a restaurant
 * can drop in custom audio without a code change.
 */

export const SoundEvent = {
  NEW_ORDER: 'new_order',
  ORDER_READY: 'order_ready',
  ORDER_URGENT: 'order_urgent',
  ORDER_CANCELLED: 'order_cancelled',
  PAYMENT_SUCCESS: 'payment_success',
  PAYMENT_FAILED: 'payment_failed',
  NOTIFICATION: 'notification',
  ERROR: 'error',
} as const;
export type SoundEvent = (typeof SoundEvent)[keyof typeof SoundEvent];

export const SOUND_EVENTS = Object.values(SoundEvent);

export interface SoundBinding {
  /** Asset key resolved against the sound library (built-in or uploaded). */
  readonly asset: string;
  /** 0..1 */
  readonly volume: number;
  /** How many times to play. Ignored when `untilAcknowledged` is true. */
  readonly repeatCount: number;
  /** Milliseconds between repeats. */
  readonly repeatIntervalMs: number;
  /** Keep alerting until a human acknowledges the event (spec §21). */
  readonly untilAcknowledged: boolean;
}

export interface SoundProfile {
  readonly enabled: boolean;
  /** Master gain applied on top of each binding's volume. 0..1 */
  readonly masterVolume: number;
  readonly bindings: Readonly<Partial<Record<SoundEvent, SoundBinding>>>;
}

export const DEFAULT_SOUND_BINDING: SoundBinding = {
  asset: 'builtin:chime',
  volume: 0.8,
  repeatCount: 1,
  repeatIntervalMs: 1500,
  untilAcknowledged: false,
};

/**
 * Defaults per terminal type. A kitchen alert repeats until acknowledged
 * because a cook may be away from the screen; a cashier success tone does not.
 */
export function defaultSoundProfile(terminalType: string): SoundProfile {
  const b = (over: Partial<SoundBinding>): SoundBinding => ({ ...DEFAULT_SOUND_BINDING, ...over });

  switch (terminalType) {
    case 'KITCHEN':
    case 'KDS':
    case 'BAR':
      return {
        enabled: true,
        masterVolume: 1,
        bindings: {
          [SoundEvent.NEW_ORDER]: b({ asset: 'builtin:new-order', untilAcknowledged: true }),
          [SoundEvent.ORDER_URGENT]: b({ asset: 'builtin:urgent', repeatCount: 3 }),
          [SoundEvent.ORDER_CANCELLED]: b({ asset: 'builtin:alert' }),
          [SoundEvent.ERROR]: b({ asset: 'builtin:error' }),
        },
      };
    case 'CASHIER':
      return {
        enabled: true,
        masterVolume: 0.9,
        bindings: {
          [SoundEvent.NEW_ORDER]: b({ asset: 'builtin:new-order' }),
          [SoundEvent.PAYMENT_SUCCESS]: b({ asset: 'builtin:success' }),
          [SoundEvent.PAYMENT_FAILED]: b({ asset: 'builtin:error', repeatCount: 2 }),
          [SoundEvent.ORDER_CANCELLED]: b({ asset: 'builtin:alert' }),
        },
      };
    case 'WAITER':
      return {
        enabled: true,
        masterVolume: 0.8,
        bindings: {
          [SoundEvent.ORDER_READY]: b({ asset: 'builtin:ready', repeatCount: 2 }),
          [SoundEvent.ORDER_CANCELLED]: b({ asset: 'builtin:alert' }),
          [SoundEvent.NOTIFICATION]: b({ asset: 'builtin:chime' }),
        },
      };
    default:
      return { enabled: false, masterVolume: 0.8, bindings: {} };
  }
}
