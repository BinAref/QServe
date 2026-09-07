/**
 * What this restaurant calls its people.
 *
 * A role has a fixed key (`WAITER`) that the server enforces permissions
 * against, and a name that the owner writes. One restaurant's waiter is
 * another's host, server, or صالة — and the word they chose should appear on
 * the floor tablet's heading and on the diner's call button, not only in the
 * console where it was typed.
 *
 * The names arrive with the session at boot, so every screen can ask for a
 * label without another request. A role nobody has renamed falls back to the
 * shipped translation, which means a fresh install already reads correctly in
 * every language the restaurant offers.
 */

import { t, pick } from './i18n.js';

/** Set once, from `/api/auth/me`. */
let names = {};

export function setRoleNames(map) {
  names = map ?? {};
}

/**
 * The word for a role. Accepts a key (`'WAITER'`) or a role object from
 * `/api/roles`, so the console can label a role it is editing before the
 * session has caught up.
 */
export function roleLabel(role) {
  const key = typeof role === 'string' ? role : role?.key ?? '';
  const own = pick(typeof role === 'object' && role?.name ? role.name : names[key]);
  if (own) return own;

  const shipped = t(`users.role.${key.toLowerCase()}`);
  // A role the restaurant invented has no shipped label, and `t` returns the
  // key it was given. Showing `users.role.barista` would be worse than nothing.
  return shipped.startsWith('users.role.') ? key : shipped;
}

/** True when the owner has written their own word for this role. */
export const isRenamed = (key) => Boolean(pick(names[key]));

/**
 * Stations carry the same words as the people who staff them, so a restaurant
 * that renamed its waiters sees that name on the terminal list too. Types with
 * no matching role — a table's QR, a printer — keep their shipped label.
 */
const STATION_ROLE = {
  WAITER: 'WAITER',
  CASHIER: 'CASHIER',
  KITCHEN: 'KITCHEN',
  KDS: 'KITCHEN',
  BAR: 'KITCHEN',
  MANAGER: 'MANAGER',
};

export function stationLabel(type, fallback) {
  const key = STATION_ROLE[type];
  const own = key ? pick(names[key]) : '';
  return own || fallback;
}
