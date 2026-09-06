/**
 * Device fingerprinting (spec §3).
 *
 * The spec is explicit that a MAC address alone is not good enough, and it is
 * right: MACs are trivially spoofed and USB network adapters come and go. The
 * fingerprint here mixes several independent signals:
 *
 *   - a persisted install id, generated once per installation and stored
 *     *outside* the restaurant database (so it is never carried by a backup);
 *   - the OS machine id, where the platform exposes one;
 *   - immutable-ish hardware traits (CPU model, core count, memory class);
 *   - permanent network interface addresses, sorted and de-duplicated.
 *
 * Every component is hashed individually as well, so vendor support can see
 * *which* trait changed when a restaurant calls about a failed activation —
 * without the vendor ever learning the raw values.
 */

import { createHash } from 'node:crypto';
import { arch, cpus, hostname, networkInterfaces, platform, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import type { DeviceFingerprint } from '@qserve/shared';

export interface FingerprintComponents {
  readonly installId: string;
  readonly machineId: string;
  readonly hostname: string;
  readonly platform: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCount: number;
  /** Rounded to whole gigabytes so a RAM upgrade of the same class is tolerated. */
  readonly memoryGb: number;
  readonly macAddresses: readonly string[];
}

export interface FingerprintResult {
  readonly fingerprint: DeviceFingerprint;
  readonly components: FingerprintComponents;
  /** Per-component SHA-256 (first 12 hex chars) for support diagnostics. */
  readonly componentDigests: Readonly<Record<string, string>>;
  /** Human label shown in the vendor console, e.g. "kitchen-pc (linux/x64)". */
  readonly label: string;
}

const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

function readMachineId(): string {
  for (const file of MACHINE_ID_FILES) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch {
      // Absent on macOS/Windows and in containers — that is expected.
    }
  }
  // Windows exposes a stable GUID through the environment of most installers;
  // when it is missing the persisted install id carries the uniqueness instead.
  return process.env.QSERVE_MACHINE_ID?.trim() ?? '';
}

function collectMacAddresses(): string[] {
  const found = new Set<string>();
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (!addresses) continue;
    // Skip loopback and the ephemeral virtual interfaces created by container
    // runtimes and VPN clients, which would otherwise churn the fingerprint.
    if (/^(lo|docker|br-|veth|virbr|vmnet|utun|tun|tap|zt|wg)/i.test(name)) continue;
    for (const address of addresses) {
      if (address.internal) continue;
      const mac = address.mac?.toLowerCase();
      if (!mac || mac === '00:00:00:00:00:00') continue;
      found.add(mac);
    }
  }
  return [...found].sort();
}

export function collectFingerprintComponents(installId: string): FingerprintComponents {
  const cpuList = cpus();
  return {
    installId,
    machineId: readMachineId(),
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModel: cpuList[0]?.model?.trim() ?? 'unknown',
    cpuCount: cpuList.length,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    macAddresses: collectMacAddresses(),
  };
}

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

export function fingerprintFromComponents(
  components: FingerprintComponents,
): FingerprintResult {
  // Order and separators are fixed: the fingerprint must be reproducible across
  // app versions or every upgrade would look like a hardware change.
  const canonical = [
    `install=${components.installId}`,
    `machine=${components.machineId}`,
    `host=${components.hostname}`,
    `platform=${components.platform}`,
    `arch=${components.arch}`,
    `cpu=${components.cpuModel}`,
    `cores=${components.cpuCount}`,
    `memgb=${components.memoryGb}`,
    `mac=${components.macAddresses.join(',')}`,
  ].join('|');

  const componentDigests: Record<string, string> = {};
  for (const [key, value] of Object.entries(components)) {
    componentDigests[key] = digest(Array.isArray(value) ? value.join(',') : String(value)).slice(0, 12);
  }

  return {
    fingerprint: digest(canonical) as DeviceFingerprint,
    components,
    componentDigests,
    label: `${components.hostname} (${components.platform}/${components.arch})`,
  };
}

export const computeDeviceFingerprint = (installId: string): FingerprintResult =>
  fingerprintFromComponents(collectFingerprintComponents(installId));
