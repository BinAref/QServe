/**
 * Service container.
 *
 * One place where every module is constructed and wired, so the dependency
 * graph of the whole installation is readable in a single file. Modules depend
 * on each other through constructor arguments only — there is no service
 * locator and no import-time singleton, which is what keeps each module
 * testable on its own (spec §54).
 */

import { openDatabase, runMigrations, type Db } from '@qserve/db';
import { computeDeviceFingerprint, type FingerprintResult } from '@qserve/crypto';
import { APP_VERSION, type DeviceFingerprint } from '@qserve/shared';

import { loadServerConfig, type ServerConfig } from './config.js';
import { ensureDirectories, readOrCreateInstallId, resolvePaths, type Paths } from './core/paths.js';
import { migrations } from './core/schema.js';
import { EventBus } from './core/event-bus.js';
import { LicenseGate, loadTrustStore } from './core/license-gate.js';
import { SecurityService } from './core/security.js';
import { RealtimeGateway } from './core/realtime.js';
import { LocalDiscovery, lanAddresses, mdnsNameFor, publicBaseUrl } from './core/network.js';
import { AppLockService } from './core/app-lock.js';

import { AccessRepository } from './core/repositories/access.js';
import { AuditRepository } from './core/repositories/audit.js';
import { LicenseRepository } from './core/repositories/license.js';
import { PackRepository } from './core/repositories/packs.js';
import { SettingsRepository } from './core/repositories/settings.js';
import { TerminalRepository } from './core/repositories/terminals.js';

import { MenuRepository } from './modules/menu/repository.js';
import { TableRepository } from './modules/tables/repository.js';
import { OrderRepository } from './modules/orders/repository.js';
import { OrderService } from './modules/orders/service.js';
import { PaymentRepository, PaymentService } from './modules/payments/service.js';
import { TerminalService } from './modules/terminals/service.js';
import { PrintingRepository, PrintingService } from './modules/printing/service.js';
import { BackupService } from './modules/backup/service.js';
import { ReportService } from './modules/reports/service.js';
import { LicensingService } from './modules/licensing/service.js';
import { TranslationService } from './modules/translations/service.js';
import { ContentTranslationRepository } from './modules/translations/content.js';
import { PackAuthoringService } from './modules/translations/authoring.js';
import { ShippedPackService } from './modules/translations/shipping.js';
import { ThemeService } from './modules/themes/service.js';
import { AssetService } from './modules/assets/service.js';

export interface Services {
  readonly config: ServerConfig;
  readonly paths: Paths;
  readonly db: Db;
  readonly bus: EventBus;
  readonly gate: LicenseGate;
  readonly security: SecurityService;
  readonly realtime: RealtimeGateway;
  readonly discovery: LocalDiscovery;
  readonly fingerprint: FingerprintResult;
  readonly appLock: AppLockService;

  readonly access: AccessRepository;
  readonly audit: AuditRepository;
  readonly licenseRepository: LicenseRepository;
  readonly settings: SettingsRepository;
  readonly terminalRepository: TerminalRepository;
  readonly packs: PackRepository;
  readonly contentTranslations: ContentTranslationRepository;
  readonly menu: MenuRepository;
  readonly tables: TableRepository;
  readonly orderRepository: OrderRepository;

  readonly orders: OrderService;
  readonly payments: PaymentService;
  readonly terminals: TerminalService;
  readonly printing: PrintingService;
  readonly backup: BackupService;
  readonly reports: ReportService;
  readonly licensing: LicensingService;
  readonly translations: TranslationService;
  readonly themes: ThemeService;
  readonly packAuthoring: PackAuthoringService;
  readonly shippedPacks: ShippedPackService;
  readonly assets: AssetService;

  /** The LAN base URL, or null before the LAN listener has bound. */
  lanBaseUrl(): string | null;
  /** Set once the LAN listener binds, so QR URLs can be generated. */
  setLanBaseUrl(url: string | null): void;
  readonly appVersion: string;
  close(): void;
}

export interface BuildOptions {
  readonly config?: ServerConfig;
  readonly onWarning?: (message: string) => void;
}

export function buildServices(options: BuildOptions = {}): Services {
  const config = options.config ?? loadServerConfig();
  const warn = options.onWarning ?? ((message: string) => console.warn(`[qserve] ${message}`));

  const paths = resolvePaths(config.dataDir);
  ensureDirectories(paths);

  const db = openDatabase({ file: paths.databaseFile });
  const applied = runMigrations(db, migrations);
  if (applied.applied.length > 0) {
    console.log(`[qserve] applied migrations: ${applied.applied.join(', ')}`);
  }

  // The fingerprint mixes a persisted install id with hardware traits, so it is
  // stable across restarts and app upgrades but changes on a new machine.
  const fingerprint = computeDeviceFingerprint(readOrCreateInstallId(paths));

  const bus = new EventBus((error) => warn(`event subscriber failed: ${String(error)}`));

  const settings = new SettingsRepository(db);
  const audit = new AuditRepository(db);
  const access = new AccessRepository(db);
  const terminalRepository = new TerminalRepository(db);
  const licenseRepository = new LicenseRepository(db, paths);
  const packs = new PackRepository(db);
  const contentTranslations = new ContentTranslationRepository(db);

  const gate = new LicenseGate(
    licenseRepository,
    paths,
    loadTrustStore(config.trustedKeysFile),
    fingerprint.fingerprint as DeviceFingerprint,
  );

  const defaultLocale = (): string => settings.profile()?.defaultLocale ?? 'en';

  const security = new SecurityService(access, terminalRepository, gate, defaultLocale);
  const appLock = new AppLockService(settings, audit);
  const realtime = new RealtimeGateway(bus, security);
  const discovery = new LocalDiscovery();

  const menu = new MenuRepository(db);
  const tables = new TableRepository(db);
  const orderRepository = new OrderRepository(db);
  const paymentRepository = new PaymentRepository(db);
  const printingRepository = new PrintingRepository(db);

  const orders = new OrderService(orderRepository, menu, tables, settings, audit, bus);
  const payments = new PaymentService(paymentRepository, orderRepository, orders, audit, bus);
  // Closes the loop between the two: orders can ask whether a bill is settled
  // without depending on the payments module at construction time.
  orders.setPaidTotalProvider((orderId) => paymentRepository.capturedTotal(orderId));

  let lanBaseUrl: string | null = null;

  const terminals = new TerminalService(
    terminalRepository, tables, settings, audit, bus, gate,
    () => lanBaseUrl,
  );

  const printing = new PrintingService(printingRepository, settings, bus, gate, paths.spoolDir);
  const backup = new BackupService(db, settings, audit, paths);
  const reports = new ReportService(orderRepository, paymentRepository, audit, settings);
  const assets = new AssetService(db, audit, paths);

  const licensing = new LicensingService(
    {
      licenseServerUrl: config.licenseServerUrl,
      deviceFingerprint: fingerprint.fingerprint as DeviceFingerprint,
      deviceLabel: fingerprint.label,
    },
    licenseRepository, settings, gate, audit, bus,
  );

  const translations = new TranslationService(config.localesDir, warn);
  translations.load();
  // The restaurant's own languages are merged over the shipped ones, so an
  // owner-authored pack survives a vendor update of the same locale file.
  translations.useAuthoredPacks(packs);

  const themes = new ThemeService(config.themesDir, warn);
  themes.load();
  themes.useAuthoredPacks(packs);

  const packAuthoring = new PackAuthoringService(
    packs, contentTranslations, translations, themes, settings, audit,
  );

  // Authoring the packs the *product* ships with. Constructed always, reachable
  // only in developer mode — the route module refuses otherwise.
  const shippedPacks = new ShippedPackService(
    { localesDir: config.localesDir, themesDir: config.themesDir },
    translations, themes, audit,
  );

  // First evaluation of the licence, entirely offline. This is what decides
  // whether the LAN listener will be started at all.
  gate.evaluate(settings.profile()?.restaurantId as never);

  return {
    config, paths, db, bus, gate, security, realtime, discovery, fingerprint, appLock,
    access, audit, licenseRepository, settings, terminalRepository,
    packs, contentTranslations, menu, tables, orderRepository,
    orders, payments, terminals, printing, backup, reports, licensing,
    translations, themes, packAuthoring, shippedPacks, assets,
    appVersion: APP_VERSION,
    lanBaseUrl: () => lanBaseUrl,
    setLanBaseUrl: (url) => { lanBaseUrl = url; },
    close: () => {
      db.close();
    },
  };
}

/** Everything the `/api/system` endpoint reports, in one place. */
export function systemStatus(services: Services, lanRunning: boolean): Record<string, unknown> {
  const snapshot = services.gate.current;
  const profile = services.settings.profile();
  const licenseState = services.licenseRepository.state();

  return {
    appVersion: services.appVersion,
    mode: snapshot.mode,
    // Off in every packaged build; the console hides its developer section
    // entirely rather than showing a padlock, because it is not for sale.
    developerMode: services.config.developerMode,
    restaurantId: profile?.restaurantId ?? null,
    restaurantName: profile?.name ?? null,
    // The console formats prices everywhere, so the currency travels with the
    // status rather than needing a settings-scoped request first.
    currency: profile?.currency ?? null,
    capabilities: snapshot.capabilities,
    setupComplete: profile !== null,
    ownerExists: services.access.countUsers() > 0,
    license: {
      present: snapshot.payload !== null,
      licenseId: snapshot.payload?.licenseId ?? licenseState.license_id,
      status: licenseState.status,
      type: snapshot.payload?.licenseType ?? licenseState.license_type,
      activatedAt: licenseState.activated_at,
      transferCount: snapshot.payload?.transferCount ?? licenseState.transfer_count,
      verdict: snapshot.verdict,
      explanation: services.gate.explain(),
    },
    lan: {
      running: lanRunning,
      baseUrl: services.lanBaseUrl(),
      hostname: services.discovery.current.hostname,
      advertising: services.discovery.current.advertising,
      discoveryError: services.discovery.current.error,
      port: services.config.lanPort,
      addresses: lanAddresses().map((entry) => entry.address),
      suggestedHostname: profile ? mdnsNameFor(profile.restaurantId) : null,
    },
    device: {
      fingerprint: services.fingerprint.fingerprint,
      label: services.fingerprint.label,
      components: services.fingerprint.componentDigests,
    },
    locales: services.translations.summaries(profile?.enabledLocales ?? ['en']),
    themes: services.themes.summaries(profile?.themeId ?? 'light'),
  };
}

export { publicBaseUrl };
