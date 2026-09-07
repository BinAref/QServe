/**
 * Printing (spec §36).
 *
 * Modular by construction: a printer declares which *document types* and which
 * *kitchen stations* it accepts, and the router sends each document to every
 * printer that matches. "Kitchen orders → kitchen printer, receipts → cashier
 * printer" is therefore configuration, not code, and a restaurant with a grill
 * printer and a bar printer needs no new build.
 *
 * Three transports cover the hardware restaurants actually own:
 *   NETWORK  raw ESC/POS over TCP — the standard thermal printer
 *   BROWSER  rendered and pushed to a terminal that owns a USB printer
 *   FILE     written to a spool directory for a local print watcher
 */

import { connect } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '@qserve/db';
import { fromDbBool, fromDbStringList, nowIso, toDbBool, toDbJson } from '@qserve/db';
import {
  Capability, EventName, newEntityId, notFound, PrintDocumentType, PrinterTransport,
  formatMoney, pickLocalised,
  type Order, type Payment, type Printer, type PrintJob,
  type PrintDocumentType as DocType, type RestaurantProfile,
} from '@qserve/shared';
import type { EventBus } from '../../core/event-bus.js';
import type { LicenseGate } from '../../core/license-gate.js';
import type { NotifyInput } from '../orders/service.js';
import type { SettingsRepository } from '../../core/repositories/settings.js';

interface PrinterRow {
  id: string; name: string; transport: string; target: string;
  document_types_json: string; stations_json: string; characters_per_line: number;
  enabled: number; created_at: string; updated_at: string;
}

interface JobRow {
  id: string; printer_id: string; document_type: DocType; order_id: string | null;
  payload: string; status: string; attempts: number; last_error: string | null;
  created_at: string; updated_at: string;
}

export class PrintingRepository {
  constructor(private readonly db: Db) {}

  createPrinter(input: {
    name: string; transport: string; target: string;
    documentTypes: readonly DocType[]; stations: readonly string[];
    charactersPerLine?: number; enabled?: boolean;
  }): Printer {
    const id = newEntityId('PRN');
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO printers
          (id, name, transport, target, document_types_json, stations_json,
           characters_per_line, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id, input.name, input.transport, input.target, toDbJson(input.documentTypes),
        toDbJson(input.stations), input.charactersPerLine ?? 42,
        toDbBool(input.enabled ?? true), at, at,
      );
    return this.getPrinter(id)!;
  }

  getPrinter(id: string): Printer | null {
    const row = this.db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as
      | PrinterRow
      | undefined;
    return row ? toPrinter(row) : null;
  }

  listPrinters(): Printer[] {
    return (this.db.prepare('SELECT * FROM printers ORDER BY name').all() as PrinterRow[])
      .map(toPrinter);
  }

  updatePrinter(id: string, patch: {
    name?: string; transport?: string; target?: string;
    documentTypes?: readonly DocType[]; stations?: readonly string[];
    charactersPerLine?: number; enabled?: boolean;
  }): void {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      assignments.push(`${column} = ?`); values.push(value);
    };
    if (patch.name !== undefined) push('name', patch.name);
    if (patch.transport !== undefined) push('transport', patch.transport);
    if (patch.target !== undefined) push('target', patch.target);
    if (patch.documentTypes !== undefined) push('document_types_json', toDbJson(patch.documentTypes));
    if (patch.stations !== undefined) push('stations_json', toDbJson(patch.stations));
    if (patch.charactersPerLine !== undefined) push('characters_per_line', patch.charactersPerLine);
    if (patch.enabled !== undefined) push('enabled', toDbBool(patch.enabled));
    if (assignments.length === 0) return;
    this.db
      .prepare(`UPDATE printers SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...values, nowIso(), id);
  }

  deletePrinter(id: string): void {
    this.db.prepare('DELETE FROM printers WHERE id = ?').run(id);
  }

  queueJob(input: {
    printerId: string; documentType: DocType; orderId: string | null; payload: string;
  }): PrintJob {
    const id = newEntityId('PJB');
    const at = nowIso();
    this.db
      .prepare(`
        INSERT INTO print_jobs
          (id, printer_id, document_type, order_id, payload, status, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'QUEUED', 0, ?, ?)
      `)
      .run(id, input.printerId, input.documentType, input.orderId, input.payload, at, at);
    return this.getJob(id)!;
  }

  getJob(id: string): PrintJob | null {
    const row = this.db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id) as
      | JobRow
      | undefined;
    return row ? toJob(row) : null;
  }

  jobPayload(id: string): string | null {
    const row = this.db.prepare('SELECT payload FROM print_jobs WHERE id = ?').get(id) as
      | { payload: string }
      | undefined;
    return row?.payload ?? null;
  }

  pendingJobs(limit = 50): PrintJob[] {
    return (
      this.db
        .prepare("SELECT * FROM print_jobs WHERE status = 'QUEUED' ORDER BY created_at LIMIT ?")
        .all(limit) as JobRow[]
    ).map(toJob);
  }

  recentJobs(limit = 100): PrintJob[] {
    return (
      this.db.prepare('SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as JobRow[]
    ).map(toJob);
  }

  markJob(id: string, status: 'SENT' | 'FAILED' | 'QUEUED', error: string | null): void {
    this.db
      .prepare(`
        UPDATE print_jobs SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, error, nowIso(), id);
  }
}

function toPrinter(row: PrinterRow): Printer {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as Printer['transport'],
    target: row.target,
    documentTypes: fromDbStringList(row.document_types_json) as DocType[],
    stations: fromDbStringList(row.stations_json),
    charactersPerLine: row.characters_per_line,
    enabled: fromDbBool(row.enabled),
    createdAt: row.created_at,
  };
}

function toJob(row: JobRow): PrintJob {
  return {
    id: row.id,
    printerId: row.printer_id,
    documentType: row.document_type,
    orderId: row.order_id,
    status: row.status as PrintJob['status'],
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

/* ----------------------------------------------------------- rendering */

/**
 * ESC/POS control sequences, written as escapes rather than literal control
 * characters so the source stays diffable and greppable.
 *   ESC @   reset the printer to a known state
 *   GS V 0  full cut
 * Printers that do not understand them ignore them harmlessly.
 */
const INIT = '\x1b@';
const CUT = '\x1dV\x00';

const rule = (width: number, char = '-'): string => char.repeat(width);

function centre(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

/** `Burger x2 …………… 24.00`, wrapped to the printer's column count. */
function columns(left: string, right: string, width: number): string {
  const space = Math.max(1, width - right.length);
  const clipped = left.length > space - 1 ? `${left.slice(0, space - 2)}…` : left;
  return clipped.padEnd(space, ' ') + right;
}

export interface RenderContext {
  readonly profile: RestaurantProfile;
  readonly locale: string;
  readonly width: number;
}

/**
 * Kitchen ticket: what to cook, who ordered it, and nothing about money. A cook
 * does not need the price and should not be slowed down by it.
 */
export function renderKitchenTicket(
  order: Order,
  context: RenderContext,
  stationFilter: readonly string[],
): string {
  const { width, locale } = context;
  const items = stationFilter.length
    ? order.items.filter((item) => item.station && stationFilter.includes(item.station))
    : order.items;
  if (items.length === 0) return '';

  const lines: string[] = [
    INIT,
    centre('*** KITCHEN ***', width),
    '',
    `ORDER  #${order.number}`,
    `TABLE  ${order.tableLabel ?? '-'}`,
    `SOURCE ${order.source}${order.createdBy.userName ? ` — ${order.createdBy.userName}` : ''}`,
    `TIME   ${new Date(order.createdAt).toLocaleTimeString(locale)}`,
    rule(width),
  ];

  for (const item of items) {
    lines.push(`${item.quantity} x ${pickLocalised(item.name, locale)}`);
    for (const selection of item.selections) {
      lines.push(`    · ${pickLocalised(selection.name, locale)}`);
    }
    for (const addon of item.addons) {
      lines.push(`    + ${addon.quantity} ${pickLocalised(addon.name, locale)}`);
    }
    if (item.notes) lines.push(`    ! ${item.notes}`);
    lines.push('');
  }

  if (order.notes) {
    lines.push(rule(width), `NOTE: ${order.notes}`);
  }
  lines.push(rule(width), '', '', CUT);
  return lines.join('\n');
}

/** Customer receipt: the money document, with the accountability the spec wants. */
export function renderReceipt(
  order: Order,
  payments: readonly Payment[],
  context: RenderContext,
): string {
  const { width, locale, profile } = context;
  const money = (minor: number): string => formatMoney(minor, order.currency, locale);

  const lines: string[] = [
    INIT,
    centre(pickLocalised(profile.name, locale), width),
  ];
  if (profile.address) lines.push(centre(profile.address, width));
  if (profile.phone) lines.push(centre(profile.phone, width));
  if (profile.taxNumber) lines.push(centre(`TAX ${profile.taxNumber}`, width));

  lines.push(
    rule(width, '='),
    `RECEIPT  #${order.number}`,
    `TABLE    ${order.tableLabel ?? '-'}`,
    `DATE     ${new Date(order.createdAt).toLocaleString(locale)}`,
    `SERVED   ${order.createdBy.userName ?? order.source}`,
    ...(order.paidBy?.userName ? [`CASHIER  ${order.paidBy.userName}`] : []),
    rule(width),
  );

  for (const item of order.items) {
    lines.push(columns(
      `${item.quantity} x ${pickLocalised(item.name, locale)}`,
      money(item.lineTotalMinor),
      width,
    ));
    for (const selection of item.selections) {
      if (selection.priceDeltaMinor === 0) {
        lines.push(`    · ${pickLocalised(selection.name, locale)}`);
      } else {
        lines.push(columns(
          `    · ${pickLocalised(selection.name, locale)}`,
          money(selection.priceDeltaMinor * item.quantity),
          width,
        ));
      }
    }
    for (const addon of item.addons) {
      lines.push(columns(
        `    + ${addon.quantity} ${pickLocalised(addon.name, locale)}`,
        money(addon.priceMinor * addon.quantity * item.quantity),
        width,
      ));
    }
  }

  lines.push(rule(width));
  lines.push(columns('Subtotal', money(order.totals.subtotalMinor), width));
  if (order.totals.discountMinor > 0) {
    lines.push(columns('Discount', `-${money(order.totals.discountMinor)}`, width));
  }
  if (order.totals.serviceMinor > 0) {
    lines.push(columns('Service', money(order.totals.serviceMinor), width));
  }
  if (order.totals.taxMinor > 0) {
    const label = profile.taxInclusive ? 'Tax (included)' : 'Tax';
    lines.push(columns(label, money(order.totals.taxMinor), width));
  }
  lines.push(rule(width, '='));
  lines.push(columns('TOTAL', money(order.totals.totalMinor), width));

  for (const payment of payments) {
    lines.push(columns(`  ${payment.method}`, money(payment.amountMinor), width));
    if (payment.changeMinor !== null && payment.changeMinor > 0) {
      lines.push(columns('  Change', money(payment.changeMinor), width));
    }
  }

  lines.push('', centre('Thank you', width), '', '', CUT);
  return lines.join('\n');
}

/* ------------------------------------------------------------ dispatch */

export class PrintingService {
  constructor(
    private readonly repository: PrintingRepository,
    private readonly settings: SettingsRepository,
    private readonly bus: EventBus,
    private readonly gate: LicenseGate,
    private readonly spoolDir: string,
  ) {}

  /** Told when a printer refuses, so somebody hears about it. */
  private notify: ((input: NotifyInput) => void) | null = null;

  setNotifier(notify: (input: NotifyInput) => void): void {
    this.notify = notify;
  }

  /** Printers that accept this document type, and this item's station if given. */
  private route(documentType: DocType, stations: readonly string[]): Printer[] {
    return this.repository.listPrinters().filter((printer) => {
      if (!printer.enabled) return false;
      if (!printer.documentTypes.includes(documentType)) return false;
      // An empty station list means "everything", which is the right default
      // for a single-printer restaurant.
      if (printer.stations.length === 0) return true;
      return stations.some((station) => printer.stations.includes(station));
    });
  }

  async printKitchenTicket(order: Order, locale: string): Promise<PrintJob[]> {
    this.gate.assert(Capability.PRINTING_RUNTIME);

    const profile = this.settings.profile();
    if (!profile) return [];

    const stations = [...new Set(order.items.map((item) => item.station).filter(Boolean))] as string[];
    const printers = this.route(PrintDocumentType.KITCHEN_TICKET, stations);
    const jobs: PrintJob[] = [];

    for (const printer of printers) {
      const body = renderKitchenTicket(
        order,
        { profile, locale, width: printer.charactersPerLine },
        printer.stations,
      );
      if (!body) continue;
      jobs.push(await this.dispatch(printer, PrintDocumentType.KITCHEN_TICKET, order.id, body));
    }
    return jobs;
  }

  async printReceipt(
    order: Order,
    payments: readonly Payment[],
    locale: string,
  ): Promise<PrintJob[]> {
    this.gate.assert(Capability.PRINTING_RUNTIME);

    const profile = this.settings.profile();
    if (!profile) return [];

    const jobs: PrintJob[] = [];
    for (const printer of this.route(PrintDocumentType.RECEIPT, [])) {
      const body = renderReceipt(
        order, payments, { profile, locale, width: printer.charactersPerLine },
      );
      jobs.push(await this.dispatch(printer, PrintDocumentType.RECEIPT, order.id, body));
    }
    return jobs;
  }

  private async dispatch(
    printer: Printer,
    documentType: DocType,
    orderId: string | null,
    body: string,
  ): Promise<PrintJob> {
    const job = this.repository.queueJob({
      printerId: printer.id, documentType, orderId, payload: body,
    });

    this.bus.publish({
      name: EventName.PRINT_JOB_QUEUED,
      payload: { job, printerId: printer.id, documentType },
    });

    try {
      await this.send(printer, job.id, body);
      this.repository.markJob(job.id, 'SENT', null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.markJob(job.id, 'FAILED', message);
      this.bus.publish({
        name: EventName.PRINT_JOB_RESULT,
        payload: { jobId: job.id, ok: false, error: message },
      });
      // Nobody watches a print queue. Somebody has to be told, or the ticket
      // that never printed is discovered when the diner asks where the food is.
      this.notify?.({
        kind: 'PRINT_FAILED',
        messageKey: 'notify.print_failed',
        params: { printer: printer.name, error: message },
        ...(orderId ? { orderId } : {}),
      });
      return this.repository.getJob(job.id)!;
    }

    this.bus.publish({
      name: EventName.PRINT_JOB_RESULT,
      payload: { jobId: job.id, ok: true, error: null },
    });
    return this.repository.getJob(job.id)!;
  }

  private async send(printer: Printer, jobId: string, body: string): Promise<void> {
    switch (printer.transport) {
      case PrinterTransport.NETWORK:
        return this.sendOverTcp(printer.target, body);

      case PrinterTransport.FILE:
        // The spool directory is watched by whatever the restaurant already
        // uses to drive a USB printer; writing a file is the least brittle
        // integration point we can offer.
        await writeFile(join(this.spoolDir, `${jobId}.txt`), body, 'utf8');
        return;

      case PrinterTransport.BROWSER:
        // The terminal that owns the printer renders and prints it. Delivery is
        // best-effort by nature: the job is marked SENT once it is broadcast,
        // and the terminal reports back through the print result event.
        this.bus.publish({
          name: EventName.PRINT_JOB_QUEUED,
          payload: { jobId, terminalId: printer.target, body, deliverTo: printer.target },
        });
        return;

      default:
        throw new Error(`unsupported printer transport: ${printer.transport}`);
    }
  }

  private sendOverTcp(target: string, body: string): Promise<void> {
    const [host, portText] = target.split(':');
    const port = Number(portText ?? 9100);
    if (!host || !Number.isFinite(port)) {
      throw new Error(`printer target must be host:port, got "${target}"`);
    }

    return new Promise<void>((resolve, reject) => {
      const socket = connect({ host, port });
      // A thermal printer that is switched off must fail fast: a cashier is
      // standing at the till waiting for a receipt.
      socket.setTimeout(5000);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`printer at ${target} did not respond`));
      });
      socket.on('error', reject);
      socket.on('connect', () => {
        socket.write(body, 'utf8', () => socket.end());
      });
      socket.on('close', () => resolve());
    });
  }

  /** Re-send a failed job — a receipt reprint is a daily reality. */
  async retry(jobId: string): Promise<PrintJob> {
    const job = this.repository.getJob(jobId);
    if (!job) throw notFound('print job', jobId);

    const printer = this.repository.getPrinter(job.printerId);
    if (!printer) throw notFound('printer', job.printerId);

    const body = this.repository.jobPayload(jobId);
    if (body === null) throw notFound('print job payload', jobId);

    try {
      await this.send(printer, job.id, body);
      this.repository.markJob(job.id, 'SENT', null);
    } catch (error) {
      this.repository.markJob(
        job.id, 'FAILED', error instanceof Error ? error.message : String(error),
      );
    }
    return this.repository.getJob(jobId)!;
  }

  get printers(): PrintingRepository {
    return this.repository;
  }
}
