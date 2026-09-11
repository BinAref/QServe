/**
 * One account in one place, and nobody signed in to a server that just started.
 *
 * These two rules exist for the same reason: an audit trail is only worth
 * keeping while "who" means one person who is actually there. An account open
 * at the counter and in the back office turns the log into a record of an
 * account, and a till that survives an outage still signed in turns it into a
 * record of somebody who went home.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SystemRole, TerminalType } from '@qserve/shared';

import { LoginRequests } from '../core/login-requests.js';
import { createInstallation, seedUser, type Installation } from './harness.js';

let installation: Installation;

before(() => { installation = createInstallation(); });
after(() => installation.dispose());

describe('a restart signs everybody out', () => {

  test('staff sessions go with the process, station enrolments stay', () => {
    const { access, terminalRepository } = installation.services;
    const cashier = seedUser(installation, 'cashier1', 'Cashier One', [SystemRole.CASHIER]);
    const manager = seedUser(installation, 'manager1', 'Manager One', [SystemRole.MANAGER]);

    const cashierToken = access.createUserSession({
      userId: cashier.id, terminalId: null, ttlSeconds: 3600, clientIp: '127.0.0.1',
    });
    const managerToken = access.createUserSession({
      userId: manager.id, terminalId: null, ttlSeconds: 3600, clientIp: '127.0.0.1',
    });

    const pass = terminalRepository.create({ type: TerminalType.KITCHEN, name: { en: 'Pass' } });
    const passToken = terminalRepository.createSession({
      terminalId: pass.row.id, ttlSeconds: 3600, clientIp: '10.0.0.9', userAgent: null,
    });

    const ended = access.endEveryUserSession();

    assert.equal(ended, 2, 'both people were signed out');
    assert.equal(access.getUserSession(cashierToken), undefined);
    assert.equal(access.getUserSession(managerToken), undefined);

    /*
     * The tablet at the pass is still the pass.
     *
     * A terminal session says which device this is, not who is standing at it.
     * Clearing those too would mean walking the building rescanning QR codes
     * after every power cut — a punishment for the outage rather than a
     * protection against it.
     */
    assert.ok(terminalRepository.getSession(passToken), 'the station is still enrolled');
  });

  test('a second restart with nobody signed in is silent', () => {
    assert.equal(installation.services.access.endEveryUserSession(), 0);
  });
});

describe('a second device has to ask', () => {

  const ask = (requests: LoginRequests, userId: string) => requests.open({
    userId, userName: 'Cashier One', fromIp: '10.0.0.4', fromTerminalName: 'Till 2',
  });

  test('an approval can be spent once', () => {
    const requests = new LoginRequests();
    const request = ask(requests, 'USR-1');

    assert.equal(requests.state(request.id), 'waiting');
    assert.equal(requests.answer(request.id, 'USR-1', true), 'approved');

    assert.ok(requests.claim(request.id), 'the device that asked gets in');
    assert.equal(requests.claim(request.id), null, 'and nobody else does');
    assert.equal(requests.state(request.id), 'expired');
  });

  test('only the account being asked about may answer', () => {
    const requests = new LoginRequests();
    const request = ask(requests, 'USR-1');

    // An id looks guessable, so the door it opens is checked rather than
    // trusted: somebody else's yes is not an answer.
    assert.equal(requests.answer(request.id, 'USR-2', true), null);
    assert.equal(requests.state(request.id), 'waiting');
  });

  test('a refusal is remembered long enough to be read', () => {
    const requests = new LoginRequests();
    const request = ask(requests, 'USR-1');

    assert.equal(requests.answer(request.id, 'USR-1', false), 'denied');
    assert.equal(requests.state(request.id), 'denied');
    assert.equal(requests.claim(request.id), null, 'a no cannot be claimed');
  });

  test('a newer attempt replaces the older question', () => {
    const requests = new LoginRequests();
    const first = ask(requests, 'USR-1');
    const second = ask(requests, 'USR-1');

    // Two dialogs on one screen would leave somebody answering a question that
    // no longer decides anything.
    assert.equal(requests.state(first.id), 'expired');
    assert.deepEqual(requests.pendingFor('USR-1').map((entry) => entry.id), [second.id]);
    assert.equal(requests.state(second.id), 'waiting');
  });

  test('what the incumbent is shown says where the attempt came from', () => {
    const requests = new LoginRequests();
    const request = ask(requests, 'USR-1');
    const [shown] = requests.pendingFor('USR-1');

    assert.ok(shown);
    assert.equal(shown.fromTerminalName, 'Till 2');
    assert.equal(shown.fromIp, '10.0.0.4');
    assert.ok(shown.expiresInSeconds > 0 && shown.expiresInSeconds <= 60);
    assert.equal(shown.id, request.id);
  });
});
