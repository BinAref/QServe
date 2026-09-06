/**
 * WebSocket gateway (spec §22).
 *
 * A projection of the in-process event bus onto connected terminals. It adds
 * exactly three things over the bus:
 *
 *  - **Authorisation per event.** Each event names a permission; a socket
 *    receives it only if its session holds that permission. A kitchen screen
 *    physically cannot be sent a payment total.
 *  - **Subscription.** A terminal asks for the topics it renders, so a table's
 *    phone is not woken by every kitchen state change in the building.
 *  - **Liveness.** Heartbeats reap sockets whose device went to sleep or left
 *    the Wi-Fi, which is how `terminals.last_seen_at` stays honest.
 */

import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  describeEvent, EVENT_CATALOGUE, grants, Topic,
  type ClientFrame, type RealtimeEvent, type ServerFrame,
} from '@qserve/shared';
import type { EventBus } from './event-bus.js';
import type { SecurityService, AuthContext } from './security.js';

const HEARTBEAT_MS = 30_000;
/** Sockets may not sit unauthenticated; a terminal always has a cookie. */
const ALL_TOPICS = Object.values(Topic);

interface Client {
  readonly socket: WebSocket;
  readonly auth: AuthContext;
  topics: Set<string>;
  alive: boolean;
  /** Highest event sequence this client has acknowledged, for repeating alerts. */
  acknowledgedSeq: number;
}

export class RealtimeGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly clients = new Set<Client>();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly security: SecurityService,
    private readonly path = '/ws',
  ) {}

  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = this.bus.subscribe((event) => this.fanOut(event));

    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.socket.terminate();
          this.clients.delete(client);
          continue;
        }
        client.alive = false;
        try {
          client.socket.ping();
        } catch {
          this.clients.delete(client);
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Wire the gateway into an http.Server's upgrade event. */
  attach(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://local.invalid');
      if (url.pathname !== this.path) {
        socket.destroy();
        return;
      }

      // Authorise before the handshake completes: an unauthenticated socket is
      // never created, so there is no window in which it could receive events.
      const auth = this.security.resolveFromCookieHeader(request.headers.cookie);
      if (!auth.terminal && !auth.user) {
        (socket as Duplex).write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket as Duplex, head, (ws) => {
        this.register(ws, auth);
      });
    });
  }

  private register(socket: WebSocket, auth: AuthContext): void {
    const allowed = this.allowedTopics(auth);
    const client: Client = {
      socket,
      auth,
      // Subscribe to everything the session may see until told otherwise, so a
      // simple terminal needs no subscribe round-trip before it works.
      topics: new Set(allowed),
      alive: true,
      acknowledgedSeq: 0,
    };
    this.clients.add(client);

    socket.on('pong', () => { client.alive = true; });
    socket.on('close', () => this.clients.delete(client));
    socket.on('error', () => this.clients.delete(client));
    socket.on('message', (raw) => this.onMessage(client, raw.toString()));

    this.send(client, {
      type: 'welcome',
      topics: [...client.topics],
      seq: this.bus.currentSequence,
    });
  }

  private allowedTopics(auth: AuthContext): string[] {
    return ALL_TOPICS.filter((topic) =>
      // A topic is visible when the session may receive at least one of its events.
      this.eventsForTopic(topic).some(
        (permission) => permission === null || grants(auth.permissions, permission),
      ));
  }

  private eventsForTopic(topic: string): (string | null)[] {
    return ALL_TOPICS.includes(topic as Topic)
      ? EVENTS_BY_TOPIC.get(topic) ?? []
      : [];
  }

  private onMessage(client: Client, raw: string): void {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw) as ClientFrame;
    } catch {
      this.send(client, { type: 'error', code: 'BAD_FRAME', messageKey: 'error.bad_frame' });
      return;
    }

    switch (frame.type) {
      case 'ping':
        client.alive = true;
        this.send(client, { type: 'pong' });
        return;

      case 'subscribe': {
        const allowed = new Set(this.allowedTopics(client.auth));
        for (const topic of frame.topics) {
          if (allowed.has(topic)) client.topics.add(topic);
        }
        this.send(client, {
          type: 'welcome', topics: [...client.topics], seq: this.bus.currentSequence,
        });
        return;
      }

      case 'unsubscribe':
        for (const topic of frame.topics) client.topics.delete(topic);
        return;

      case 'ack':
        // Stops a repeating kitchen alarm (spec §21). Kept server-side so the
        // acknowledgement survives a page reload on the same terminal.
        client.acknowledgedSeq = Math.max(client.acknowledgedSeq, frame.eventSeq);
        return;

      default:
        this.send(client, { type: 'error', code: 'BAD_FRAME', messageKey: 'error.bad_frame' });
    }
  }

  private fanOut(event: RealtimeEvent): void {
    const descriptor = describeEvent(event.name);
    if (!descriptor) return;

    for (const client of this.clients) {
      if (!client.topics.has(event.topic)) continue;
      if (descriptor.permission !== null && !grants(client.auth.permissions, descriptor.permission)) {
        continue;
      }
      this.send(client, { type: 'event', event });
    }
  }

  private send(client: Client, frame: ServerFrame): void {
    if (client.socket.readyState !== client.socket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(frame));
    } catch {
      this.clients.delete(client);
    }
  }

  /** Terminal ids with at least one live socket. Drives the presence display. */
  connectedTerminalIds(): string[] {
    const ids = new Set<string>();
    for (const client of this.clients) {
      if (client.auth.terminal) ids.add(client.auth.terminal.id);
    }
    return [...ids];
  }

  get connectionCount(): number {
    return this.clients.size;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients) client.socket.close(1001, 'server shutting down');
    this.clients.clear();
    await new Promise<void>((done) => this.wss.close(() => done()));
  }
}

/**
 * Topic → the permissions its events require, derived from the catalogue so a
 * newly added event joins its topic without touching this file.
 */
const EVENTS_BY_TOPIC: ReadonlyMap<string, (string | null)[]> = (() => {
  const map = new Map<string, (string | null)[]>(ALL_TOPICS.map((topic) => [topic, []]));
  for (const descriptor of EVENT_CATALOGUE) {
    map.get(descriptor.topic)?.push(descriptor.permission);
  }
  return map;
})();
