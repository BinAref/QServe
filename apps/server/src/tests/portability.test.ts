/**
 * Data portability and contracts that span the server/browser boundary:
 * backup and restore (spec §7), QR addressing (§8), and the constants the
 * front-ends mirror.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Capability, EVENT_CATALOGUE, OrderSource, OrderStatus, Permission, SOUND_EVENTS,
  TERMINAL_TYPES, TableStatus, PaymentMethod, PrintDocumentType, PrinterTransport,
  Topic, amountToInput, hasBlockingIssues, parseAmount, sanitiseAmountInput, toBaseMinor,
  validateLocalePack, validateThemePack, type LocalePack,
} from '@qserve/shared';
import { BackupService } from '../modules/backup/service.js';
import { createInstallation, seedRestaurant, seedUser } from './harness.js';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

describe('backup and restore', () => {
  test('a backup carries the restaurant to a new machine intact', async () => {
    const source = createInstallation();
    const target = createInstallation();
    try {
      const menu = seedRestaurant(source);
      source.activate('REST-000001');
      seedUser(source, 'ahmed', 'Ahmed', ['WAITER']);
      const table = source.services.terminals.createTable({
        label: 'Table 05', actor: source.systemActor, clientIp: null,
      });
      const order = source.services.orders.create({
        tableId: table.tableId, source: OrderSource.CUSTOMER, actor: source.systemActor,
        items: [{ productId: menu.friesId, quantity: 2, selections: [], addons: [], notes: 'crispy' }],
        notes: null, guestCount: 2, clientIp: null,
      });
      const qrBefore = source.services.terminals.qrUrlFor(
        source.services.terminalRepository.get(table.terminal.id)!,
      );

      const descriptor = await source.services.backup.create({
        passphrase: 'restaurant-backup-2026', note: 'before the move',
        actor: source.systemActor, clientIp: null,
      });
      const file = await source.services.backup.read(descriptor.fileName);

      // The new machine has nothing at all on it.
      assert.equal(target.services.settings.profile(), null);

      const result = await target.services.backup.restore({
        file, passphrase: 'restaurant-backup-2026',
        actor: target.systemActor, clientIp: null,
      });
      assert.equal(result.restaurantId, 'REST-000001');

      const restored = target.services;
      assert.equal(restored.settings.profile()?.restaurantId, 'REST-000001');
      assert.equal(restored.menu.listProducts().length, 2);
      assert.equal(restored.tables.list().length, 1);
      assert.equal(restored.access.listUsers().length, 1);

      const restoredOrder = restored.orderRepository.get(order.id)!;
      assert.equal(restoredOrder.number, order.number);
      assert.equal(restoredOrder.items[0]!.notes, 'crispy');
      assert.equal(restoredOrder.totals.totalMinor, order.totals.totalMinor);
      assert.ok(restored.audit.orderTimeline(order.id).length > 0, 'history comes across too');

      // The whole point of spec §8: the printed table cards still work.
      restored.setLanBaseUrl('http://qserve-test.local:7020');
      const qrAfter = restored.terminals.qrUrlFor(
        restored.terminalRepository.get(table.terminal.id)!,
      );
      assert.equal(qrAfter, qrBefore, 'a restored restaurant must not reprint its QR codes');
    } finally {
      source.dispose();
      target.dispose();
    }
  });

  test('a restore does not carry the licence, so new hardware is a transfer', async () => {
    const source = createInstallation();
    const target = createInstallation();
    try {
      seedRestaurant(source);
      source.activate('REST-000001');

      const descriptor = await source.services.backup.create({
        passphrase: 'restaurant-backup-2026', note: null,
        actor: source.systemActor, clientIp: null,
      });
      const file = await source.services.backup.read(descriptor.fileName);

      await target.services.backup.restore({
        file, passphrase: 'restaurant-backup-2026',
        actor: target.systemActor, clientIp: null,
      });

      // The data arrived; the entitlement did not.
      assert.equal(target.services.menu.listProducts().length, 2);
      const snapshot = target.services.gate.evaluate('REST-000001' as never);
      assert.equal(snapshot.mode, 'SETUP');
      assert.throws(() => target.services.gate.assert(Capability.ORDERS_RUNTIME));
    } finally {
      source.dispose();
      target.dispose();
    }
  });

  test('the backed-up table list excludes sessions and licence state', () => {
    const tables = BackupService.backedUpTables;
    for (const excluded of ['user_sessions', 'terminal_sessions', 'license_state', 'schema_migrations']) {
      assert.equal(tables.includes(excluded), false, excluded);
    }
    for (const included of ['restaurant', 'products', 'orders', 'payments', 'terminals', 'audit_log']) {
      assert.ok(tables.includes(included), included);
    }
  });

  test('a wrong passphrase leaves the target untouched', async () => {
    const source = createInstallation();
    const target = createInstallation();
    try {
      seedRestaurant(source);
      seedRestaurant(target);
      const before = target.services.menu.listProducts().length;

      const descriptor = await source.services.backup.create({
        passphrase: 'the-right-passphrase', note: null,
        actor: source.systemActor, clientIp: null,
      });
      const file = await source.services.backup.read(descriptor.fileName);

      await assert.rejects(
        () => target.services.backup.restore({
          file, passphrase: 'the-wrong-passphrase',
          actor: target.systemActor, clientIp: null,
        }),
        (error: unknown) => (error as { code: string }).code === 'CONFLICT',
      );
      assert.equal(target.services.menu.listProducts().length, before, 'nothing was destroyed');
    } finally {
      source.dispose();
      target.dispose();
    }
  });
});

describe('QR addressing', () => {
  test('a QR encodes Restaurant ID + Table ID, not an IP address', () => {
    const installation = createInstallation();
    try {
      seedRestaurant(installation);
      installation.activate('REST-000123');

      const table = installation.services.terminals.createTable({
        label: 'Table 05', actor: installation.systemActor, clientIp: null,
      });
      const url = installation.services.terminals.qrUrlFor(
        installation.services.terminalRepository.get(table.terminal.id)!,
      )!;

      assert.ok(url.includes('/r/REST-000123/TABLE-05'), url);
      assert.ok(url.startsWith('http://qserve-test.local:'), 'a stable host, not an IP');
      assert.equal(/\d+\.\d+\.\d+\.\d+/.test(url), false, 'no hard-coded address');
    } finally {
      installation.dispose();
    }
  });

  test('a scan is accepted only for the right restaurant, target and secret', () => {
    const installation = createInstallation();
    try {
      seedRestaurant(installation);
      installation.activate('REST-000123');

      const table = installation.services.terminals.createTable({
        label: 'Table 05', actor: installation.systemActor, clientIp: null,
      });
      const row = installation.services.terminalRepository.get(table.terminal.id)!;
      const { terminals } = installation.services;

      assert.ok(terminals.resolveScan({
        restaurantId: 'REST-000123', target: 'TABLE-05', token: row.enrol_token,
      }));
      // Each failure returns the same null, so a scanner learns nothing by probing.
      assert.equal(terminals.resolveScan({
        restaurantId: 'REST-999999', target: 'TABLE-05', token: row.enrol_token }), null);
      assert.equal(terminals.resolveScan({
        restaurantId: 'REST-000123', target: 'TABLE-99', token: row.enrol_token }), null);
      assert.equal(terminals.resolveScan({
        restaurantId: 'REST-000123', target: 'TABLE-05', token: 'guessed' }), null);

      // Rotating the code invalidates cards already printed.
      terminals.rotateQr({ terminalId: row.id, actor: installation.systemActor, clientIp: null });
      assert.equal(terminals.resolveScan({
        restaurantId: 'REST-000123', target: 'TABLE-05', token: row.enrol_token }), null);
    } finally {
      installation.dispose();
    }
  });

  test('a scan lands each station on its own application', () => {
    const installation = createInstallation();
    try {
      seedRestaurant(installation);
      installation.activate('REST-000123');
      const { terminals, terminalRepository } = installation.services;

      const expected: Record<string, string> = {
        KITCHEN: '/kitchen', CASHIER: '/cashier', WAITER: '/waiter',
        BAR: '/kitchen', KDS: '/kitchen', PRINTER: '/printer',
      };
      for (const [type, path] of Object.entries(expected)) {
        const created = terminals.createTerminal({
          type: type as never, name: { en: type },
          actor: installation.systemActor, clientIp: null,
        });
        const row = terminalRepository.get(created.id)!;
        const resolved = terminals.resolveScan({
          restaurantId: 'REST-000123', target: row.id, token: row.enrol_token,
        });
        assert.equal(resolved?.landingPath, path, type);
      }
    } finally {
      installation.dispose();
    }
  });
});

describe('shipped packs', () => {
  test('every locale in locales/ validates against the reference', () => {
    const dir = join(repoRoot, 'locales');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(files.includes('en.json') && files.includes('ar.json') && files.includes('tr.json'));

    const rawReference = readFileSync(join(dir, 'en.json'), 'utf8');
    const reference = JSON.parse(rawReference) as LocalePack;
    assert.equal(hasBlockingIssues(validateLocalePack(reference, { rawSource: rawReference })), false);

    for (const file of files) {
      const raw = readFileSync(join(dir, file), 'utf8');
      const pack = JSON.parse(raw) as LocalePack;
      const issues = validateLocalePack(pack, {
        rawSource: raw,
        ...(pack.locale === 'en' ? {} : { reference, strictCoverage: true }),
      });
      assert.equal(hasBlockingIssues(issues), false,
        `${file}: ${issues.filter((i) => i.severity === 'error').map((i) => `${i.kind} ${i.key ?? ''}`).join('; ')}`);
    }
  });

  test('Arabic ships as RTL, so the layout flips without a second stylesheet', () => {
    const arabic = JSON.parse(readFileSync(join(repoRoot, 'locales/ar.json'), 'utf8')) as LocalePack;
    assert.equal(arabic.direction, 'rtl');
    assert.equal(arabic.fallback, 'en');
  });

  test('every theme in themes/ defines the full token contract', () => {
    const dir = join(repoRoot, 'themes');
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    assert.ok(files.length >= 5, 'light, dark, modern, classic and elegant ship');

    for (const file of files) {
      const issues = validateThemePack(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      assert.deepEqual(issues, [], `${file}: ${issues.map((i) => i.detail).join('; ')}`);
    }
  });
});

describe('browser constants mirror', () => {
  /**
   * The terminals cannot import the TypeScript package, so they carry a hand
   * written mirror. This is what stops the two drifting: add an order status on
   * one side only and this test fails.
   */
  test('apps/web/shared/events.js matches @qserve/shared exactly', async () => {
    const mirror = await import(
      new URL('../../../web/shared/events.js', import.meta.url).href
    ) as Record<string, Record<string, string>>;

    const expectations: [string, readonly string[]][] = [
      ['SoundEvent', SOUND_EVENTS],
      ['EventName', EVENT_CATALOGUE.map((entry) => entry.name)],
      ['Topic', Object.values(Topic)],
      ['OrderStatus', Object.values(OrderStatus)],
      ['OrderSource', Object.values(OrderSource)],
      ['TableStatus', Object.values(TableStatus)],
      ['TerminalType', TERMINAL_TYPES],
      ['PaymentMethod', Object.values(PaymentMethod)],
      ['PrintDocumentType', Object.values(PrintDocumentType)],
      ['PrinterTransport', Object.values(PrinterTransport)],
      ['Capability', Object.values(Capability)],
      ['Permission', Object.values(Permission)],
    ];

    for (const [name, values] of expectations) {
      const mirrored = mirror[name];
      assert.ok(mirrored, `apps/web/shared/events.js is missing ${name}`);
      assert.deepEqual(
        Object.values(mirrored).sort(),
        [...values].sort(),
        `${name} has drifted between the server and the terminals`,
      );
    }
  });

  /**
   * The amount rules exist twice on purpose: the field has to answer a typist
   * on the keystroke, and the server has to refuse without explaining itself.
   * This is what stops "the browser accepted it but the server refused".
   */
  test('the mirrored amount parser agrees with the server’s, character for character', async () => {
    const mirror = await import(
      new URL('../../../web/shared/money.js', import.meta.url).href
    ) as {
      parseAmount: (raw: string, decimals: number) => {
        ok: boolean; minor: number; problem: { messageKey: string } | null;
      };
      sanitiseAmountInput: (raw: string, decimals: number) => string;
      amountToInput: (minor: number, decimals: number) => string;
      toBaseMinor: (m: number, r: number, b: number, c: number) => number;
    };

    const cases = [
      '12.50', '7', '0.05', '1.5', ' 3.20 ', '1500', '0',
      '12a', '1,50', '12 50', '-5', '١٢', '$12', '12.', '.5', '1.2.3',
      '12.345', '', '   ', '00.10', '999999999999999999',
    ];

    for (const decimals of [0, 2, 3]) {
      for (const raw of cases) {
        assert.deepEqual(
          mirror.parseAmount(raw, decimals),
          parseAmount(raw, decimals),
          `parseAmount("${raw}", ${decimals}) has drifted`,
        );
        assert.equal(
          mirror.sanitiseAmountInput(raw, decimals),
          sanitiseAmountInput(raw, decimals),
          `sanitiseAmountInput("${raw}", ${decimals}) has drifted`,
        );
      }
    }

    for (const minor of [0, 5, 1250, 999_999]) {
      assert.equal(mirror.amountToInput(minor, 2), amountToInput(minor, 2));
    }
    assert.equal(mirror.toBaseMinor(10_000, 0.0982, 2, 2), toBaseMinor(10_000, 0.0982, 2, 2));
  });

  test('the mirrored permission check behaves like the server’s', async () => {
    const mirror = await import(
      new URL('../../../web/shared/events.js', import.meta.url).href
    ) as { grants: (granted: string[], required: string) => boolean };

    assert.ok(mirror.grants(['*'], Permission.PAYMENTS_REFUND));
    assert.ok(mirror.grants(['orders.*'], Permission.ORDERS_CANCEL));
    assert.equal(mirror.grants([Permission.ORDERS_VIEW], Permission.ORDERS_CANCEL), false);
    assert.equal(mirror.grants([], Permission.MENU_VIEW), false);
  });
});
