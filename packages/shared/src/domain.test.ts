/**
 * Domain rules that the whole product leans on. These run without a database,
 * a server or a browser, which is the point: the rules are testable in
 * isolation (spec §54).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTransition, canTransition, nextStatuses, InvalidOrderTransitionError,
  KITCHEN_QUEUE_STATUSES, OPEN_ORDER_STATUSES,
} from './order-state-machine.js';
import { OrderStatus, RestaurantMode } from './enums.js';
import {
  DEFAULT_ROLE_PERMISSIONS, Permission, SystemRole, TERMINAL_TYPE_CEILING,
  grants, intersectPermissions, WILDCARD_PERMISSION,
} from './permissions.js';
import { Capability, capabilitiesForMode, isCapabilityAvailable, SETUP_CAPABILITIES } from './capabilities.js';
import {
  amountToInput, computeTotals, formatMoney, lineTotal, applyRate, parseAmount,
  sanitiseAmountInput, toBaseMinor, DEFAULT_CURRENCY,
} from './money.js';
import { encodeLicenseKey, generateLicenseKey, normaliseLicenseKey } from './license-key.js';
import { formatRestaurantId, formatLicenseId, formatTableId, monotonicCode, newOrderId, isOrderId } from './ids.js';
import { pickLocalised } from './validate.js';

/* ------------------------------------------------------- state machine */

test('order state machine follows the specified chain', () => {
  const chain = [
    OrderStatus.NEW, OrderStatus.ACCEPTED, OrderStatus.PREPARING,
    OrderStatus.READY, OrderStatus.SERVED, OrderStatus.PAID, OrderStatus.CLOSED,
  ];
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.ok(canTransition(chain[i]!, chain[i + 1]!), `${chain[i]} → ${chain[i + 1]}`);
  }
});

test('order state machine refuses skipped stages', () => {
  assert.equal(canTransition(OrderStatus.NEW, OrderStatus.READY), false);
  assert.equal(canTransition(OrderStatus.NEW, OrderStatus.PAID), false);
  assert.equal(canTransition(OrderStatus.ACCEPTED, OrderStatus.SERVED), false);
  assert.throws(
    () => assertTransition(OrderStatus.NEW, OrderStatus.READY),
    (error: unknown) => error instanceof InvalidOrderTransitionError && error.status === 409,
  );
});

test('a closed, cancelled or rejected order is final', () => {
  for (const terminalStatus of [OrderStatus.CLOSED, OrderStatus.CANCELLED, OrderStatus.REJECTED]) {
    assert.equal(nextStatuses(terminalStatus).length, 0, terminalStatus);
  }
});

test('paying is reachable from READY as well as SERVED, for counter service', () => {
  assert.ok(canTransition(OrderStatus.READY, OrderStatus.PAID));
  assert.ok(canTransition(OrderStatus.SERVED, OrderStatus.PAID));
});

test('cancelling requires orders.cancel, not merely orders.change_status', () => {
  const cancel = assertTransition(OrderStatus.PREPARING, OrderStatus.CANCELLED);
  assert.equal(cancel.permission, Permission.ORDERS_CANCEL);
  assert.equal(cancel.destructive, true);

  const accept = assertTransition(OrderStatus.NEW, OrderStatus.ACCEPTED);
  assert.equal(accept.permission, Permission.ORDERS_CHANGE_STATUS);
});

test('an order on hold does not hold a table open forever', () => {
  assert.ok(OPEN_ORDER_STATUSES.includes(OrderStatus.ON_HOLD));
  assert.equal(OPEN_ORDER_STATUSES.includes(OrderStatus.CANCELLED), false);
  assert.equal(KITCHEN_QUEUE_STATUSES.includes(OrderStatus.PAID), false);
});

/* --------------------------------------------------------- permissions */

test('wildcard and scope wildcards grant correctly', () => {
  assert.ok(grants([WILDCARD_PERMISSION], Permission.PAYMENTS_REFUND));
  assert.ok(grants(['orders.*'], Permission.ORDERS_CANCEL));
  assert.equal(grants(['orders.*'], Permission.PAYMENTS_CREATE), false);
  assert.equal(grants([Permission.ORDERS_VIEW], Permission.ORDERS_CANCEL), false);
});

test('effective permissions are the intersection of terminal and user', () => {
  // A manager signing in on a kitchen screen gets kitchen powers, not manager
  // powers — the property the spec's §23 permission model depends on.
  const kitchenCeiling = TERMINAL_TYPE_CEILING['KITCHEN']!;
  const managerGrants = DEFAULT_ROLE_PERMISSIONS[SystemRole.MANAGER];

  const effective = intersectPermissions(kitchenCeiling, managerGrants);
  assert.ok(effective.includes(Permission.KITCHEN_VIEW));
  assert.equal(effective.includes(Permission.PAYMENTS_REFUND), false);
  assert.equal(effective.includes(Permission.USERS_MANAGE), false);
});

test('a table terminal can order but can never manage anything', () => {
  const ceiling = TERMINAL_TYPE_CEILING['TABLE']!;
  assert.ok(ceiling.includes(Permission.ORDERS_CREATE));
  assert.equal(ceiling.includes(Permission.ORDERS_CANCEL), false);
  assert.equal(ceiling.includes(Permission.PAYMENTS_CREATE), false);
  assert.equal(ceiling.includes(Permission.SETTINGS_MANAGE), false);
});

test('only ADMIN holds the wildcard by default', () => {
  for (const role of Object.values(SystemRole)) {
    const holdsWildcard = DEFAULT_ROLE_PERMISSIONS[role].includes(WILDCARD_PERMISSION);
    assert.equal(holdsWildcard, role === SystemRole.ADMIN, role);
  }
});

/* -------------------------------------------------------- capabilities */

test('SETUP grants authoring and backup but no live service', () => {
  const setup = capabilitiesForMode(RestaurantMode.SETUP);
  assert.deepEqual([...setup].sort(), [...SETUP_CAPABILITIES].sort());

  for (const locked of [
    Capability.LAN_SERVER, Capability.TABLES_PROVISION, Capability.TERMINALS_PROVISION,
    Capability.ORDERS_RUNTIME, Capability.KITCHEN_RUNTIME, Capability.CASHIER_RUNTIME,
    Capability.WAITER_RUNTIME, Capability.PRINTING_RUNTIME, Capability.REPORTS_RUNTIME,
  ]) {
    assert.equal(isCapabilityAvailable(RestaurantMode.SETUP, locked), false, locked);
    assert.equal(isCapabilityAvailable(RestaurantMode.OPERATIONAL, locked), true, locked);
  }
});

test('menu authoring and backup are never gated', () => {
  // The commercial promise: a restaurant owns what it typed before it paid.
  for (const always of [Capability.MENU_AUTHORING, Capability.BRANDING, Capability.BACKUP]) {
    assert.ok(isCapabilityAvailable(RestaurantMode.SETUP, always), always);
  }
});

/* --------------------------------------------------------------- money */

test('exclusive tax is added on top', () => {
  const totals = computeTotals({ lineTotalsMinor: [10_000], taxRatePercent: 15 });
  assert.deepEqual(totals, {
    subtotalMinor: 10_000, discountMinor: 0, taxMinor: 1_500,
    serviceMinor: 0, totalMinor: 11_500,
  });
});

test('inclusive tax is extracted, not added', () => {
  const totals = computeTotals({ lineTotalsMinor: [11_500], taxRatePercent: 15, taxInclusive: true });
  assert.equal(totals.totalMinor, 11_500, 'the diner still pays the listed price');
  assert.equal(totals.taxMinor, 1_500);
});

test('service charge is taxed, and discount comes off first', () => {
  const totals = computeTotals({
    lineTotalsMinor: [10_000], discountMinor: 2_000,
    serviceRatePercent: 10, taxRatePercent: 15,
  });
  assert.equal(totals.discountMinor, 2_000);
  assert.equal(totals.serviceMinor, 800);            // 10% of 8 000
  assert.equal(totals.taxMinor, 1_320);              // 15% of 8 800
  assert.equal(totals.totalMinor, 10_120);
});

test('a discount can never exceed the subtotal', () => {
  const totals = computeTotals({ lineTotalsMinor: [5_000], discountMinor: 9_999_999 });
  assert.equal(totals.discountMinor, 5_000);
  assert.equal(totals.totalMinor, 0);
});

test('line totals include option deltas and add-ons per unit', () => {
  // 25.00 burger + 2.00 well-done + 3.00 cheese, taken twice.
  assert.equal(lineTotal(2_500, [200, 300], 2), 6_000);
});

test('rates round half-up and never drift', () => {
  assert.equal(applyRate(3_333, 15), 500);
  assert.equal(formatMoney(123_456, DEFAULT_CURRENCY, 'en-US'), '1,234.56 SAR');
});

/* --------------------------------------------------------- licence key */

test('licence keys round-trip and reject a mistyped character', () => {
  const key = generateLicenseKey();
  assert.match(key, /^QSRV(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
  assert.equal(normaliseLicenseKey(key), key);

  // Sloppy input a human would actually produce.
  assert.equal(normaliseLicenseKey(key.toLowerCase().replaceAll('-', ' ')), key);

  const body = key.replaceAll('-', '').slice(4);
  const mutated = `${body.slice(0, 3)}${body[3] === '0' ? '1' : '0'}${body.slice(4)}`;
  assert.equal(normaliseLicenseKey(`QSRV${mutated}`), null, 'checksum must catch a single typo');
});

test('confusable characters are normalised, not rejected', () => {
  const key = encodeLicenseKey('0123456789ABCDEFGHJ');
  // Someone reading a key aloud says "oh" for zero and "eye" for one.
  const spoken = key.replace('0', 'O').replace('1', 'I');
  assert.equal(normaliseLicenseKey(spoken), key);
});

/* ------------------------------------------------------------ identity */

test('vendor identifiers are formatted predictably', () => {
  assert.equal(formatRestaurantId(123), 'REST-000123');
  assert.equal(formatLicenseId(2026, 123), 'LIC-2026-000123');
  assert.throws(() => formatRestaurantId(1_000_000));
});

test('table labels converge on one id however they are written', () => {
  for (const label of ['5', '05', 'Table 05', 'TABLE-05', 'table-05', ' 05 ']) {
    assert.equal(formatTableId(label), label.trim() === '5' ? 'TABLE-5' : 'TABLE-05', label);
  }
  // A non-numeric label keeps its own words rather than being mangled.
  assert.equal(formatTableId('Terrace 3'), 'TABLE-TERRACE-3');
  assert.equal(formatTableId('Table'), 'TABLE-TABLE');
  assert.throws(() => formatTableId('   '));
});

test('order ids sort by creation time', () => {
  const early = newOrderId(1_700_000_000_000);
  const later = newOrderId(1_800_000_000_000);
  assert.ok(isOrderId(early) && isOrderId(later));
  assert.ok(early < later, 'ids must be lexicographically sortable by time');
  assert.notEqual(monotonicCode(6), monotonicCode(6));
});

/* ---------------------------------------------------------- localised */

test('localised text falls back predictably', () => {
  const value = { en: 'Burger', ar: 'برجر' };
  assert.equal(pickLocalised(value, 'ar'), 'برجر');
  assert.equal(pickLocalised(value, 'ar-SA'), 'برجر', 'region falls back to language');
  assert.equal(pickLocalised(value, 'tr'), 'Burger', 'unknown locale falls back to reference');
  assert.equal(pickLocalised({ '*': 'Sole' }, 'tr'), 'Sole', 'single-language installs use *');
  assert.equal(pickLocalised({}, 'en'), '');
});

/* ---------------------------------------------------- typing a price by hand */

test('a plain price parses to minor units', () => {
  assert.deepEqual(parseAmount('12.50', 2), { ok: true, minor: 1250, problem: null });
  assert.equal(parseAmount('7', 2).minor, 700, 'a whole number is padded');
  assert.equal(parseAmount('0.05', 2).minor, 5);
  assert.equal(parseAmount('1.5', 2).minor, 150, 'one decimal is padded to two');
  assert.equal(parseAmount(' 3.20 ', 2).minor, 320, 'surrounding space is not an error');
  assert.equal(parseAmount('1500', 0).minor, 1500, 'a zero-decimal currency');
});

test('anything that is not a digit or a point is refused, and named', () => {
  for (const bad of ['12a', '1,50', '12 50', '-5', '١٢', '12٫5', '$12']) {
    const result = parseAmount(bad, 2);
    assert.equal(result.ok, false, `${bad} should be refused`);
  }
  // The typist is told which character was wrong, not merely that one was.
  assert.deepEqual(parseAmount('1,50', 2).problem, {
    messageKey: 'amount.error.digits_only',
    params: { character: ',' },
  });
});

test('the decimal point is refused where it cannot mean anything', () => {
  assert.equal(parseAmount('12.', 2).problem?.messageKey, 'amount.error.trailing_point');
  assert.equal(parseAmount('1.2.3', 2).problem?.messageKey, 'amount.error.one_point');
  assert.equal(parseAmount('.5', 2).problem?.messageKey, 'amount.error.leading_point');
  assert.equal(parseAmount('12.345', 2).problem?.messageKey, 'amount.error.too_many_decimals');
  assert.equal(parseAmount('12.5', 0).problem?.messageKey, 'amount.error.no_decimals');
  assert.equal(parseAmount('', 2).problem?.messageKey, 'amount.error.required');
});

test('the keystroke filter refuses what the parser would reject', () => {
  assert.equal(sanitiseAmountInput('12a.5x0', 2), '12.50');
  assert.equal(sanitiseAmountInput('1.2.3', 2), '1.23', 'the second point becomes a digit position');
  assert.equal(sanitiseAmountInput('.5', 2), '5', 'a leading point cannot be typed at all');
  assert.equal(sanitiseAmountInput('12.999', 2), '12.99', 'precision is capped as it is typed');
  assert.equal(sanitiseAmountInput('12.5', 0), '125', 'a zero-decimal currency takes no point');
  assert.equal(sanitiseAmountInput('-12', 2), '12');

  // Whatever the filter allows through, the parser must accept — otherwise a
  // field could sit in a state the typist cannot fix.
  for (const raw of ['12a.5x0', '1.2.3', '12.999', '0.07']) {
    const filtered = sanitiseAmountInput(raw, 2);
    if (filtered !== '' && !filtered.endsWith('.')) {
      assert.equal(parseAmount(filtered, 2).ok, true, `${filtered} should parse`);
    }
  }
});

test('a price survives the round trip back into the field', () => {
  for (const minor of [0, 5, 1250, 999_999]) {
    assert.equal(parseAmount(amountToInput(minor, 2), 2).minor, minor);
  }
  assert.equal(amountToInput(1500, 0), '1500');
});

/* ------------------------------------------------------ several currencies */

test('converting to the base currency rounds once, at the end', () => {
  // 100.00 TRY at 0.0982 SAR per lira.
  assert.equal(toBaseMinor(10_000, 0.0982, 2, 2), 982);
  // The base converts to itself untouched, whatever the arithmetic would say.
  assert.equal(toBaseMinor(1234, 1, 2, 2), 1234);
  // Different precision on each side: 1500 JPY (0 decimals) at 0.025.
  assert.equal(toBaseMinor(1500, 0.025, 2, 0), 3750);
});
