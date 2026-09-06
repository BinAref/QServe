/**
 * License server entry point.
 *
 * A deliberately small, boring service: SQLite, one process, no queue, no cache.
 * It is contacted a handful of times in the lifetime of each restaurant, so its
 * design goals are correctness and auditability, not throughput.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations } from '@qserve/db';
import { computeKeyId } from '@qserve/crypto';
import { generateLicenseKey } from '@qserve/shared';
import { createHttpServer, createStaticHandler, HttpResponse, Router } from '@qserve/http';
import { loadConfig, type LicenseServerConfig } from './config.js';
import { migrations, LICENSE_SERVER_SCHEMA_VERSION } from './schema.js';
import { LicenseStore } from './store.js';
import { LicenseService, type SigningMaterial } from './service.js';
import { AdminAuth, type AdminState } from './auth.js';
import { createPublicApi } from './routes/public-api.js';
import { createAdminApi } from './routes/admin-api.js';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));

function resolveSigningMaterial(config: LicenseServerConfig): SigningMaterial | null {
  if (!config.signingPrivateKey || !config.signingPublicKey) return null;
  return {
    privateKey: config.signingPrivateKey,
    publicKey: config.signingPublicKey,
    keyId: computeKeyId(config.signingPublicKey),
  };
}

export interface StartedServer {
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly store: LicenseStore;
  readonly service: LicenseService;
}

export async function start(config = loadConfig()): Promise<StartedServer> {
  const db = openDatabase({ file: config.databaseFile });
  const migration = runMigrations(db, migrations);
  if (migration.applied.length > 0) {
    console.log(`[license-server] applied migrations: ${migration.applied.join(', ')}`);
  }

  const store = new LicenseStore(db);
  const signing = resolveSigningMaterial(config);
  const service = new LicenseService(store, signing, config.licenseYear, generateLicenseKey);
  const auth = new AdminAuth(store);

  if (signing) {
    service.registerOwnKey();
    console.log(`[license-server] signing key ${signing.keyId} loaded`);
  } else {
    console.warn(
      '[license-server] no signing key configured — licences cannot be activated.\n' +
      '                 Run `npm run keygen` and set QSERVE_LS_SIGNING_KEY_FILE.',
    );
  }

  const bootstrap = auth.ensureBootstrapAdmin(
    config.bootstrapAdminUsername,
    config.bootstrapAdminPassword,
  );
  if (bootstrap.created && bootstrap.generatedPassword) {
    console.log(
      '\n  A developer account was created because none existed.\n' +
      `    username: ${bootstrap.username}\n` +
      `    password: ${bootstrap.generatedPassword}\n` +
      '  This password is shown once. Store it now.\n',
    );
  }

  store.purgeExpiredSessions();
  const sessionSweeper = setInterval(() => store.purgeExpiredSessions(), 60 * 60 * 1000);
  sessionSweeper.unref();

  const router = new Router<AdminState>();

  router.get('/health', () => ({
    ok: true,
    schemaVersion: LICENSE_SERVER_SCHEMA_VERSION,
    signingConfigured: signing !== null,
  }));

  router.mount('/api/v1', createPublicApi(service) as unknown as Router<AdminState>);
  router.mount('/admin/api', createAdminApi(store, service, auth));

  const serveConsole = createStaticHandler({ root: PUBLIC_DIR, spaFallback: true });
  router.get('/admin', (ctx) => serveConsole(ctx as never));
  router.get('/admin/*', (ctx) => serveConsole(ctx as never));
  router.get('/', () => HttpResponse.redirect('/admin'));

  const server = createHttpServer<AdminState>({
    router,
    listener: 'admin',
    createState: () => ({}),
    onError: (error) => {
      // AppErrors are expected control flow (bad key, wrong device); only log
      // the unexpected ones, so the operational log stays meaningful.
      if (error instanceof Error && error.name !== 'AppError') {
        console.error('[license-server]', error);
      }
    },
  });

  await new Promise<void>((resolvePromise) => {
    server.listen(config.port, config.host, resolvePromise);
  });
  console.log(`[license-server] listening on http://${config.host}:${config.port}`);
  console.log(`[license-server] vendor console at http://${config.host}:${config.port}/admin`);

  return {
    port: config.port,
    store,
    service,
    close: async () => {
      clearInterval(sessionSweeper);
      await new Promise<void>((done) => server.close(() => done()));
      db.close();
    },
  };
}

// Only auto-start when executed directly, so tests can import `start`.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  start().catch((error: unknown) => {
    console.error('[license-server] failed to start:', error);
    process.exitCode = 1;
  });
}
