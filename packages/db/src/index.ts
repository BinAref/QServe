/**
 * @qserve/db — SQLite connection, migration runner and column codecs shared by
 * the restaurant server and the license server. Neither app talks to
 * better-sqlite3 directly except through this package.
 */

export * from './open.js';
export * from './migrate.js';
export * from './columns.js';
