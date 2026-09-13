/**
 * A backup of the menu, and a backup of everything.
 *
 * The distinction matters twice. A restaurant can take the menu before it has
 * a licence, because building the menu is what it does first and losing that
 * to a reinstall would be the worst hour of its week. And restoring the menu
 * has to leave the rest alone — somebody importing "the menu" is not asking to
 * lose last month's takings, and a restore that cleared every table would be
 * exactly the kind of helpfulness nobody recovers from.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BackupScope, IMPORT_GROUPS } from '../modules/backup/service.js';
import { createInstallation, seedRestaurant, seedUser, type Installation } from './harness.js';
import { SystemRole } from '@qserve/shared';

let installation: Installation;
const PASSPHRASE = 'a-long-enough-passphrase';

before(() => { installation = createInstallation(); });
after(() => installation.dispose());

describe('what each scope carries', () => {

  test('the menu file holds the menu and knows nothing of the takings', async () => {
    const { services } = installation;
    seedRestaurant(installation);
    seedUser(installation, 'cashier1', 'Cashier One', [SystemRole.CASHIER]);

    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: 'menu only', scope: BackupScope.MENU,
      actor: installation.systemActor, clientIp: null,
    });

    // The scope is in the name, so a folder of these can be told apart months
    // later by somebody looking for "the menu one".
    assert.match(created.fileName, /-menu-/);

    const file = await services.backup.read(created.fileName);
    const preview = await services.backup.preview(file, PASSPHRASE);

    assert.equal(preview.scope, BackupScope.MENU);
    assert.ok((preview.counts['products'] ?? 0) > 0, 'it carries the dishes');
    assert.equal(preview.counts['people'], undefined, 'and says nothing about staff');
    assert.equal(preview.counts['orders'], undefined, 'or about orders');
  });

  test('the full file holds what a restaurant would need to start again', async () => {
    const { services } = installation;
    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: 'everything', scope: BackupScope.FULL,
      actor: installation.systemActor, clientIp: null,
    });
    assert.match(created.fileName, /-full-/);

    const preview = await services.backup.preview(
      await services.backup.read(created.fileName), PASSPHRASE);

    assert.equal(preview.scope, BackupScope.FULL);
    assert.ok((preview.counts['products'] ?? 0) > 0, 'the dishes');
    assert.ok((preview.counts['people'] ?? 0) > 0, 'and the people');
  });
});

describe('restoring the menu leaves the rest standing', () => {

  test('a menu file replaces the dishes and not the staff', async () => {
    const { services } = installation;
    const db = installation.services.db;

    // A menu file taken now, then the menu changed underneath it.
    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: null, scope: BackupScope.MENU,
      actor: installation.systemActor, clientIp: null,
    });
    const before = db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
    const staffBefore = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    assert.ok(staffBefore.n > 0, 'there is somebody to lose');

    db.prepare('DELETE FROM products').run();
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n, 0);

    await services.backup.restore({
      file: await services.backup.read(created.fileName),
      passphrase: PASSPHRASE,
      actor: installation.systemActor,
      clientIp: null,
    });

    const after = db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
    const staffAfter = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };

    assert.equal(after.n, before.n, 'the dishes came back');
    assert.equal(staffAfter.n, staffBefore.n,
      'and the staff were never touched — this is the whole point of the scope');
  });
});

describe('the preview says what would happen', () => {

  test('it counts what arrives and what it would replace', async () => {
    const { services } = installation;
    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: 'for the preview', scope: BackupScope.MENU,
      actor: installation.systemActor, clientIp: null,
    });

    const preview = await services.backup.preview(
      await services.backup.read(created.fileName), PASSPHRASE);

    // "24 dishes will replace the 24 here" is a sentence somebody can answer.
    // "Are you sure?" is not.
    assert.ok((preview.counts['products'] ?? 0) > 0);
    assert.ok((preview.replaces['products'] ?? 0) > 0);
    assert.equal(preview.restaurantId, installation.services.settings.profile()?.restaurantId);
  });

  test('and a wrong passphrase changes nothing', async () => {
    const { services } = installation;
    const db = installation.services.db;
    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: null, scope: BackupScope.MENU,
      actor: installation.systemActor, clientIp: null,
    });
    const before = db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };

    const file = await services.backup.read(created.fileName);
    await assert.rejects(
      () => services.backup.preview(file, 'wrong-one-here'),
      'a preview with the wrong passphrase must fail',
    );

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n, before.n,
      'and looking must never change anything',
    );
  });
});

describe('taking some of a backup and not the rest', () => {

  test('the preview offers only what the file holds', async () => {
    const { services } = installation;
    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: null, scope: BackupScope.MENU,
      actor: installation.systemActor, clientIp: null,
    });
    const preview = await services.backup.preview(
      await services.backup.read(created.fileName), PASSPHRASE);

    const offered = preview.groups.map((group) => group.name);
    assert.ok(offered.includes('menu'), 'a menu file offers the menu');
    assert.equal(offered.includes('orders'), false,
      'and never offers what it does not contain — a greyed-out list is a worse list');
  });

  test('ticking the dishes and not the photographs leaves the photographs alone', async () => {
    const { services } = installation;
    const db = installation.services.db;

    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: null, scope: BackupScope.MENU,
      actor: installation.systemActor, clientIp: null,
    });

    const productsBefore = (db.prepare('SELECT COUNT(*) AS n FROM products')
      .get() as { n: number }).n;
    db.prepare('DELETE FROM products').run();
    const assetsBefore = (db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n;

    const done = await services.backup.restore({
      file: await services.backup.read(created.fileName),
      passphrase: PASSPHRASE,
      groups: ['menu'],
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.deepEqual(done.groups, ['menu'], 'only what was asked for');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n,
      productsBefore, 'the dishes came back');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n,
      assetsBefore, 'and the photographs were never touched');
  });

  test('choosing orders brings the people who took them', () => {
    // Stated as data rather than discovered at COMMIT: an order names the
    // table, the terminal and the person, and importing it without them
    // produces rows pointing at nobody.
    assert.deepEqual([...IMPORT_GROUPS['orders']!.requires].sort(),
      ['people', 'tables', 'terminals']);
    assert.deepEqual([...IMPORT_GROUPS['tables']!.requires], ['terminals']);
  });

  test('asking for something the file does not have is refused', async () => {
    const { services } = installation;
    const created = await services.backup.create({
      passphrase: PASSPHRASE, note: null, scope: BackupScope.MENU,
      actor: installation.systemActor, clientIp: null,
    });
    const file = await services.backup.read(created.fileName);

    await assert.rejects(() => services.backup.restore({
      file, passphrase: PASSPHRASE, groups: ['orders'],
      actor: installation.systemActor, clientIp: null,
    }), /does not contain/);

    await assert.rejects(() => services.backup.restore({
      file, passphrase: PASSPHRASE, groups: ['everything-please'],
      actor: installation.systemActor, clientIp: null,
    }), /nothing called/);
  });
});
