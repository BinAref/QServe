/**
 * Terminals, payments and printing.
 *
 * Note the guard on every payment route: `requireUser`, not just a permission.
 * A cashier station on its own may *see* the till; taking money needs a person
 * to be signed in, because the receipt has to name them (spec §15).
 */

import {
  asObject, Capability, notFound, optionalBoolean, optionalNumber, optionalString,
  PaymentMethod, Permission, PrintDocumentType, PrinterTransport, requireEnum,
  requireLocalised, requireNumber, requireString, requireStringArray, TERMINAL_TYPES,
  TerminalStatus, validationError,
  type PrintDocumentType as DocType, type SoundProfile, type TerminalType as TType,
} from '@qserve/shared';
import { HttpResponse, Router } from '@qserve/http';
import type { Services } from '../../container.js';
import type { AppState } from '../../core/security.js';

export function createOperationsRoutes(services: Services): Router<AppState> {
  const router = new Router<AppState>();
  const security = services.security;

  const canViewTerminals = security.requirePermission(Permission.TERMINALS_VIEW);
  const canManageTerminals = security.requirePermission(Permission.TERMINALS_MANAGE);
  const canViewPayments = security.requirePermission(Permission.PAYMENTS_VIEW);
  const canUsePrinting = security.requirePermission(Permission.PRINTING_USE);
  const canManagePrinting = security.requirePermission(Permission.PRINTING_MANAGE);

  /* ---------------------------------------------------------- terminals */

  router.get('/terminals', (ctx) => {
    const type = ctx.query.get('type') as TType | null;
    const connected = new Set(services.realtime.connectedTerminalIds());
    const terminals = type ? services.terminals.list(type) : services.terminals.listStations();

    return {
      terminals: terminals.map((terminal) => ({
        ...terminal,
        online: connected.has(terminal.id),
      })),
      types: TERMINAL_TYPES,
    };
  }, [canViewTerminals]);

  router.post('/terminals', (ctx) => {
    const body = asObject(ctx.body);
    return services.terminals.createTerminal({
      type: requireEnum<TType>(body, 'type', TERMINAL_TYPES),
      name: requireLocalised(body, 'name', { max: 80 }),
      ...(body['permissions'] !== undefined
        ? { permissions: requireStringArray(body, 'permissions', { max: 60 }) } : {}),
      ...(body['config'] !== undefined ? { config: asObject(body['config'], 'config') } : {}),
      ...(body['soundProfile'] !== undefined
        ? { soundProfile: asObject(body['soundProfile'], 'soundProfile') as unknown as SoundProfile }
        : {}),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [canManageTerminals]);

  router.patch('/terminals/:id', (ctx) => {
    const body = asObject(ctx.body);
    return services.terminals.updateTerminal({
      terminalId: ctx.params['id']!,
      ...(body['name'] !== undefined ? { name: requireLocalised(body, 'name', { max: 80 }) } : {}),
      ...(body['status'] !== undefined
        ? { status: requireEnum(body, 'status', Object.values(TerminalStatus)) } : {}),
      ...(body['permissions'] !== undefined
        ? { permissions: requireStringArray(body, 'permissions', { max: 60 }) } : {}),
      ...(body['config'] !== undefined ? { config: asObject(body['config'], 'config') } : {}),
      ...(body['soundProfile'] !== undefined
        ? { soundProfile: asObject(body['soundProfile'], 'soundProfile') as unknown as SoundProfile }
        : {}),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [canManageTerminals]);

  router.delete('/terminals/:id', (ctx) => {
    services.terminals.deleteTerminal({
      terminalId: ctx.params['id']!,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
    return { deleted: ctx.params['id'] };
  }, [canManageTerminals]);

  /** The printable QR for a terminal or a table, as SVG. */
  router.get('/terminals/:id/qr', async (ctx) => {
    const qr = await services.terminals.qrFor(ctx.params['id']!);
    if (ctx.query.get('format') === 'svg') {
      return HttpResponse.text(200, qr.svg, 'image/svg+xml');
    }
    return qr;
  }, [canViewTerminals]);

  /** QR for a table, addressed by Table ID rather than by terminal. */
  router.get('/tables/:id/qr', async (ctx) => {
    const table = services.tables.get(ctx.params['id']!);
    if (!table) throw notFound('table', ctx.params['id']!);

    const qr = await services.terminals.qrFor(table.terminal_id);
    if (ctx.query.get('format') === 'svg') {
      return HttpResponse.text(200, qr.svg, 'image/svg+xml');
    }
    return { ...qr, tableId: table.id, label: table.label };
  }, [security.requirePermission(Permission.TABLES_VIEW)]);

  router.post('/terminals/:id/rotate-qr', (ctx) => {
    services.terminals.rotateQr({
      terminalId: ctx.params['id']!,
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
    return { ok: true, warning: 'previously printed QR codes for this terminal no longer work' };
  }, [canManageTerminals]);

  /* ----------------------------------------------------------- payments */

  router.get('/orders/:id/bill', (ctx) =>
    services.payments.billFor(ctx.params['id']!), [canViewPayments]);

  router.post('/orders/:id/payments', async (ctx) => {
    const body = asObject(ctx.body);
    const auth = ctx.state.auth!;

    const result = services.payments.capture({
      orderId: ctx.params['id']!,
      method: requireEnum(body, 'method', Object.values(PaymentMethod)),
      amountMinor: requireNumber(body, 'amountMinor', { min: 1, max: 1_000_000_000 }),
      tenderedMinor: optionalNumber(body, 'tenderedMinor', { min: 0, max: 1_000_000_000 }),
      reference: optionalString(body, 'reference', { max: 120 }),
      actor: auth.actor,
      permissions: auth.permissions,
      clientIp: ctx.ip,
    });

    if (result.orderPaid && services.settings.get<boolean>('cashier.printReceiptOnPayment')) {
      const order = services.orders.repository.get(ctx.params['id']!)!;
      const locale = services.settings.profile()?.defaultLocale ?? 'en';
      await services.printing
        .printReceipt(order, services.payments.billFor(order.id).payments, locale)
        .catch(() => undefined);
    }
    return result;
  }, [
    security.requireCapability(Capability.CASHIER_RUNTIME),
    security.requireUser(Permission.PAYMENTS_CREATE),
  ]);

  router.post('/payments/:id/refund', (ctx) => {
    if (!services.settings.get<boolean>('cashier.allowRefund')) {
      throw validationError('refunds are disabled in this restaurant’s settings');
    }
    const body = asObject(ctx.body);
    return services.payments.refund({
      paymentId: ctx.params['id']!,
      reason: requireString(body, 'reason', { max: 300 }),
      actor: ctx.state.auth!.actor,
      clientIp: ctx.ip,
    });
  }, [security.requireUser(Permission.PAYMENTS_REFUND)]);

  /* ----------------------------------------------------------- printing */

  router.get('/printers', () => ({
    printers: services.printing.printers.listPrinters(),
    transports: Object.values(PrinterTransport),
    documentTypes: Object.values(PrintDocumentType),
    stations: services.menu.listStations(),
  }), [canManagePrinting]);

  router.post('/printers', (ctx) => {
    const body = asObject(ctx.body);
    const printer = services.printing.printers.createPrinter({
      name: requireString(body, 'name', { max: 80 }),
      transport: requireEnum(body, 'transport', Object.values(PrinterTransport)),
      target: requireString(body, 'target', { max: 200 }),
      documentTypes: requireStringArray(body, 'documentTypes', { max: 10 }) as DocType[],
      stations: body['stations'] !== undefined
        ? requireStringArray(body, 'stations', { max: 40 })
        : [],
      charactersPerLine: optionalNumber(body, 'charactersPerLine', { min: 24, max: 96 }) ?? 42,
      enabled: optionalBoolean(body, 'enabled', true),
    });

    services.audit.record({
      action: 'printer.created',
      actor: ctx.state.auth!.actor,
      entityType: 'printer',
      entityId: printer.id,
      after: { name: printer.name, transport: printer.transport, target: printer.target },
      clientIp: ctx.ip,
    });
    return printer;
  }, [canManagePrinting]);

  router.patch('/printers/:id', (ctx) => {
    const id = ctx.params['id']!;
    if (!services.printing.printers.getPrinter(id)) throw notFound('printer', id);
    const body = asObject(ctx.body);

    services.printing.printers.updatePrinter(id, {
      ...(body['name'] !== undefined ? { name: requireString(body, 'name', { max: 80 }) } : {}),
      ...(body['transport'] !== undefined
        ? { transport: requireEnum(body, 'transport', Object.values(PrinterTransport)) } : {}),
      ...(body['target'] !== undefined
        ? { target: requireString(body, 'target', { max: 200 }) } : {}),
      ...(body['documentTypes'] !== undefined
        ? { documentTypes: requireStringArray(body, 'documentTypes', { max: 10 }) as DocType[] } : {}),
      ...(body['stations'] !== undefined
        ? { stations: requireStringArray(body, 'stations', { max: 40 }) } : {}),
      ...(body['charactersPerLine'] !== undefined
        ? { charactersPerLine: requireNumber(body, 'charactersPerLine', { min: 24, max: 96 }) } : {}),
      ...(body['enabled'] !== undefined ? { enabled: optionalBoolean(body, 'enabled', true) } : {}),
    });
    return services.printing.printers.getPrinter(id);
  }, [canManagePrinting]);

  router.delete('/printers/:id', (ctx) => {
    services.printing.printers.deletePrinter(ctx.params['id']!);
    return { deleted: ctx.params['id'] };
  }, [canManagePrinting]);

  router.get('/print-jobs', () => ({
    jobs: services.printing.printers.recentJobs(100),
  }), [canUsePrinting]);

  router.post('/print-jobs/:id/retry', (ctx) =>
    services.printing.retry(ctx.params['id']!), [canUsePrinting]);

  /** Reprint a receipt — an everyday request at a till. */
  router.post('/orders/:id/print-receipt', async (ctx) => {
    const order = services.orders.repository.get(ctx.params['id']!);
    if (!order) throw notFound('order', ctx.params['id']!);

    const locale = ctx.query.get('locale') ?? services.settings.profile()?.defaultLocale ?? 'en';
    const jobs = await services.printing.printReceipt(
      order, services.payments.billFor(order.id).payments, locale,
    );
    return { jobs };
  }, [security.requireCapability(Capability.PRINTING_RUNTIME), canUsePrinting]);

  router.post('/orders/:id/print-ticket', async (ctx) => {
    const order = services.orders.repository.get(ctx.params['id']!);
    if (!order) throw notFound('order', ctx.params['id']!);

    const locale = ctx.query.get('locale') ?? services.settings.profile()?.defaultLocale ?? 'en';
    return { jobs: await services.printing.printKitchenTicket(order, locale) };
  }, [security.requireCapability(Capability.PRINTING_RUNTIME), canUsePrinting]);

  /**
   * Sound settings for the terminal making the request. A station changes its
   * own alerts without needing management rights (spec §21).
   */
  router.get('/terminal/sound', (ctx) => {
    const terminal = ctx.state.auth?.terminal;
    if (!terminal) throw notFound('terminal session');
    return services.terminalRepository.soundProfile(terminal);
  });

  router.put('/terminal/sound', (ctx) => {
    const terminal = ctx.state.auth?.terminal;
    if (!terminal) throw notFound('terminal session');

    const profile = asObject(ctx.body) as unknown as SoundProfile;
    services.terminalRepository.update(terminal.id, { soundProfile: profile });
    return services.terminalRepository.soundProfile(services.terminalRepository.get(terminal.id)!);
  });

  return router;
}
