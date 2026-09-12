/**
 * @qserve/shared — the vocabulary of the Local Restaurant Operating System.
 *
 * Everything here is pure, dependency-free and runtime-neutral: the same module
 * is imported by the Node server, the license server and the browser terminals.
 * Nothing in this package may touch the filesystem, the network or a database.
 */

export * from './ids.js';
export * from './enums.js';
export * from './permissions.js';
export * from './capabilities.js';
export * from './order-state-machine.js';
export * from './license-key.js';
export * from './license-protocol.js';
export * from './events.js';
export * from './sound.js';
export * from './i18n.js';
export * from './theme.js';
export * from './money.js';
export * from './errors.js';
export * from './models.js';
export * from './validate.js';

/** Bumped on every release; embedded in activation requests and backups. */
export const APP_VERSION = '1.0.16';
