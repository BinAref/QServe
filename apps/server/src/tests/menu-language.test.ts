/**
 * A language for the menu, without translating the application.
 *
 * Translating the whole till is a real job: eight hundred strings, a
 * translator, a file. Putting the menu in Russian for the tourists who come
 * every summer is not that job — and making somebody do the first in order to
 * get the second is why menus end up in one language.
 *
 * A menu language is therefore an ordinary language pack with no interface
 * strings and a fallback to the one the restaurant already runs in. This
 * checks the shape is accepted, that it becomes a language the menu can use,
 * and that the till does not change language underneath anybody.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createInstallation, seedRestaurant, type Installation } from './harness.js';

let installation: Installation;

/*
 * The object the service reads. The HTTP route accepts the same thing as text
 * and parses it first; this is the other side of that door.
 */
const menuLanguage = (locale: string, name: string, direction: 'ltr' | 'rtl', fallback: string) =>
  ({
    $schema: 'qserve.translation.bundle.v1',
    locale,
    name,
    englishName: name,
    direction,
    fallback,
    // The whole point: nothing here. Every interface string comes from the
    // language the restaurant already uses, and the dish names are typed in
    // the menu builder rather than pasted.
    ui: {},
    content: {},
  });


before(() => {
  installation = createInstallation();
  seedRestaurant(installation);
});
after(() => installation.dispose());

describe('adding a language for the menu', () => {

  test('a pack with no interface strings is accepted', () => {
    const { packAuthoring, translations } = installation.services;

    packAuthoring.importBundle({
      raw: menuLanguage('ru', 'Русский', 'ltr', 'en'),
      override: {},
      enable: true,
      actor: installation.systemActor,
      clientIp: null,
    });

    assert.ok(translations.has('ru'), 'the menu can be written in it');
  });

  test('the till keeps speaking the language it spoke', () => {
    const { settings } = installation.services;
    const profile = settings.profile()!;

    // Adding Russian for the menu must not make the console Russian. The
    // restaurant's own default is untouched, and the new language falls back
    // to it for every word that is not a dish.
    assert.notEqual(profile.defaultLocale, 'ru');
    assert.ok(profile.enabledLocales.includes('ru'), 'but the menu may offer it');
  });

  test('a right-to-left menu language is right-to-left', () => {
    const { packAuthoring, translations } = installation.services;

    packAuthoring.importBundle({
      raw: menuLanguage('fa', 'فارسی', 'rtl', 'en'),
      override: {},
      enable: true,
      actor: installation.systemActor,
      clientIp: null,
    });

    const pack = translations.summaries(['fa']).find((entry) => entry.locale === 'fa');
    assert.equal(pack?.direction, 'rtl',
      'direction is a property of the language, and an Arabic menu laid out '
      + 'left to right is unreadable');
  });

});
