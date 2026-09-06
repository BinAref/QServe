/**
 * Restaurant server configuration.
 *
 * Two listeners, two very different trust levels:
 *
 *   admin  bound to loopback only. The owner's management console. Never
 *          reachable from the restaurant Wi-Fi, so a diner cannot even attempt
 *          to reach a settings route.
 *   lan    bound to the local network. Diners, waiters, cashiers, kitchen.
 *          Started only once a licence is active (spec §52).
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  readonly dataDir: string;
  readonly adminHost: string;
  readonly adminPort: number;
  readonly lanHost: string;
  readonly lanPort: number;
  /** Vendor endpoint. Contacted only for activation, transfer and status. */
  readonly licenseServerUrl: string;
  /**
   * Host baked into printed QR codes. A stable mDNS name is strongly preferred
   * over an IP: the spec requires that changing the computer does not mean
   * reprinting every table card (spec §8).
   */
  readonly publicHost: string | null;
  readonly webRoot: string;
  readonly localesDir: string;
  readonly themesDir: string;
  readonly trustedKeysFile: string;
  /** Seconds a staff session stays valid without activity. */
  readonly userSessionTtlSeconds: number;
  /** Terminal sessions are long-lived: a kitchen screen is never signed out. */
  readonly terminalSessionTtlSeconds: number;
}

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    dataDir: resolve(env.QSERVE_DATA_DIR ?? './data/restaurant'),
    // Hard-coded to loopback unless explicitly overridden, and the override is
    // logged loudly at boot: exposing the console to the LAN is a real risk.
    adminHost: env.QSERVE_ADMIN_HOST ?? '127.0.0.1',
    adminPort: Number(env.QSERVE_ADMIN_PORT ?? 7010),
    lanHost: env.QSERVE_LAN_HOST ?? '0.0.0.0',
    lanPort: Number(env.QSERVE_LAN_PORT ?? 7020),
    licenseServerUrl: (env.QSERVE_LICENSE_SERVER_URL ?? 'http://localhost:8090').replace(/\/+$/, ''),
    publicHost: env.QSERVE_PUBLIC_HOST?.trim() || null,
    webRoot: resolve(env.QSERVE_WEB_ROOT ?? resolve(appRoot, '../web')),
    localesDir: resolve(env.QSERVE_LOCALES_DIR ?? resolve(appRoot, '../../locales')),
    themesDir: resolve(env.QSERVE_THEMES_DIR ?? resolve(appRoot, '../../themes')),
    trustedKeysFile: resolve(
      env.QSERVE_TRUSTED_KEYS_FILE ?? resolve(appRoot, 'config/trusted-keys.json'),
    ),
    userSessionTtlSeconds: Number(env.QSERVE_USER_SESSION_TTL ?? 12 * 60 * 60),
    terminalSessionTtlSeconds: Number(env.QSERVE_TERMINAL_SESSION_TTL ?? 365 * 24 * 60 * 60),
  };
}
