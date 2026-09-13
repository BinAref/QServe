/**
 * What a printed table card gives away.
 *
 * A card sits on a table in a public room. Anybody can photograph it, and the
 * link it carries used to read `/r/REST-000001/TABLE-7?k=…` — which told them
 * the restaurant's id, that there is a table 7, and that table 8 is probably
 * one character away. The token always gated it, so nothing was ever reachable
 * that way; but a link whose shape is an invitation is a link people accept,
 * and the count of a restaurant's tables is not theirs to hand out.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TerminalType } from '@qserve/shared';
import { createInstallation, seedRestaurant, type Installation } from './harness.js';

let installation: Installation;

before(() => {
  installation = createInstallation();
  // A card names a restaurant's station, so there has to be a restaurant.
  seedRestaurant(installation);
  /*
   * A card has to point somewhere. The address is normally learned when the
   * LAN listener binds, and no listener binds in a harness — so it is told
   * one, which is exactly what `start()` does on a real machine.
   */
  installation.services.setLanBaseUrl('http://qserve-test.local:7020');
});
after(() => installation.dispose());

describe('the link on a table card', () => {

  test('names neither the table nor the restaurant', () => {
    const { terminals, terminalRepository, settings } = installation.services;

    const created = terminalRepository.create({
      type: TerminalType.TABLE, name: { en: 'Table 7' },
    });
    const url = terminals.qrUrlFor(created.row);
    assert.ok(url, 'there is a link at all');

    const restaurantId = settings.profile()!.restaurantId;
    assert.equal(url!.includes(restaurantId), false, 'the restaurant is not in it');
    assert.equal(url!.includes('TABLE'), false, 'nor is the table');
    assert.equal(url!.includes(created.row.id), false, 'nor the terminal id');
    assert.match(url!, /\/t\/[A-Za-z0-9_-]{16,}$/, 'one opaque segment and nothing else');
  });

  test('two tables share nothing but the host', () => {
    const { terminals, terminalRepository } = installation.services;
    const one = terminalRepository.create({ type: TerminalType.TABLE, name: { en: 'A' } });
    const two = terminalRepository.create({ type: TerminalType.TABLE, name: { en: 'B' } });

    const first = terminals.qrUrlFor(one.row)!.split('/t/')[1];
    const second = terminals.qrUrlFor(two.row)!.split('/t/')[1];

    assert.notEqual(first, second);
    // Not adjacent, not sequential, nothing to increment.
    assert.equal(first!.slice(0, 8) === second!.slice(0, 8), false);
  });

  test('the code opens its own station and no other', () => {
    const { terminals, terminalRepository } = installation.services;
    const pass = terminalRepository.create({ type: TerminalType.KITCHEN, name: { en: 'Pass' } });
    const table = terminalRepository.create({ type: TerminalType.TABLE, name: { en: 'One' } });

    assert.equal(terminals.resolveToken(pass.enrolToken)?.row.id, pass.row.id);
    assert.equal(terminals.resolveToken(table.enrolToken)?.row.id, table.row.id);
    assert.equal(terminals.resolveToken('not-a-real-token-at-all'), null);
    assert.equal(terminals.resolveToken(''), null);
  });

  test('rotating a code retires the card that carried it', () => {
    const { terminals, terminalRepository } = installation.services;
    const created = terminalRepository.create({ type: TerminalType.TABLE, name: { en: 'Nine' } });
    const printed = created.enrolToken;

    assert.ok(terminals.resolveToken(printed), 'the printed card works');

    terminalRepository.regenerateEnrolToken(created.row.id);

    // Which is the point of rotating: a card left in a drawer, or photographed
    // by somebody who should not have it, stops opening anything.
    assert.equal(terminals.resolveToken(printed), null);
  });
});
