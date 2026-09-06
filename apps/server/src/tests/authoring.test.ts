/**
 * The restaurant's own languages and themes, and the optional app lock.
 *
 * These are the features an owner reaches for after the menu is built, and
 * they share one property worth testing hard: they change what every terminal
 * sees, so a mistake here is visible on a diner's phone.
 */

import test, { after, before, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { REFERENCE_LOCALE } from '../modules/translations/service.js';
import { TRANSLATION_BUNDLE_SCHEMA } from '../modules/translations/content.js';
import { createInstallation, seedRestaurant, type Installation } from './harness.js';

describe('authoring a language', () => {
  let installation: Installation;
  let menu: ReturnType<typeof seedRestaurant>;

  before(() => {
    installation = createInstallation();
    menu = seedRestaurant(installation);
  });
  after(() => installation.dispose());

  test('the exported bundle carries every text the owner typed', () => {
    const bundle = installation.services.packAuthoring.exportBundle({
      targetLocale: 'fr',
      sourceLocale: 'en',
      mode: 'source',
    });

    assert.equal(bundle.$schema, TRANSLATION_BUNDLE_SCHEMA);
    assert.ok(Object.keys(bundle.ui).length > 100, 'the interface half is present');

    // The whole point: the menu the owner built is in the file too.
    const texts = Object.values(bundle.content);
    for (const expected of ['Grill', 'Burger', 'Doneness', 'Well done', 'Extra cheese']) {
      assert.ok(texts.includes(expected), `"${expected}" is offered for translation`);
    }
    assert.ok(
      Object.keys(bundle.content).some((key) => key.startsWith(`product:${menu.burgerId}:`)),
      'content keys are addressed by entity id, so a re-export lines up',
    );
  });

  test('a blank template offers the same keys with nothing filled in', () => {
    const template = installation.services.packAuthoring.exportBundle({
      targetLocale: 'fr', sourceLocale: 'en', mode: 'template',
    });
    assert.ok(Object.keys(template.content).length > 0);
    assert.ok(Object.values(template.ui).every((value) => value === ''));
    assert.ok(Object.values(template.content).every((value) => value === ''));
  });

  test('pasting a translation adds a language for diners and staff alike', () => {
    const { packAuthoring, translations, settings } = installation.services;
    const bundle = packAuthoring.exportBundle({
      targetLocale: 'fr', sourceLocale: 'en', mode: 'template',
    });

    const burgerNameKey = Object.keys(bundle.content)
      .find((key) => key === `product:${menu.burgerId}:name`)!;

    const outcome = packAuthoring.importBundle({
      raw: {
        ...bundle,
        name: 'Français',
        englishName: 'French',
        direction: 'ltr',
        ui: { 'common.save': 'Enregistrer', 'nav.menu': 'Carte' },
        content: { [burgerNameKey]: 'Hamburger' },
      },
      enable: true,
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.equal(outcome.locale, 'fr');
    assert.equal(outcome.ui, 2);
    assert.equal(outcome.content.applied, 1);

    // The interface half is live…
    assert.equal(translations.translate('fr', 'common.save'), 'Enregistrer');
    // …and untranslated keys fall back rather than showing a raw key.
    assert.equal(
      translations.resolved('fr').strings['common.cancel'],
      translations.resolved(REFERENCE_LOCALE).strings['common.cancel'],
    );
    // …and so is the menu half.
    assert.equal(installation.services.menu.getProduct(menu.burgerId)!.name['fr'], 'Hamburger');
    assert.ok(settings.profile()!.enabledLocales.includes('fr'));
  });

  test('a partial paste never wipes what was already translated', () => {
    const { packAuthoring, menu: menuRepo } = installation.services;

    packAuthoring.importBundle({
      raw: {
        $schema: TRANSLATION_BUNDLE_SCHEMA,
        locale: 'fr', name: 'Français', englishName: 'French', direction: 'ltr',
        fallback: 'en', sourceLocale: 'en',
        ui: { 'nav.tables': 'Tables' },
        content: {},
      },
      enable: false,
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.equal(menuRepo.getProduct(menu.burgerId)!.name['fr'], 'Hamburger');
    assert.equal(installation.services.translations.translate('fr', 'common.save'), 'Enregistrer');
  });

  test('a bundle that is not one is refused with a reason, not a stack trace', () => {
    const { packAuthoring } = installation.services;

    assert.throws(
      () => packAuthoring.importBundle({
        raw: { hello: 'world' },
        enable: false, actor: installation.systemActor, clientIp: null,
      }),
      /translation bundle/,
    );

    assert.throws(
      () => packAuthoring.importBundle({
        raw: {
          $schema: TRANSLATION_BUNDLE_SCHEMA, locale: 'not a locale code!',
          name: 'x', englishName: 'x', direction: 'ltr', fallback: null,
          sourceLocale: 'en', ui: {}, content: {},
        },
        enable: false, actor: installation.systemActor, clientIp: null,
      }),
      /language code/,
    );
  });

  test('coverage counts the menu, not only the interface', () => {
    const french = installation.services.packAuthoring.listLanguages()
      .find((language) => language.locale === 'fr')!;

    assert.ok(french.authored);
    assert.equal(french.shipped, false);
    assert.ok(french.coverage.contentTotal > 0);
    assert.equal(french.coverage.contentTranslated, 1);
    assert.ok(french.coverage.percent < 100);
  });

  test('removing a language takes its menu translations with it', () => {
    const { packAuthoring, translations, menu: menuRepo } = installation.services;

    const outcome = packAuthoring.deleteLanguage({
      locale: 'fr', actor: installation.systemActor, clientIp: null,
    });

    assert.ok(outcome.contentCleared >= 1);
    assert.equal(translations.has('fr'), false);
    assert.equal(menuRepo.getProduct(menu.burgerId)!.name['fr'], undefined);
    assert.equal(installation.services.settings.profile()!.enabledLocales.includes('fr'), false);
  });

  test('a shipped language cannot be deleted, only overridden', () => {
    const { packAuthoring, translations } = installation.services;

    assert.throws(
      () => packAuthoring.deleteLanguage({
        locale: 'en', actor: installation.systemActor, clientIp: null,
      }),
      /added/,
    );

    // Overriding one key leaves the other 400-odd alone.
    packAuthoring.importBundle({
      raw: {
        $schema: TRANSLATION_BUNDLE_SCHEMA,
        locale: 'tr', name: 'Türkçe', englishName: 'Turkish', direction: 'ltr',
        fallback: 'en', sourceLocale: 'en',
        ui: { 'nav.menu': 'Yemekler' },
        content: {},
      },
      enable: false, actor: installation.systemActor, clientIp: null,
    });

    assert.equal(translations.translate('tr', 'nav.menu'), 'Yemekler');
    assert.equal(translations.translate('tr', 'nav.tables'), 'Masalar');
    assert.ok(translations.isShipped('tr'), 'it is still the shipped pack underneath');
  });
});

describe('authoring a theme', () => {
  let installation: Installation;

  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());

  test('a theme copied, edited and pasted back becomes selectable', () => {
    const { packAuthoring, themes } = installation.services;

    const light = packAuthoring.exportTheme('light');
    const colours = light.tokens['color'] as Record<string, unknown>;

    packAuthoring.importTheme({
      raw: {
        ...light,
        id: 'sunset',
        name: 'Sunset',
        tokens: { ...light.tokens, color: { ...colours, accent: '#ff6600' } },
      },
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.ok(themes.available.includes('sunset'));
    assert.equal(themes.isShipped('sunset'), false);
    assert.match(themes.css('sunset'), /#ff6600/);
  });

  test('a theme missing a token is refused rather than rendered unreadably', () => {
    assert.throws(
      () => installation.services.packAuthoring.importTheme({
        raw: { id: 'broken', name: 'Broken', colorScheme: 'light', tokens: { color: {} } },
        actor: installation.systemActor,
        clientIp: null,
      }),
      /token/,
    );
    assert.equal(installation.services.themes.available.includes('broken'), false);
  });

  test('the theme in use cannot be deleted out from under the terminals', () => {
    const { packAuthoring, settings } = installation.services;
    settings.updateRestaurant({ themeId: 'sunset' });

    assert.throws(
      () => packAuthoring.deleteTheme({
        id: 'sunset', actor: installation.systemActor, clientIp: null,
      }),
      /different theme/,
    );

    settings.updateRestaurant({ themeId: 'light' });
    packAuthoring.deleteTheme({ id: 'sunset', actor: installation.systemActor, clientIp: null });
    assert.equal(installation.services.themes.available.includes('sunset'), false);
  });
});

describe('the app lock', () => {
  let installation: Installation;

  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());
  beforeEach(() => {
    // Every test starts from "the owner chose not to lock it", which is also
    // the state a fresh installation is in.
    installation.services.settings.set('security.appLockEnabled', false);
    installation.services.settings.set('security.appLockHash', null);
  });

  test('it is off until the owner turns it on', () => {
    const lock = installation.services.appLock;
    assert.equal(lock.enabled, false);
    assert.equal(lock.status(undefined).locked, false);
    assert.equal(lock.isUnlocked(undefined), true, 'nothing to unlock');
  });

  test('turning it on locks immediately and the right password opens it', () => {
    const lock = installation.services.appLock;

    lock.configure({
      enabled: true,
      passphrase: 'back-office',
      hint: 'the usual',
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.equal(lock.enabled, true);
    assert.equal(lock.isUnlocked(undefined), false);

    assert.throws(() => lock.unlock('wrong', '127.0.0.1'), /passphrase/);

    const token = lock.unlock('back-office', '127.0.0.1');
    assert.equal(lock.isUnlocked(`qs_unlocked=${token}`), true);
    assert.equal(lock.status(`qs_unlocked=${token}`).hint, 'the usual');
  });

  test('a failed and a successful unlock are both in the activity log', () => {
    const lock = installation.services.appLock;
    lock.configure({
      enabled: true, passphrase: 'back-office',
      actor: installation.systemActor, clientIp: null,
    });

    assert.throws(() => lock.unlock('nope', '10.0.0.9'));
    lock.unlock('back-office', '10.0.0.9');

    const actions = installation.services.audit
      .query({ entityType: 'app_lock', limit: 10 })
      .map((entry) => entry.action);

    assert.ok(actions.includes('applock.failed'));
    assert.ok(actions.includes('applock.unlocked'));
    assert.ok(actions.includes('applock.enabled'));
  });

  test('switching it off needs the current password', () => {
    const lock = installation.services.appLock;
    lock.configure({
      enabled: true, passphrase: 'back-office',
      actor: installation.systemActor, clientIp: null,
    });

    assert.throws(
      () => lock.configure({
        enabled: false, actor: installation.systemActor, clientIp: null,
      }),
      /current passphrase/,
    );

    lock.configure({
      enabled: false, currentPassphrase: 'back-office',
      actor: installation.systemActor, clientIp: null,
    });
    assert.equal(lock.enabled, false);
  });

  test('locking again invalidates every open session', () => {
    const lock = installation.services.appLock;
    lock.configure({
      enabled: true, passphrase: 'back-office',
      actor: installation.systemActor, clientIp: null,
    });
    const token = lock.unlock('back-office', '127.0.0.1');
    assert.equal(lock.isUnlocked(`qs_unlocked=${token}`), true);

    lock.lockAll(installation.systemActor, null);
    assert.equal(lock.isUnlocked(`qs_unlocked=${token}`), false);
  });

  test('a password shorter than four characters is refused', () => {
    assert.throws(
      () => installation.services.appLock.configure({
        enabled: true, passphrase: 'ab',
        actor: installation.systemActor, clientIp: null,
      }),
      /at least 4/,
    );
  });
});

describe('authoring the packs the product ships with', () => {
  let installation: Installation;

  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());

  test('a template offers every key the reference defines', () => {
    const template = installation.services.shippedPacks.localeTemplate({
      locale: 'de', from: 'en', name: 'Deutsch', englishName: 'German',
    });

    assert.equal(template.locale, 'de');
    assert.equal(template.direction, 'ltr');
    assert.deepEqual(
      Object.keys(template.strings).sort(),
      installation.services.translations.referenceKeys(),
    );
    // "from" fills the values in, so the translator works over real sentences.
    assert.ok(Object.values(template.strings).every((value) => value !== ''));
  });

  test('a blank template has the keys and no text', () => {
    const template = installation.services.shippedPacks.localeTemplate({ locale: 'de' });
    assert.ok(Object.keys(template.strings).length > 100);
    assert.ok(Object.values(template.strings).every((value) => value === ''));
  });

  test('a gap in a shipped pack is an error, not a warning', () => {
    const { shippedPacks, translations } = installation.services;
    const template = shippedPacks.localeTemplate({
      locale: 'de', from: 'en', name: 'Deutsch', englishName: 'German',
    });

    const [firstKey] = Object.keys(template.strings);
    const holed = { ...template, strings: { ...template.strings, [firstKey!]: '' } };

    const { issues } = shippedPacks.checkLocale(holed);
    assert.equal(issues.filter((issue) => issue.severity === 'error').length, 1);

    assert.throws(
      () => shippedPacks.installLocale({
        raw: holed, actor: installation.systemActor, clientIp: null,
      }),
      /not ready to ship/,
    );
    assert.equal(translations.has('de'), false, 'nothing was written');
  });

  test('a complete pack is written to the locales folder and goes live', () => {
    const { shippedPacks, translations } = installation.services;
    const template = shippedPacks.localeTemplate({
      locale: 'de', from: 'en', name: 'Deutsch', englishName: 'German',
    });

    const result = shippedPacks.installLocale({
      raw: { ...template, strings: { ...template.strings, 'common.save': 'Speichern' } },
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.equal(result.locale, 'de');
    assert.ok(existsSync(result.file));
    assert.equal(translations.isShipped('de'), true);
    assert.equal(translations.translate('de', 'common.save'), 'Speichern');

    // Written as a shipped pack, so a reboot loads the same thing from disk.
    const onDisk = JSON.parse(readFileSync(result.file, 'utf8')) as { locale: string };
    assert.equal(onDisk.locale, 'de');
  });

  test('the reference language is not removable', () => {
    assert.throws(
      () => installation.services.shippedPacks.removeLocale({
        locale: 'en', actor: installation.systemActor, clientIp: null,
      }),
      /reference language/,
    );
  });

  test('removing a shipped language deletes its file', () => {
    const { shippedPacks, translations } = installation.services;
    shippedPacks.removeLocale({
      locale: 'de', actor: installation.systemActor, clientIp: null,
    });
    assert.equal(translations.has('de'), false);
  });

  test('a shipped theme is validated as strictly as a shipped language', () => {
    const { shippedPacks, themes } = installation.services;

    assert.throws(
      () => shippedPacks.installTheme({
        raw: { id: 'sunset', name: 'Sunset', colorScheme: 'light', tokens: {} },
        actor: installation.systemActor, clientIp: null,
      }),
      /token/,
    );

    const template = shippedPacks.themeTemplate({ id: 'sunset', from: 'light' });
    const result = shippedPacks.installTheme({
      raw: { ...template, name: 'Sunset' },
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.ok(existsSync(result.file));
    assert.equal(themes.isShipped('sunset'), true);

    shippedPacks.removeTheme({ id: 'sunset', actor: installation.systemActor, clientIp: null });
    assert.equal(themes.has('sunset'), false);
  });

  test('every developer action is in the activity log', () => {
    const actions = installation.services.audit
      .query({ limit: 50 })
      .map((entry) => entry.action);

    for (const expected of [
      'developer.locale_installed', 'developer.locale_removed',
      'developer.theme_installed', 'developer.theme_removed',
    ]) {
      assert.ok(actions.includes(expected), `${expected} was not logged`);
    }
  });
});
