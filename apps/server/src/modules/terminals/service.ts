/**
 * Terminal and table provisioning, QR issuing and enrolment
 * (spec §8, §9, §11, §14, §16, §24).
 *
 * The QR payload is the thing to get right. It encodes
 *
 *     http://<stable-host>/r/<RestaurantId>/<TableId or TerminalId>?k=<secret>
 *
 * so the *meaning* of a printed card is "Restaurant REST-000123, table 05" —
 * not "the machine that happened to be at 192.168.1.14 in March". Replace the
 * computer, restore the backup, and every card in the dining room still works.
 */

import QRCode from 'qrcode';
import {
  Capability, conflict, EventName, forbidden, notFound, TerminalStatus, TerminalType,
  validationError, type Actor, type Localised, type SoundProfile,
  type Terminal, type TerminalType as TType,
} from '@qserve/shared';
import type { EventBus } from '../../core/event-bus.js';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { SettingsRepository } from '../../core/repositories/settings.js';
import type { TerminalRepository, TerminalRow } from '../../core/repositories/terminals.js';
import type { LicenseGate } from '../../core/license-gate.js';
import type { TableRepository } from '../tables/repository.js';

/** Where a terminal type sends its browser after a successful enrolment. */
const LANDING_PATH: Readonly<Record<string, string>> = {
  TABLE: '/menu',
  KITCHEN: '/kitchen',
  KDS: '/kitchen',
  BAR: '/kitchen',
  CASHIER: '/cashier',
  WAITER: '/waiter',
  MANAGER: '/waiter',
  PRINTER: '/printer',
};

export interface QrDescriptor {
  readonly url: string;
  readonly svg: string;
  readonly publicCode: string;
}

export class TerminalService {
  constructor(
    private readonly terminals: TerminalRepository,
    private readonly tables: TableRepository,
    private readonly settings: SettingsRepository,
    private readonly audit: AuditRepository,
    private readonly bus: EventBus,
    private readonly gate: LicenseGate,
    /** Resolved lazily: the LAN base URL is not known until the listener binds. */
    private readonly baseUrl: () => string | null,
  ) {}

  /* -------------------------------------------------------------- QR URLs */

  /**
   * The URL a QR encodes. `target` is the Table ID for a table and the Terminal
   * ID for a station, so the printed card is self-describing to a human too.
   */
  qrUrlFor(row: TerminalRow): string | null {
    const base = this.baseUrl();
    const profile = this.settings.profile();
    if (!base || !profile) return null;

    const table = this.tables.getByTerminal(row.id);
    const target = table?.id ?? row.id;
    return `${base}/r/${profile.restaurantId}/${target}?k=${encodeURIComponent(row.enrol_token)}`;
  }

  async qrFor(terminalId: string): Promise<QrDescriptor> {
    const row = this.terminals.get(terminalId);
    if (!row) throw notFound('terminal', terminalId);

    const url = this.qrUrlFor(row);
    if (!url) {
      throw conflict('the LAN address is not known yet; start the local server first');
    }

    // SVG rather than PNG: table cards get printed, and vector stays crisp at
    // any size a restaurant chooses to print at.
    const svg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 512,
    });

    return { url, svg, publicCode: row.public_code };
  }

  /* -------------------------------------------------------- provisioning */

  createTerminal(input: {
    type: TType;
    name: Localised;
    permissions?: readonly string[];
    config?: Record<string, unknown>;
    soundProfile?: SoundProfile;
    actor: Actor;
    clientIp: string | null;
  }): Terminal {
    // Provisioning real stations is an operational capability, so SETUP mode
    // refuses it — the owner can still build the whole menu (spec §2).
    this.gate.assert(Capability.TERMINALS_PROVISION);

    if (input.type === TerminalType.TABLE) {
      throw validationError(
        'table terminals are created through the tables module, so a table row always exists',
        { field: 'type' },
      );
    }

    const created = this.terminals.create({
      type: input.type,
      name: input.name,
      ...(input.permissions ? { permissions: input.permissions } : {}),
      ...(input.config ? { config: input.config } : {}),
      ...(input.soundProfile ? { soundProfile: input.soundProfile } : {}),
    });

    this.audit.record({
      action: 'terminal.created',
      actor: input.actor,
      entityType: 'terminal',
      entityId: created.row.id,
      after: { type: input.type, name: input.name },
      clientIp: input.clientIp,
    });

    const terminal = this.toModel(created.row);
    this.bus.publish({ name: EventName.TERMINAL_CREATED, payload: terminal });
    return terminal;
  }

  /** Create a dining table and the TABLE terminal that backs it. */
  createTable(input: {
    label: string;
    seats?: number;
    zone?: string | null;
    actor: Actor;
    clientIp: string | null;
  }): { tableId: string; terminal: Terminal } {
    this.gate.assert(Capability.TABLES_PROVISION);

    const label = input.label.trim();
    if (!label) throw validationError('a table needs a label', { field: 'label' });

    const created = this.terminals.create({
      type: TerminalType.TABLE,
      name: { '*': label },
    });

    let tableId: string;
    try {
      const table = this.tables.create({
        label,
        ...(input.seats !== undefined ? { seats: input.seats } : {}),
        zone: input.zone ?? null,
        terminalId: created.row.id,
      });
      tableId = table.id;
    } catch (error) {
      // Roll back the orphaned terminal so a duplicate label does not leave
      // an unreachable station behind.
      this.terminals.delete(created.row.id);
      if (String(error).includes('UNIQUE')) {
        throw conflict('a table with this label already exists', { label });
      }
      throw error;
    }

    this.audit.record({
      action: 'table.created',
      actor: input.actor,
      entityType: 'table',
      entityId: tableId,
      tableId,
      after: { label, seats: input.seats ?? 4 },
      clientIp: input.clientIp,
    });

    const terminal = this.toModel(created.row);
    this.bus.publish({ name: EventName.TABLE_CREATED, payload: { tableId, label, terminal } });
    return { tableId, terminal };
  }

  /** Bulk creation: "Table 01" … "Table 12" in one action (spec §9). */
  createTableRange(input: {
    prefix: string;
    from: number;
    to: number;
    seats?: number;
    zone?: string | null;
    actor: Actor;
    clientIp: string | null;
  }): { created: string[]; skipped: string[] } {
    this.gate.assert(Capability.TABLES_PROVISION);

    if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || input.to < input.from) {
      throw validationError('the table range is not valid', { field: 'from' });
    }
    if (input.to - input.from > 200) {
      throw validationError('at most 200 tables can be created at once', { field: 'to' });
    }

    const created: string[] = [];
    const skipped: string[] = [];
    const width = String(input.to).length;

    for (let n = input.from; n <= input.to; n += 1) {
      const label = `${input.prefix}${String(n).padStart(Math.max(width, 2), '0')}`;
      try {
        const result = this.createTable({
          label,
          ...(input.seats !== undefined ? { seats: input.seats } : {}),
          zone: input.zone ?? null,
          actor: input.actor,
          clientIp: input.clientIp,
        });
        created.push(result.tableId);
      } catch {
        // A label that already exists is not an error for a bulk operation;
        // report it and carry on.
        skipped.push(label);
      }
    }
    return { created, skipped };
  }

  updateTerminal(input: {
    terminalId: string;
    name?: Localised;
    status?: string;
    permissions?: readonly string[];
    config?: Record<string, unknown>;
    soundProfile?: SoundProfile;
    actor: Actor;
    clientIp: string | null;
  }): Terminal {
    const row = this.terminals.get(input.terminalId);
    if (!row) throw notFound('terminal', input.terminalId);

    this.terminals.update(input.terminalId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
      ...(input.config !== undefined ? { config: input.config } : {}),
      ...(input.soundProfile !== undefined ? { soundProfile: input.soundProfile } : {}),
    });

    // Disabling a terminal must take effect immediately, not when its session
    // happens to expire.
    if (input.status === TerminalStatus.DISABLED) {
      this.terminals.deleteSessionsForTerminal(input.terminalId);
    }

    this.audit.record({
      action: 'terminal.updated',
      actor: input.actor,
      entityType: 'terminal',
      entityId: input.terminalId,
      before: { status: row.status, name: this.terminals.name(row) },
      after: { status: input.status ?? row.status, name: input.name ?? this.terminals.name(row) },
      clientIp: input.clientIp,
    });

    const terminal = this.toModel(this.terminals.get(input.terminalId)!);
    this.bus.publish({ name: EventName.TERMINAL_UPDATED, payload: terminal });
    return terminal;
  }

  deleteTerminal(input: { terminalId: string; actor: Actor; clientIp: string | null }): void {
    const row = this.terminals.get(input.terminalId);
    if (!row) throw notFound('terminal', input.terminalId);

    const table = this.tables.getByTerminal(input.terminalId);
    if (table) {
      throw conflict('delete the table instead; its terminal goes with it', { tableId: table.id });
    }

    this.terminals.delete(input.terminalId);
    this.audit.record({
      action: 'terminal.deleted',
      actor: input.actor,
      entityType: 'terminal',
      entityId: input.terminalId,
      before: { type: row.terminal_type, name: this.terminals.name(row) },
      clientIp: input.clientIp,
    });
  }

  rotateQr(input: { terminalId: string; actor: Actor; clientIp: string | null }): void {
    const row = this.terminals.get(input.terminalId);
    if (!row) throw notFound('terminal', input.terminalId);

    this.terminals.regenerateEnrolToken(input.terminalId);
    this.audit.record({
      action: 'terminal.qr_rotated',
      actor: input.actor,
      entityType: 'terminal',
      entityId: input.terminalId,
      detail: { note: 'previously printed QR codes for this terminal stop working' },
      clientIp: input.clientIp,
    });
  }

  /* ------------------------------------------------------------ enrolment */

  /**
   * Resolve a scanned QR to a terminal. Returns null for anything that does not
   * match exactly — a wrong restaurant, an unknown target, a bad secret — so the
   * caller can answer with one indistinguishable failure.
   */
  resolveScan(input: {
    restaurantId: string;
    target: string;
    token: string;
  }): { row: TerminalRow; landingPath: string } | null {
    const profile = this.settings.profile();
    if (!profile || profile.restaurantId !== input.restaurantId) return null;

    let row: TerminalRow | undefined;
    if (input.target.startsWith('TABLE-')) {
      const table = this.tables.get(input.target);
      row = table ? this.terminals.get(table.terminal_id) : undefined;
    } else {
      row = this.terminals.get(input.target) ?? this.terminals.getByPublicCode(input.target);
    }

    if (!row || row.status !== TerminalStatus.ACTIVE) return null;
    if (!this.terminals.verifyEnrolToken(row, input.token)) return null;

    return { row, landingPath: LANDING_PATH[row.terminal_type] ?? '/waiter' };
  }

  enrol(input: {
    row: TerminalRow;
    ttlSeconds: number;
    clientIp: string | null;
    userAgent: string | null;
  }): string {
    // A live terminal cannot enrol before the licence is active: this is the
    // route a diner's phone takes, and SETUP mode must not serve it.
    this.gate.assert(Capability.LAN_SERVER);

    const token = this.terminals.createSession({
      terminalId: input.row.id,
      ttlSeconds: input.ttlSeconds,
      clientIp: input.clientIp,
      userAgent: input.userAgent,
    });
    this.terminals.touchSeen(input.row.id);
    return token;
  }

  /* -------------------------------------------------------------- reading */

  toModel(row: TerminalRow): Terminal {
    const table = this.tables.getByTerminal(row.id);
    return {
      id: row.id,
      type: row.terminal_type,
      name: this.terminals.name(row),
      status: row.status as Terminal['status'],
      permissions: this.terminals.permissions(row),
      config: this.terminals.config(row),
      soundProfile: this.terminals.soundProfile(row),
      tableId: table?.id ?? null,
      qrUrl: this.qrUrlFor(row),
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  }

  list(type?: TType): Terminal[] {
    return this.terminals.list(type).map((row) => this.toModel(row));
  }

  /** Stations only — the tables list is served by the tables module. */
  listStations(): Terminal[] {
    return this.terminals
      .list()
      .filter((row) => row.terminal_type !== TerminalType.TABLE)
      .map((row) => this.toModel(row));
  }

  requireTerminal(terminalId: string): TerminalRow {
    const row = this.terminals.get(terminalId);
    if (!row) throw notFound('terminal', terminalId);
    return row;
  }

  /** Guard for routes that a specific station type owns. */
  assertType(row: TerminalRow, allowed: readonly TType[]): void {
    if (!allowed.includes(row.terminal_type)) {
      throw forbidden(`this station is a ${row.terminal_type}`);
    }
  }
}
