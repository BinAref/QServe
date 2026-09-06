/**
 * Several currencies on one menu.
 *
 * The property that matters is not that a lira price displays as ₺, it is that
 * a bill stays true: the till settles in one currency, and a line converted at
 * yesterday's rate still says yesterday's number tomorrow.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ActorKind, OrderSource, type Actor } from '@qserve/shared';
import { createInstallation, seedRestaurant, type Installation } from './harness.js';

describe('currencies', () => {
  let installation: Installation;
  let menu: ReturnType<typeof seedRestaurant>;
  let tableId: string;
  let customer: Actor;

  before(() => {
    installation = createInstallation();
    menu = seedRestaurant(installation);
    installation.activate('REST-000001');

    // The harness seeds a restaurant, which seeds the base currency with it.
    installation.services.currencies.seedBase(
      installation.services.settings.profile()!.currency,
    );

    const table = installation.services.terminals.createTable({
      label: 'Table 01', actor: installation.systemActor, clientIp: null,
    });
    tableId = table.tableId;
    customer = {
      kind: ActorKind.CUSTOMER, userId: null, userName: null,
      terminalId: table.terminal.id, terminalName: 'Table 01',
    };
  });
  after(() => installation.dispose());

  test('a fresh restaurant has exactly one currency, and it is the base', () => {
    const { currencies } = installation.services;
    const all = currencies.list();

    assert.equal(all.length, 1);
    assert.equal(all[0]!.isBase, true);
    assert.equal(all[0]!.rateToBase, 1);
    assert.equal(currencies.base().code, 'SAR');
  });

  test('the owner adds a currency by writing its code and symbol', () => {
    const lira = installation.services.currencies.create({
      code: 'try', // typed in lower case, as a person would
      symbol: '₺',
      name: { en: 'Turkish lira', ar: 'ليرة تركية' },
      decimals: 2,
      symbolPosition: 'before',
      rateToBase: 0.11,
    });

    assert.equal(lira.code, 'TRY', 'the code is normalised');
    assert.equal(lira.symbol, '₺');
    assert.equal(lira.isBase, false);
    assert.equal(lira.enabled, true);
  });

  test('two bases are impossible, whatever the caller asks for', () => {
    // The partial unique index is the real guard; this proves it holds.
    assert.throws(
      () => installation.services.db
        .prepare(`INSERT INTO currencies
          (code, symbol, name_json, decimals, symbol_position, rate_to_base,
           is_base, enabled, sort_order, created_at, updated_at)
          VALUES ('USD','$','{}',2,'before',3.75,1,1,0,'now','now')`)
        .run(),
      /UNIQUE/,
    );
  });

  test('the base rate is 1 by definition and cannot be edited away', () => {
    assert.throws(
      () => installation.services.currencies.update('SAR', { rateToBase: 2 }),
      /by definition/,
    );
    assert.throws(
      () => installation.services.currencies.update('SAR', { enabled: false }),
      /always accepted/,
    );
  });

  test('a dish priced in lira is ordered in lira and settled in the base', () => {
    const { menu: menuRepo, orders, currencies } = installation.services;

    // 200.00 TRY at 0.11 SAR per lira → 22.00 SAR.
    const kebab = menuRepo.createProduct({
      categoryId: menu.categoryId,
      name: { en: 'İskender' },
      priceMinor: 20_000,
      currencyCode: 'TRY',
      station: 'grill',
    });

    const order = orders.create({
      tableId,
      source: OrderSource.CUSTOMER,
      actor: customer,
      items: [{ productId: kebab.id, quantity: 1, selections: [], addons: [], notes: null }],
      notes: null,
      guestCount: 1,
      clientIp: null,
    });

    const line = order.items[0]!;
    assert.equal(line.currencyCode, 'TRY', 'the line remembers its own currency');
    assert.equal(line.lineTotalMinor, 20_000, 'and its own price');
    assert.equal(line.rateToBase, 0.11);
    assert.equal(line.baseTotalMinor, 2_200, '200 lira is 22 riyals');

    // The order's totals are one number in one currency: the base.
    assert.equal(order.totals.subtotalMinor, 2_200);
    assert.ok(order.totals.totalMinor >= 2_200);
  });

  test('a bill does not change when the rate moves afterwards', () => {
    const { orders, currencies } = installation.services;
    const before = orders.repository.list({ limit: 1 })[0]!;
    const settled = before.totals.totalMinor;

    // The lira halves overnight.
    currencies.update('TRY', { rateToBase: 0.055 });

    const after = orders.repository.get(before.id)!;
    assert.equal(after.totals.totalMinor, settled, 'the total is history, not a formula');
    assert.equal(after.items[0]!.rateToBase, 0.11, 'the rate used is the rate stored');
    assert.equal(after.items[0]!.baseTotalMinor, 2_200);
  });

  test('an order mixing currencies adds up in the base', () => {
    const { menu: menuRepo, orders } = installation.services;

    // Base-priced burger 25.00 SAR + a 100.00 TRY item at 0.055 → 5.50 SAR.
    const meze = menuRepo.createProduct({
      categoryId: menu.categoryId,
      name: { en: 'Meze' },
      priceMinor: 10_000,
      currencyCode: 'TRY',
    });

    const order = orders.create({
      tableId,
      source: OrderSource.CUSTOMER,
      actor: customer,
      items: [
        {
          productId: menu.burgerId,
          quantity: 1,
          // The burger's "Doneness" is required; Medium adds nothing.
          selections: [{ optionId: menu.optionId, choiceId: menu.choiceMediumId }],
          addons: [],
          notes: null,
        },
        { productId: meze.id, quantity: 1, selections: [], addons: [], notes: null },
      ],
      notes: null,
      guestCount: 1,
      clientIp: null,
    });

    const [burger, mezeLine] = order.items;
    assert.equal(burger!.currencyCode, null, 'the base is stored as null');
    assert.equal(burger!.baseTotalMinor, 2_500);
    assert.equal(mezeLine!.currencyCode, 'TRY');
    assert.equal(mezeLine!.baseTotalMinor, 550);
    assert.equal(order.totals.subtotalMinor, 3_050, '25.00 + 5.50 SAR');
  });

  test('a currency still on the menu cannot be deleted', () => {
    assert.throws(
      () => installation.services.currencies.delete('TRY'),
      /still used/,
    );
    assert.throws(
      () => installation.services.currencies.delete('SAR'),
      /base currency cannot be removed/,
    );
  });

  test('moving the base re-expresses every other rate', () => {
    const other = createInstallation();
    try {
      seedRestaurant(other);
      other.services.currencies.seedBase(other.services.settings.profile()!.currency);
      other.services.currencies.create({
        code: 'USD', symbol: '$', decimals: 2, symbolPosition: 'before', rateToBase: 3.75,
      });

      // One dollar is 3.75 riyals; make the dollar the base.
      other.services.currencies.setBase('USD');

      const dollar = other.services.currencies.get('USD')!;
      const riyal = other.services.currencies.get('SAR')!;

      assert.equal(dollar.isBase, true);
      assert.equal(dollar.rateToBase, 1);
      assert.equal(riyal.isBase, false);
      // One riyal is now 1/3.75 dollars, to the precision a float allows.
      assert.ok(Math.abs(riyal.rateToBase - 1 / 3.75) < 1e-12);
    } finally {
      other.dispose();
    }
  });

  test('a restore brings the currencies back with the menu', async () => {
    const { backup, currencies } = installation.services;
    const before = currencies.list().map((currency) => currency.code).sort();

    const created = await backup.create({
      passphrase: 'a-long-enough-passphrase',
      note: 'currencies',
      actor: installation.systemActor,
      clientIp: null,
    });

    // Lose the lira, then restore.
    installation.services.db.prepare('DELETE FROM products WHERE currency_code = ?').run('TRY');
    currencies.delete('TRY');
    assert.equal(currencies.has('TRY'), false);

    await backup.restore({
      file: await backup.read(created.fileName),
      passphrase: 'a-long-enough-passphrase',
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.deepEqual(currencies.list().map((currency) => currency.code).sort(), before);
    assert.equal(currencies.get('TRY')!.symbol, '₺');
  });
});
