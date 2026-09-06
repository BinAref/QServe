/**
 * Test harness: a complete restaurant installation in a temporary directory.
 *
 * It builds the real container — real SQLite, real migrations, real licence
 * gate — so integration tests exercise the same code path a restaurant does.
 * Activation is performed by signing a certificate with a throwaway key rather
 * than by talking to a licence server, which keeps the tests offline and fast
 * while still going through the identical verification the product uses.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTIVATION_CERTIFICATE_VERSION, LICENSED_CAPABILITIES,
  type ActivationCertificatePayload, type Actor, type RestaurantId,
} from '@qserve/shared';
import { generateSigningKeyPair, issueCertificate } from '@qserve/crypto';

import { buildServices, type Services } from '../container.js';
import { loadServerConfig } from '../config.js';

const repoRoot = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

export interface Installation {
  readonly services: Services;
  readonly dataDir: string;
  /** Bind a licence to this device, exactly as a real activation would. */
  activate(restaurantId?: string): void;
  readonly systemActor: Actor;
  dispose(): void;
}

export function createInstallation(): Installation {
  const dataDir = mkdtempSync(join(tmpdir(), 'qserve-test-'));
  const signing = generateSigningKeyPair();

  // The trust store the installation ships with, written before boot so the
  // gate loads it the way a packaged build would.
  const trustedKeysFile = join(dataDir, 'trusted-keys.json');
  writeFileSync(trustedKeysFile, JSON.stringify({ keys: { [signing.keyId]: signing.publicKey } }));

  const services = buildServices({
    config: loadServerConfig({
      QSERVE_DATA_DIR: dataDir,
      QSERVE_TRUSTED_KEYS_FILE: trustedKeysFile,
      QSERVE_LOCALES_DIR: join(repoRoot, 'locales'),
      QSERVE_THEMES_DIR: join(repoRoot, 'themes'),
      QSERVE_WEB_ROOT: join(repoRoot, 'apps/web'),
    }),
    onWarning: () => {},
  });

  const systemActor: Actor = {
    kind: 'SYSTEM', userId: null, userName: null, terminalId: null, terminalName: null,
  };

  return {
    services,
    dataDir,
    systemActor,

    activate(restaurantId = services.settings.profile()?.restaurantId ?? 'REST-000001') {
      const profile = services.settings.profile();
      if (profile && profile.restaurantId !== restaurantId) {
        services.settings.adoptRestaurantId(restaurantId);
      }

      const payload: ActivationCertificatePayload = {
        v: ACTIVATION_CERTIFICATE_VERSION,
        licenseId: 'LIC-2026-000001' as never,
        licenseType: 'PERPETUAL',
        restaurantId: restaurantId as RestaurantId,
        restaurantName: 'Test Restaurant',
        deviceFingerprint: services.fingerprint.fingerprint,
        activationId: 'ACT-TEST',
        issuedAt: new Date().toISOString(),
        transferCount: 0,
        appVersion: '1.0.0',
        notAfter: null,
        features: [...LICENSED_CAPABILITIES],
      };

      services.gate.installCertificate(
        issueCertificate(payload, signing.privateKey, signing.publicKey),
        restaurantId as RestaurantId,
      );
      // QR generation needs a base URL, which normally arrives when the LAN
      // listener binds.
      services.setLanBaseUrl('http://qserve-test.local:7020');
    },

    dispose() {
      services.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A restaurant with a profile, an owner and a small menu, ready to trade. */
export function seedRestaurant(installation: Installation): {
  categoryId: string;
  burgerId: string;
  friesId: string;
  optionId: string;
  choiceMediumId: string;
  choiceWellDoneId: string;
  addonId: string;
} {
  const { services } = installation;

  services.settings.createRestaurant({
    restaurantId: 'SETUP-TEST',
    name: { en: 'Test Restaurant' },
    defaultLocale: 'en',
    enabledLocales: ['en'],
    themeId: 'light',
  });

  const category = services.menu.createCategory({ name: { en: 'Grill' } });
  const burger = services.menu.createProduct({
    categoryId: category.id, name: { en: 'Burger' }, priceMinor: 2_500, station: 'grill',
  });
  const fries = services.menu.createProduct({
    categoryId: category.id, name: { en: 'Fries' }, priceMinor: 900, station: 'fryer',
  });

  const option = services.menu.createOption(burger.id, {
    name: { en: 'Doneness' }, required: true, maxSelect: 1,
  });
  const medium = services.menu.createChoice(option.id, { name: { en: 'Medium' }, isDefault: true });
  const wellDone = services.menu.createChoice(option.id, {
    name: { en: 'Well done' }, priceDeltaMinor: 200,
  });

  const addon = services.menu.createAddon({ name: { en: 'Extra cheese' }, priceMinor: 300 });
  services.menu.setProductAddons(burger.id, [addon.id]);

  return {
    categoryId: category.id,
    burgerId: burger.id,
    friesId: fries.id,
    optionId: option.id,
    choiceMediumId: medium.id,
    choiceWellDoneId: wellDone.id,
    addonId: addon.id,
  };
}

/** A staff member with a role, for accountability assertions. */
export function seedUser(
  installation: Installation,
  username: string,
  displayName: string,
  roleKeys: readonly string[],
): { id: string; actor: Actor } {
  const user = installation.services.access.createUser({
    username, displayName, secret: '4271', roleKeys,
  });
  return {
    id: user.id,
    actor: {
      kind: 'USER', userId: user.id, userName: displayName,
      terminalId: null, terminalName: null,
    },
  };
}
