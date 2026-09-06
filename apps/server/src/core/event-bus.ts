/**
 * In-process event bus (spec §22).
 *
 * Services publish domain facts here; the WebSocket gateway, the printing
 * module and the table-status projector all subscribe. Nothing polls.
 *
 * Two properties make this safe to build a kitchen on:
 *
 *  - **Monotonic sequence.** Every event gets the next number, so a terminal
 *    that reconnects can tell whether it missed something and ask for a resync
 *    rather than quietly showing a stale queue.
 *  - **Subscriber isolation.** A throwing subscriber is logged and skipped; it
 *    can never prevent the kitchen screen from receiving the order.
 */

import { describeEvent, type EventName, type RealtimeEvent, type Topic } from '@qserve/shared';

export type EventSubscriber = (event: RealtimeEvent) => void;

export interface PublishInput<T = unknown> {
  readonly name: EventName;
  readonly payload: T;
  readonly originTerminalId?: string | null;
}

/** Recent events, so a briefly disconnected terminal can catch up on reconnect. */
const REPLAY_BUFFER_SIZE = 200;

export class EventBus {
  private sequence = 0;
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly recent: RealtimeEvent[] = [];

  constructor(private readonly onSubscriberError: (error: unknown) => void = () => {}) {}

  get currentSequence(): number {
    return this.sequence;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  publish<T>(input: PublishInput<T>): RealtimeEvent<T> {
    const descriptor = describeEvent(input.name);
    if (!descriptor) {
      // A name outside the catalogue would have no topic and no permission, so
      // it could not be routed or authorised. Fail loudly in development.
      throw new Error(`event "${input.name}" is not in the event catalogue`);
    }

    this.sequence += 1;
    const event: RealtimeEvent<T> = {
      name: input.name,
      topic: descriptor.topic as Topic,
      seq: this.sequence,
      at: new Date().toISOString(),
      payload: input.payload,
      ...(input.originTerminalId ? { originTerminalId: input.originTerminalId } : {}),
    };

    this.recent.push(event as RealtimeEvent);
    if (this.recent.length > REPLAY_BUFFER_SIZE) this.recent.shift();

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event as RealtimeEvent);
      } catch (error) {
        this.onSubscriberError(error);
      }
    }
    return event;
  }

  /** Events after `sinceSeq`, for a terminal that reconnected with a gap. */
  replaySince(sinceSeq: number): readonly RealtimeEvent[] {
    return this.recent.filter((event) => event.seq > sinceSeq);
  }

  /**
   * True when the replay buffer no longer reaches back to `sinceSeq`, meaning
   * the client must do a full refresh rather than apply increments.
   */
  hasGap(sinceSeq: number): boolean {
    const oldest = this.recent[0];
    return oldest !== undefined && oldest.seq > sinceSeq + 1;
  }
}
