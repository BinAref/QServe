/**
 * The vendor's own details, shipped with the build.
 *
 * A restaurant that has just unzipped QServe is offline by design and has no
 * licence yet. The licence screen has to answer one question for it — *who do I
 * ask, and what does it cost* — and the answer cannot depend on reaching a
 * server it has never heard of. So the developer prepares the answer once and it
 * travels in the build, in `config/vendor.json`, next to the public keys.
 *
 * It is a starting point, not a source of truth: the moment this installation
 * reaches the licence server, what it fetches wins, because prices change and a
 * build does not. Nothing here is secret — a phone number and a price list — and
 * nothing here is trusted for anything: it is text shown to a human.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { EMPTY_VENDOR_INFO, validationError, type VendorInfo } from '@qserve/shared';
import type { Actor } from '@qserve/shared';
import type { AuditRepository } from '../../core/repositories/audit.js';

const asText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const asOptionalText = (value: unknown, max: number): string | null => {
  const text = asText(value, max);
  return text === '' ? null : text;
};

/** Parse whatever is in the file into something the console can render. */
export function parseVendorInfo(raw: unknown): VendorInfo {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pricing = (typeof source['pricing'] === 'object' && source['pricing'] !== null
    ? source['pricing'] : {}) as Record<string, unknown>;

  const price = (value: unknown): { price: string; note: string | null } => {
    const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    return { price: asText(entry['price'], 60), note: asOptionalText(entry['note'], 200) };
  };

  const contacts = (Array.isArray(source['contacts']) ? source['contacts'] : [])
    .map((entry) => (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>)
    .filter((entry) => asText(entry['value'], 200) !== '')
    .slice(0, 8)
    .map((entry) => ({
      kind: (asText(entry['kind'], 20).toUpperCase() || 'OTHER') as never,
      label: asText(entry['label'], 60),
      value: asText(entry['value'], 200),
    }));

  return {
    vendorName: asText(source['vendorName'], 80),
    tagline: asOptionalText(source['tagline'], 160),
    contacts,
    pricing: { activation: price(pricing['activation']), transfer: price(pricing['transfer']) },
    instructions: asOptionalText(source['instructions'], 2000),
    updatedAt: asText(source['updatedAt'], 40) || new Date().toISOString(),
  };
}

export class ShippedVendorInfo {
  #info: VendorInfo | null = null;

  constructor(
    private readonly file: string,
    private readonly audit: AuditRepository,
    private readonly warn: (message: string) => void,
  ) {}

  /** Read the file. A missing one is normal; a broken one is worth saying. */
  load(): VendorInfo | null {
    try {
      this.#info = parseVendorInfo(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) this.warn(`vendor.json could not be read: ${String(error)}`);
      this.#info = null;
    }
    return this.#info;
  }

  /** What shipped, or null when this build carries no vendor details. */
  get current(): VendorInfo | null {
    return this.#info;
  }

  get path(): string {
    return this.file;
  }

  /**
   * Write it. Developer mode only — a restaurant cannot edit the vendor's own
   * prices, and the route that reaches this refuses outside developer mode.
   */
  save(raw: unknown, actor: Actor, clientIp: string | null): VendorInfo {
    const info = { ...parseVendorInfo(raw), updatedAt: new Date().toISOString() };
    if (info.vendorName === '') {
      throw validationError('a vendor name is what a restaurant sees first', { field: 'vendorName' });
    }

    writeFileSync(this.file, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    this.#info = info;

    this.audit.record({
      action: 'developer.vendor_info_saved',
      actor,
      entityType: 'vendor',
      entityId: info.vendorName,
      after: { contacts: info.contacts.length, updatedAt: info.updatedAt },
      clientIp,
    });
    return info;
  }

  /** A file to start from, for a developer who has none. */
  template(): VendorInfo {
    return {
      ...EMPTY_VENDOR_INFO,
      vendorName: 'Your company',
      tagline: 'Restaurant systems, installed and supported',
      contacts: [
        { kind: 'WHATSAPP' as never, label: 'Sales', value: '+966 5X XXX XXXX' },
        { kind: 'EMAIL' as never, label: 'Support', value: 'hello@example.com' },
      ],
      pricing: {
        activation: { price: '1,500 SAR', note: 'One payment. The licence does not expire.' },
        transfer: { price: '150 SAR', note: 'Moving your licence to another computer.' },
      },
      instructions: 'Message us with your Restaurant ID and we will send your key.',
      updatedAt: new Date().toISOString(),
    };
  }
}
