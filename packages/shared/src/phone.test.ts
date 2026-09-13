/**
 * A number somebody can dial, in a language that reads the other way.
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { formatPhone, phoneDigits } from './phone.js';

describe('writing a number', () => {

  test('the exit code becomes the plus that works anywhere', () => {
    // `00` is the code for "leaving this country" and it differs by country;
    // `+` is what every phone understands. Same number, one of them dialable.
    assert.equal(formatPhone('00905369130260'), '+905369130260');
    assert.equal(formatPhone('0090 536 913 02 60'), '+90 536 913 02 60');
  });

  test('a number already written properly is left alone', () => {
    assert.equal(formatPhone('+905369130260'), '+905369130260');
  });

  test('a national number keeps its leading zero', () => {
    // The 0 in `0536…` is a trunk prefix, not an exit code. Rewriting it would
    // turn a Turkish local number into a different number entirely.
    assert.equal(formatPhone('05369130260'), '05369130260');
  });

  test('spacing is the restaurant, not ours', () => {
    // How somebody writes their own number is how their customers read it.
    assert.equal(formatPhone(' +90 536 913 02 60 '), '+90 536 913 02 60');
  });

  test('what is not a number survives being formatted', () => {
    assert.equal(formatPhone('call the shop'), 'call the shop');
    assert.equal(formatPhone(''), '');
    assert.equal(formatPhone(null), '');
    assert.equal(formatPhone(undefined), '');
  });

  test('a link gets digits and nothing else', () => {
    assert.equal(phoneDigits('+90 536 913 02 60'), '905369130260');
    assert.equal(phoneDigits(null), '');
  });
});
