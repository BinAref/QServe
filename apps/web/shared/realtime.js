/**
 * WebSocket client (spec §22).
 *
 * Terminals never poll. This keeps a socket to the local server, reconnects
 * with backoff when a tablet sleeps or drifts out of Wi-Fi range, and reports
 * connection state so a screen can say "reconnecting" instead of quietly
 * showing a stale kitchen queue — the failure mode that actually loses food.
 *
 * On reconnect it compares the server's event sequence with the last one seen.
 * If events were missed, `onResync` fires and the screen reloads from the API
 * rather than applying increments to a stale view.
 */

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export class Realtime {
  #socket = null;
  #backoff = INITIAL_BACKOFF_MS;
  #closed = false;
  #handlers = new Map();
  #stateListeners = new Set();
  #lastSeq = 0;
  #onResync = null;
  #reconnectTimer = null;

  constructor({ path = '/ws', topics = null, onResync = null } = {}) {
    this.path = path;
    this.topics = topics;
    this.#onResync = onResync;
    this.state = 'connecting';
  }

  /** Subscribe to one event name. Returns an unsubscribe function. */
  on(eventName, handler) {
    const list = this.#handlers.get(eventName) ?? [];
    list.push(handler);
    this.#handlers.set(eventName, list);
    return () => {
      const current = this.#handlers.get(eventName) ?? [];
      this.#handlers.set(eventName, current.filter((entry) => entry !== handler));
    };
  }

  onStateChange(listener) {
    this.#stateListeners.add(listener);
    listener(this.state);
    return () => this.#stateListeners.delete(listener);
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.#stateListeners) listener(state);
  }

  connect() {
    if (this.#closed) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}${this.path}`);
    this.#socket = socket;
    this.#setState(this.#lastSeq > 0 ? 'reconnecting' : 'connecting');

    socket.addEventListener('open', () => {
      this.#backoff = INITIAL_BACKOFF_MS;
      this.#setState('open');
      if (this.topics) {
        socket.send(JSON.stringify({ type: 'subscribe', topics: this.topics }));
      }
    });

    socket.addEventListener('message', (message) => {
      let frame;
      try {
        frame = JSON.parse(message.data);
      } catch {
        return;
      }

      if (frame.type === 'welcome') {
        // A gap means this screen missed events while it was away; a full
        // reload is the only honest way to catch up.
        if (this.#lastSeq > 0 && frame.seq > this.#lastSeq) this.#onResync?.();
        this.#lastSeq = frame.seq;
        return;
      }
      if (frame.type !== 'event') return;

      this.#lastSeq = Math.max(this.#lastSeq, frame.event.seq);
      for (const handler of this.#handlers.get(frame.event.name) ?? []) {
        try {
          handler(frame.event.payload, frame.event);
        } catch (error) {
          console.error('[realtime] handler failed', frame.event.name, error);
        }
      }
      for (const handler of this.#handlers.get('*') ?? []) handler(frame.event.payload, frame.event);
    });

    socket.addEventListener('close', () => this.#scheduleReconnect());
    socket.addEventListener('error', () => socket.close());
  }

  #scheduleReconnect() {
    if (this.#closed) return;
    this.#setState('reconnecting');
    clearTimeout(this.#reconnectTimer);

    // Jitter keeps a dozen kitchen tablets from reconnecting in lockstep after
    // the restaurant's router reboots.
    const delay = this.#backoff + Math.random() * 250;
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /** Tell the server an alert was acknowledged, silencing a repeating sound. */
  acknowledge(eventSeq) {
    this.#send({ type: 'ack', eventSeq });
  }

  #send(frame) {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(frame));
    }
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#setState('closed');
  }
}
