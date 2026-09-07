/**
 * QServe restaurant server entry point.
 *
 * Runs on the restaurant's own PC. Everything the restaurant does all day
 * happens inside this process and its SQLite file: the menu, the tables, the
 * orders, the kitchen, the till, the printers. The internet is needed only to
 * activate or move a licence (spec §37, §38).
 */

import { resolve } from 'node:path';
import { RestaurantMode } from '@qserve/shared';
import { buildServices } from './container.js';
import { QServeApp } from './app.js';
import { loadServerConfig } from './config.js';

export interface StartedApp {
  readonly app: QServeApp;
  readonly stop: () => Promise<void>;
}

export async function start(config = loadServerConfig()): Promise<StartedApp> {
  const services = buildServices({ config });
  const app = new QServeApp(services);
  await app.start();

  const profile = services.settings.profile();
  const mode = services.gate.mode;

  console.log('');
  console.log(`  QServe ${services.appVersion} — Local Restaurant Operating System`);
  console.log(`  Mode:        ${mode}`);
  console.log(`  Restaurant:  ${profile?.restaurantId ?? 'not created yet'}`);
  console.log(`  Device:      ${services.fingerprint.label}`);
  if (mode === RestaurantMode.SETUP) {
    // `explain()` returns a translation key, because every screen renders it in
    // its own language. The person reading this terminal deserves the same.
    const locale = profile?.defaultLocale ?? 'en';
    console.log(`  Licence:     ${services.translations.translate(locale, services.gate.explain())}`);
  }
  // Worth stating out loud: it adds routes that write into locales/ and
  // themes/, and it should never be on in a restaurant.
  if (services.config.developerMode) console.log('  Developer:   ON');
  if (services.appLock.enabled) console.log('  App lock:    ON');
  console.log('');

  return {
    app,
    stop: async () => {
      await app.stop();
    },
  };
}

// Only auto-start when run directly, so tests can import and drive the app.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const started = await start().catch((error: unknown) => {
    console.error('[qserve] failed to start:', error);
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.log(`\n[qserve] ${signal} received, shutting down…`);
    started.stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error('[qserve] shutdown failed:', error);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
