/**
 * Telephone numbers on screen.
 *
 * A number is left-to-right in every language on earth. Arabic and Hebrew
 * reverse the order of the *run*, not the digits — and a `+` at the start of
 * that run is a neutral character, so in an Arabic sentence the browser will
 * place it at the visual end. `+905369130260` becomes something that reads as
 * `905369130260+`, and somebody copies it and dials nothing.
 *
 * `<bdi dir="ltr">` is the fix: it isolates the number from the direction of
 * the sentence around it, so the `+` stays at the front where it was typed,
 * in Arabic and in English alike.
 *
 * A copy of `packages/shared/src/phone.ts`, because the front end is plain ES
 * modules with no build step and cannot import from the workspace.
 */

import { h } from './dom.js';

/** `00905369130260` → `+905369130260`; anything else is left as it was. */
export function formatPhone(input) {
  if (!input) return '';
  const trimmed = String(input).trim();
  if (trimmed.length === 0) return '';
  return trimmed.replace(/^00(?=\d)/, '+');
}

/** Just the digits, for a `tel:` or `wa.me` link. */
export const phoneDigits = (input) => String(input ?? '').replace(/[^\d]/g, '');

/** The number as a node, isolated from the direction of the text around it. */
export function phoneNode(input) {
  return h('bdi', { class: 'qs-tel', dir: 'ltr' }, formatPhone(input));
}
