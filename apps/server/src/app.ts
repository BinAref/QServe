/**
 * Application assembly: two listeners, one process.
 *
 *   admin (127.0.0.1)  The owner's management console. Always available, even
 *                      before a licence exists — that is SETUP mode.
 *
 *   lan   (0.0.0.0)    Diners and staff terminals. **Bound only when the
 *                      licence is ACTIVE.** Before activation the socket does
 *                      not exist, so "no local web server before activation"
 *                      (spec §52) is enforced by the operating system rather
 *                      than by an `if` in a handler.
 *
 * The gate publishes mode changes, and this file listens: activating a licence
 * starts the LAN listener immediately, and deactivating stops it. Nobody has to
 * restart the application to move between modes.
 */

import type { Server } from 'node:http';
import { createHttpServer, createStaticHandler, HttpResponse, Router } from '@qserve/http';
import { RestaurantMode } from '@qserve/shared';
import { join } from 'node:path';
import type { Services } from './container.js';
import { systemStatus } from './container.js';
import type { AppState } from './core/security.js';
import { lanAddresses, mdnsNameFor, publicBaseUrl } from './core/network.js';

import { createSystemRoutes } from './http/routes/system.js';
import { createMenuRoutes } from './http/routes/menu.js';
import { createOrderRoutes } from './http/routes/orders.js';
import { createOperationsRoutes } from './http/routes/operations.js';
import { createManagementRoutes } from './http/routes/management.js';
import { createLockRoutes, LOCK_ALLOWED_PATHS } from './http/routes/lock.js';
import { createPackRoutes } from './http/routes/packs.js';
import { createCurrencyRoutes } from './http/routes/currencies.js';
import { createNotificationRoutes } from './http/routes/notifications.js';
import { createDeveloperRoutes } from './http/routes/developer.js';
import {
  createAssetFileRoutes, createContentRoutes, createEnrolmentRoutes,
} from './http/routes/content.js';

/** Front-end applications, each a directory of plain ES modules under web/. */
const TERMINAL_APPS: Readonly<Record<string, string>> = {
  '/menu': 'customer',
  '/kitchen': 'kitchen',
  '/cashier': 'cashier',
  '/waiter': 'waiter',
  '/printer': 'printer',
};

/** How often expired sessions and unlock tokens are swept. */
const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export class QServeApp {
  private adminServer: Server | null = null;
  private lanServer: Server | null = null;
  private maintenance: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly services: Services) {}

  /* ------------------------------------------------------------- routers */

  private isLanRunning = (): boolean => this.lanServer !== null;

  /** Routes shared by both listeners. Guards inside them do the narrowing. */
  private commonApi(): Router<AppState> {
    const router = new Router<AppState>();
    router.mount('/', createSystemRoutes({
      services: this.services,
      isLanRunning: this.isLanRunning,
    }));
    router.mount('/', createContentRoutes(this.services));
    router.mount('/', createCurrencyRoutes(this.services));
    router.mount('/', createNotificationRoutes(this.services));
    router.mount('/', createMenuRoutes(this.services));
    router.mount('/', createOrderRoutes(this.services));
    router.mount('/', createOperationsRoutes(this.services));
    return router;
  }

  private createAdminRouter(): Router<AppState> {
    const router = new Router<AppState>();
    router.use(this.services.security.authenticate());

    const api = this.commonApi();
    api.mount('/', createManagementRoutes(this.services));
    api.mount('/', createPackRoutes(this.services));
    api.mount('/', createDeveloperRoutes(this.services));
    api.mount('/', createLockRoutes(this.services));
    // Everything the console can read goes behind the optional app lock. The
    // static files do not: they hold no restaurant data, and the lock screen is
    // one of them.
    api.use(this.services.appLock.guard(LOCK_ALLOWED_PATHS));
    router.mount('/api', api);

    const assetFiles = createAssetFileRoutes(this.services);
    assetFiles.use(this.services.appLock.guard([]));
    router.mount('/', assetFiles);
    this.mountSharedAssets(router);

    // The console itself: a plain directory of ES modules, no build step.
    const consoleRoot = join(this.services.config.webRoot, 'console');
    const serveConsole = createStaticHandler({ root: consoleRoot, spaFallback: true });
    router.get('/', (ctx) => serveConsole(ctx as never));
    router.get('/*', (ctx) => serveConsole(ctx as never));

    return router;
  }

  private createLanRouter(): Router<AppState> {
    const router = new Router<AppState>();
    router.use(this.services.security.authenticate());

    // No management routes here at all. A diner's phone cannot reach a settings
    // endpoint even if it holds an administrator's session cookie.
    router.mount('/api', this.commonApi());
    router.mount('/', createAssetFileRoutes(this.services));
    router.mount('/', createEnrolmentRoutes(this.services));
    this.mountSharedAssets(router);

    for (const [path, app] of Object.entries(TERMINAL_APPS)) {
      const root = join(this.services.config.webRoot, app);
      const serve = createStaticHandler({ root, spaFallback: true });
      router.get(path, (ctx) => serve(ctx as never));
      router.get(`${path}/*`, (ctx) => serve(ctx as never));
    }

    // Anything else on the LAN gets the diner's menu, which is the only sensible
    // landing page for someone who typed the host by hand.
    router.get('/', () => HttpResponse.redirect('/menu'));

    return router;
  }

  /**
   * The runtime every terminal imports — i18n, theme, realtime, sound, DOM
   * helpers. Served from one place so a fix reaches all five apps at once.
   */
  private mountSharedAssets(router: Router<AppState>): void {
    const shared = join(this.services.config.webRoot, 'shared');
    const serve = createStaticHandler({ root: shared });
    router.get('/shared/*', (ctx) => serve(ctx as never));

    // Browsers ask for this unprompted on every page; answering it keeps a real
    // 404 in the log meaningful.
    const favicon = createStaticHandler({ root: shared, indexFile: 'favicon.svg' });
    router.get('/favicon.ico', (ctx) =>
      favicon({ ...ctx, params: { wildcard: 'favicon.svg' } } as never));
  }

  /* ------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    const config = this.services.config;

    if (config.adminHost !== '127.0.0.1' && config.adminHost !== 'localhost') {
      console.warn(
        `[qserve] WARNING: the management console is bound to ${config.adminHost}, not loopback.\n` +
        '         Anyone on this network can reach settings, users and backups.',
      );
    }

    // Subscribe the gateway to the bus before any socket can attach to it.
    this.services.realtime.start();
    this.startMaintenance();

    this.adminServer = createHttpServer<AppState>({
      router: this.createAdminRouter(),
      listener: 'admin',
      // Backup restores arrive as a single body, so this ceiling is generous.
      maxBodyBytes: 64 * 1024 * 1024,
      createState: () => ({}),
      onError: (error) => this.logUnexpected(error),
    });

    // The console is a realtime client too: it has to notice activation, new
    // orders and table changes without the owner reloading the page.
    this.services.realtime.attach(this.adminServer);

    await listen(this.adminServer, config.adminPort, config.adminHost);
    console.log(
      `[qserve] management console: http://${config.adminHost}:${config.adminPort}`,
    );

    // React to activation and deactivation without a restart.
    this.services.gate.onChange((snapshot) => {
      if (this.stopping) return;
      if (snapshot.mode === RestaurantMode.OPERATIONAL) {
        void this.startLan().catch((error: unknown) => this.logUnexpected(error));
      } else {
        void this.stopLan('licence is no longer active');
      }
    });

    if (this.services.gate.mode === RestaurantMode.OPERATIONAL) {
      await this.startLan();
    } else {
      console.log(
        '[qserve] SETUP mode: build your menu on the console. ' +
        'The local server for tables and staff starts once a licence is activated.',
      );
    }
  }

  /** Bind the LAN listener, advertise the mDNS name, and publish the base URL. */
  private async startLan(): Promise<void> {
    if (this.lanServer) return;
    const config = this.services.config;

    const server = createHttpServer<AppState>({
      router: this.createLanRouter(),
      listener: 'lan',
      createState: () => ({}),
      onError: (error) => this.logUnexpected(error),
    });

    this.services.realtime.attach(server);
    await listen(server, config.lanPort, config.lanHost);
    this.lanServer = server;

    await this.advertise();

    const base = this.services.lanBaseUrl();
    console.log(`[qserve] local restaurant server: ${base ?? `port ${config.lanPort}`}`);
    console.log(
      `[qserve] LAN addresses: ${lanAddresses().map((entry) => entry.address).join(', ') || 'none'}`,
    );
  }

  /**
   * Publish a stable mDNS name derived from the Restaurant ID, so printed QR
   * codes keep resolving after a hardware change (spec §8).
   */
  private async advertise(): Promise<void> {
    const profile = this.services.settings.profile();
    const address = lanAddresses()[0]?.address ?? null;

    if (profile && address) {
      const hostname = mdnsNameFor(profile.restaurantId);
      const status = await this.services.discovery.advertise(hostname, address);
      if (!status.advertising) {
        console.warn(
          `[qserve] mDNS name ${hostname} could not be advertised (${status.error ?? 'unknown'}).\n` +
          '         QR codes will use the IP address instead; set QSERVE_PUBLIC_HOST to override.',
        );
      }
    }

    this.services.setLanBaseUrl(publicBaseUrl({
      configuredHost: this.services.config.publicHost,
      restaurantId: profile?.restaurantId ?? null,
      port: this.services.config.lanPort,
      discovery: this.services.discovery.current,
    }));
  }

  private async stopLan(reason?: string): Promise<void> {
    const server = this.lanServer;
    if (!server) return;
    this.lanServer = null;

    await this.services.discovery.stop();
    this.services.setLanBaseUrl(null);
    await new Promise<void>((done) => server.close(() => done()));
    // Silent during shutdown; only a mode change is worth reporting, because it
    // means tables and staff terminals just went dark mid-day.
    if (reason) console.log(`[qserve] local restaurant server stopped (${reason})`);
  }

  /**
   * Expired staff sessions and unlock tokens are only *checked* on use, so
   * without this they would accumulate in a restaurant that never restarts.
   */
  private startMaintenance(): void {
    this.maintenance = setInterval(() => {
      try {
        this.services.access.purgeExpiredSessions();
        this.services.appLock.prune();
      } catch (error) {
        this.logUnexpected(error);
      }
    }, MAINTENANCE_INTERVAL_MS);
    this.maintenance.unref();
  }

  private logUnexpected(error: unknown): void {
    // AppErrors are ordinary control flow — a wrong PIN, a sold-out dish. Only
    // the unexpected reaches the log, so the log stays worth reading.
    if (error instanceof Error && error.name !== 'AppError') {
      console.error('[qserve]', error);
    }
  }

  status(): Record<string, unknown> {
    return systemStatus(this.services, this.isLanRunning());
  }

  get lanPort(): number | null {
    const address = this.lanServer?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  get adminPort(): number | null {
    const address = this.adminServer?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.maintenance) clearInterval(this.maintenance);
    this.maintenance = null;
    await this.services.realtime.stop();
    await this.stopLan();

    const admin = this.adminServer;
    this.adminServer = null;
    if (admin) await new Promise<void>((done) => admin.close(() => done()));

    this.services.close();
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
