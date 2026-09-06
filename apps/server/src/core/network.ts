/**
 * Local network identity and discovery (spec §8).
 *
 * The spec's requirement is precise and worth restating: a printed table QR
 * must not stop working because the restaurant bought a new computer. So the
 * QR encodes `Restaurant ID + Table ID` in its *path*, and the only
 * machine-specific part — the host — is kept stable by answering to an mDNS
 * name derived from the Restaurant ID:
 *
 *     http://qserve-rest-000123.local:7020/r/REST-000123/TABLE-05?k=…
 *
 * Move the installation to another PC, restore the backup, and the same name
 * resolves to the new machine. Nothing is reprinted.
 *
 * The responder below is a deliberately small multicast-DNS implementation: it
 * answers A queries for its own name and does nothing else. Every failure path
 * is non-fatal — if multicast is blocked on the restaurant's router, the system
 * falls back to an IP address and says so on the console.
 */

import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_ANY = 255;
const CLASS_IN = 1;
/** Cache-flush bit, telling resolvers to replace any cached record. */
const CLASS_IN_FLUSH = 0x8001;
const RECORD_TTL_SECONDS = 120;

export interface NetworkAddress {
  readonly address: string;
  readonly interfaceName: string;
}

/** Every non-loopback IPv4 address this machine answers on. */
export function lanAddresses(): NetworkAddress[] {
  const found: NetworkAddress[] = [];
  for (const [interfaceName, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      found.push({ address: address.address, interfaceName });
    }
  }
  return found;
}

/**
 * `REST-000123` → `qserve-rest-000123.local`. Derived from the restaurant
 * identity rather than the hostname so it is stable across hardware.
 */
export function mdnsNameFor(restaurantId: string): string {
  return `qserve-${restaurantId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.local`;
}

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    if (bytes.length > 63) throw new Error(`DNS label too long: ${part}`);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

interface ParsedQuestion {
  readonly name: string;
  readonly type: number;
  readonly cls: number;
}

/** Decode just enough of a DNS message to read its questions. */
function parseQuestions(message: Buffer): ParsedQuestion[] {
  if (message.length < 12) return [];
  const questionCount = message.readUInt16BE(4);
  const questions: ParsedQuestion[] = [];
  let offset = 12;

  for (let i = 0; i < questionCount; i += 1) {
    const labels: string[] = [];
    let guard = 0;

    while (offset < message.length) {
      const length = message[offset]!;
      if (length === 0) { offset += 1; break; }
      // Compression pointers are legal but never needed in a question we care
      // about; bail out rather than following one.
      if ((length & 0xc0) === 0xc0) return questions;
      offset += 1;
      if (offset + length > message.length) return questions;
      labels.push(message.subarray(offset, offset + length).toString('utf8'));
      offset += length;
      if ((guard += 1) > 32) return questions;
    }

    if (offset + 4 > message.length) return questions;
    questions.push({
      name: labels.join('.'),
      type: message.readUInt16BE(offset),
      cls: message.readUInt16BE(offset + 2),
    });
    offset += 4;
  }
  return questions;
}

function buildAnswer(name: string, ipv4: string): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);       // id: 0 for mDNS responses
  header.writeUInt16BE(0x8400, 2);  // response + authoritative
  header.writeUInt16BE(0, 4);       // questions
  header.writeUInt16BE(1, 6);       // answers
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const nameBytes = encodeName(name);
  const record = Buffer.alloc(10);
  record.writeUInt16BE(TYPE_A, 0);
  record.writeUInt16BE(CLASS_IN_FLUSH, 2);
  record.writeUInt32BE(RECORD_TTL_SECONDS, 4);
  record.writeUInt16BE(4, 8);

  const rdata = Buffer.from(ipv4.split('.').map((octet) => Number(octet)));
  if (rdata.length !== 4) throw new Error(`not an IPv4 address: ${ipv4}`);

  return Buffer.concat([header, nameBytes, record, rdata]);
}

export interface DiscoveryStatus {
  readonly advertising: boolean;
  readonly hostname: string | null;
  readonly address: string | null;
  readonly error: string | null;
}

export class LocalDiscovery {
  private socket: Socket | null = null;
  private status: DiscoveryStatus = {
    advertising: false, hostname: null, address: null, error: null,
  };

  get current(): DiscoveryStatus {
    return this.status;
  }

  /**
   * Start answering `hostname` with `address`. Resolves once the socket is
   * bound, or records the failure and returns — never throws, because losing
   * name discovery must degrade to "use the IP", not stop the restaurant.
   */
  async advertise(hostname: string, address: string): Promise<DiscoveryStatus> {
    await this.stop();

    return new Promise<DiscoveryStatus>((resolve) => {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });

      const fail = (error: unknown): void => {
        this.status = {
          advertising: false,
          hostname,
          address,
          error: error instanceof Error ? error.message : String(error),
        };
        try { socket.close(); } catch { /* already closed */ }
        this.socket = null;
        resolve(this.status);
      };

      socket.on('error', fail);

      socket.on('message', (message, remote) => {
        try {
          const wanted = hostname.toLowerCase();
          const asks = parseQuestions(message).some(
            (q) =>
              q.name.toLowerCase() === wanted &&
              (q.type === TYPE_A || q.type === TYPE_ANY) &&
              (q.cls & 0x7fff) === CLASS_IN,
          );
          if (!asks) return;

          const answer = buildAnswer(hostname, address);
          // Answer both to the multicast group (so other resolvers cache it)
          // and directly to the asker, which some stacks require.
          socket.send(answer, MDNS_PORT, MDNS_ADDRESS);
          if (remote.port !== MDNS_PORT) socket.send(answer, remote.port, remote.address);
        } catch {
          // A malformed query from something else on the network is not our
          // problem; keep serving.
        }
      });

      try {
        socket.bind(MDNS_PORT, () => {
          try {
            socket.addMembership(MDNS_ADDRESS);
            socket.setMulticastTTL(255);
            socket.setMulticastLoopback(true);
            this.socket = socket;
            this.status = { advertising: true, hostname, address, error: null };

            // Unsolicited announcement, so resolvers learn the name without
            // waiting for someone to ask.
            socket.send(buildAnswer(hostname, address), MDNS_PORT, MDNS_ADDRESS);
            resolve(this.status);
          } catch (error) {
            fail(error);
          }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      try { socket.close(() => resolve()); } catch { resolve(); }
    });
    this.status = { ...this.status, advertising: false };
  }
}

export interface PublicUrlInput {
  readonly configuredHost: string | null;
  readonly restaurantId: string | null;
  readonly port: number;
  readonly discovery: DiscoveryStatus;
}

/**
 * The base URL printed into QR codes. Preference order:
 *   1. an explicitly configured host (the operator knows best);
 *   2. the mDNS name, when it is actually being advertised;
 *   3. the first LAN IPv4 address, as a last resort.
 */
export function publicBaseUrl(input: PublicUrlInput): string | null {
  const host =
    input.configuredHost ??
    (input.discovery.advertising ? input.discovery.hostname : null) ??
    lanAddresses()[0]?.address ??
    null;
  return host ? `http://${host}:${input.port}` : null;
}
