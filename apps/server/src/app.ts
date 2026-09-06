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

export class QServeApp {
  private adminServer: Server | null = null;
  private lanServer: Server | null = null;
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
    router.mount('/api', api);
    router.mount('/', createAssetFileRoutes(this.services));

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

  /* ------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    const config = this.services.config;

    if (config.adminHost !== '127.0.0.1' && config.adminHost !== 'localhost') {
      console.warn(
        `[qserve] WARNING: the management console is bound to ${config.adminHost}, not loopback.\n` +
        '         Anyone on this network can reach settings, users and backups.',
      );
    }

    this.adminServer = createHttpServer<AppState>({
      router: this.createAdminRouter(),
      listener: 'admin',
      // Backup restores arrive as a single body, so this ceiling is generous.
      maxBodyBytes: 64 * 1024 * 1024,
      createState: () => ({}),
      onError: (error) => this.logUnexpected(error),
    });

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

    this.services.realtime.start();

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
