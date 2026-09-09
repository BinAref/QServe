/**
 * What a restaurant is allowed to upload as a picture.
 *
 * Four of the five formats the asset store accepts are handed to an image
 * decoder and can do nothing worse than look wrong. SVG is XML, and a browser
 * asked to open one renders it as a *document* — so an SVG can carry script,
 * event handlers, embedded HTML and references to other documents.
 *
 * That matters more than it used to. Uploading is gated on `menu.manage`, and
 * since the menu-entry role exists that is deliberately not only the owner: it
 * is whoever was hired to type the menu in. So the checks here are the ones
 * that stop that person from being able to hand the owner a program.
 *
 * The serving side is the other half and the stronger one — every asset goes
 * out under a `sandbox` content policy, which is what makes a file inert
 * whatever it turned out to contain. These tests are the first line, and they
 * exist because the first line was previously decorative: it read the first
 * kilobyte of the file and looked for `<script`, so a payload at byte 1500 went
 * straight through and an `onload=` attribute was never looked for at all.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createInstallation, seedRestaurant, type Installation } from './harness.js';

let installation: Installation;

/** Upload something as an SVG, and say whether the store took it. */
async function accepts(svg: string): Promise<boolean> {
  try {
    await installation.services.assets.store({
      bytes: Buffer.from(svg, 'utf8'),
      contentType: 'image/svg+xml',
      kind: 'logo',
      actor: installation.systemActor,
      clientIp: null,
    });
    return true;
  } catch {
    return false;
  }
}

const PLAIN = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
  + '<rect width="64" height="64" fill="green"/></svg>';

/** Enough filler to push what follows past the first kilobyte of the file. */
const PAST_THE_FIRST_KILOBYTE = `<!-- ${'x'.repeat(1400)} -->`;

describe('what may be uploaded as an SVG', () => {
  before(() => {
    installation = createInstallation();
    seedRestaurant(installation);
  });
  after(() => installation.dispose());

  test('an ordinary logo is accepted', async () => {
    assert.equal(await accepts(PLAIN), true);
  });

  test('a declaration or a doctype in front of it is still a logo', async () => {
    assert.equal(
      await accepts(`<?xml version="1.0" encoding="UTF-8"?>\n${PLAIN}`),
      true,
      'exports from most drawing programs start with an XML declaration',
    );
    assert.equal(
      await accepts('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" '
        + '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' + PLAIN),
      true,
      'older exports carry a doctype, and turning those away would be wrong',
    );
  });

  test('script is refused however far into the file it sits', async () => {
    assert.equal(
      await accepts(PLAIN.replace('<rect', '<script>alert(1)</script><rect')),
      false,
    );
    assert.equal(
      await accepts(PLAIN.replace(
        '<rect', `${PAST_THE_FIRST_KILOBYTE}<script>alert(1)</script><rect`)),
      false,
      'the check used to read only the first kilobyte, so this one got through',
    );
  });

  test('an event handler is script, and is refused too', async () => {
    assert.equal(
      await accepts(PLAIN.replace('<svg ', '<svg onload="alert(1)" ')),
      false,
      'the check never looked for event handlers at all',
    );
    assert.equal(
      await accepts(PLAIN.replace('<rect', '<rect onmouseover="alert(1)" ')),
      false,
    );
  });

  test('the other ways an SVG reaches outside itself are refused', async () => {
    assert.equal(await accepts(PLAIN.replace('<rect', '<foreignObject><rect')), false,
      'foreignObject is arbitrary HTML, and so is everything HTML can do');
    assert.equal(await accepts(PLAIN.replace('<rect', '<a href="javascript:alert(1)"><rect')), false);
    assert.equal(await accepts(PLAIN.replace('<rect', '<iframe src="/console/"></iframe><rect')), false);
    assert.equal(
      await accepts('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + PLAIN),
      false,
      'an external entity is how an XML parser is talked into reading files',
    );
  });

  test('a logo is not refused for containing the word "on"', async () => {
    assert.equal(
      await accepts(PLAIN.replace('<rect', '<text font-family="Fonts on Demand">Bistro</text><rect')),
      true,
      'the event-handler rule matches attribute position, not the letters o and n',
    );
  });

  test('something that is not an SVG at all is refused', async () => {
    assert.equal(await accepts('<html><body>hello</body></html>'), false);
    assert.equal(await accepts('just some text'), false);
  });
});
