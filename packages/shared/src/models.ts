/**
 * Domain models shared by the server and every terminal front-end.
 *
 * These are the *API* shapes. Storage rows are close but not identical: the
 * repositories translate (snake_case columns, JSON blobs, integer booleans).
 */

import type {
  ActorKind, OrderSource, OrderStatus, PaymentMethod, PaymentStatus,
  PrintDocumentType, PrinterTransport, RestaurantMode, TableStatus,
  TerminalStatus, TerminalType, TextDirection,
} from './enums.js';
import type { CurrencyConfig, OrderTotals } from './money.js';
import type { SoundProfile } from './sound.js';
import type { LicenseStatus, LicenseType } from './enums.js';

/** Values a restaurant can translate per language, e.g. product names. */
export type Localised = Readonly<Record<string, string>>;

export interface RestaurantProfile {
  readonly restaurantId: string;
  readonly name: Localised;
  readonly legalName: string | null;
  readonly logoAssetId: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly taxNumber: string | null;
  readonly currency: CurrencyConfig;
  readonly taxRatePercent: number;
  readonly taxInclusive: boolean;
  readonly serviceRatePercent: number;
  readonly defaultLocale: string;
  readonly enabledLocales: readonly string[];
  readonly themeId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SystemStatus {
  readonly appVersion: string;
  readonly mode: RestaurantMode;
  readonly restaurantId: string | null;
  readonly capabilities: readonly string[];
  readonly license: {
    readonly present: boolean;
    readonly licenseId: string | null;
    readonly status: LicenseStatus | null;
    readonly type: LicenseType | null;
    readonly activatedAt: string | null;
    readonly transferCount: number;
    /** Verdict of the last offline certificate check. */
    readonly verdict: string;
  };
  readonly lan: {
    readonly running: boolean;
    readonly baseUrl: string | null;
    readonly hostname: string | null;
    readonly port: number;
    readonly addresses: readonly string[];
  };
  readonly deviceFingerprint: string;
}

/* --------------------------------------------------------------------- menu */

export interface Category {
  readonly id: string;
  readonly name: Localised;
  readonly description: Localised;
  readonly imageAssetId: string | null;
  readonly sortOrder: number;
  readonly visible: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OptionChoice {
  readonly id: string;
  readonly name: Localised;
  readonly priceDeltaMinor: number;
  readonly sortOrder: number;
  readonly available: boolean;
  readonly isDefault: boolean;
}

/** A required or optional choice attached to a product ("size", "doneness"). */
export interface ProductOption {
  readonly id: string;
  readonly name: Localised;
  readonly required: boolean;
  readonly minSelect: number;
  readonly maxSelect: number;
  readonly sortOrder: number;
  readonly choices: readonly OptionChoice[];
}

/** A paid extra ("extra cheese"). Shared across products via `addonGroupIds`. */
export interface Addon {
  readonly id: string;
  readonly name: Localised;
  readonly priceMinor: number;
  readonly sortOrder: number;
  readonly available: boolean;
}

export interface Product {
  readonly id: string;
  readonly categoryId: string;
  readonly name: Localised;
  readonly description: Localised;
  readonly imageAssetId: string | null;
  readonly priceMinor: number;
  readonly sortOrder: number;
  readonly visible: boolean;
  readonly available: boolean;
  /** Free-text kitchen routing tag, e.g. "grill", "bar". Drives print routing. */
  readonly station: string | null;
  readonly preparationMinutes: number | null;
  readonly options: readonly ProductOption[];
  readonly addons: readonly Addon[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* ------------------------------------------------------------------- people */

export interface Role {
  readonly id: string;
  readonly key: string;
  readonly name: Localised;
  readonly system: boolean;
  readonly permissions: readonly string[];
}

export interface User {
  readonly id: string;
  readonly displayName: string;
  readonly username: string;
  readonly roleKeys: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

/* ---------------------------------------------------------------- terminals */

export interface Terminal {
  readonly id: string;
  readonly type: TerminalType;
  readonly name: Localised;
  readonly status: TerminalStatus;
  /** Extra permissions the operator granted this specific terminal. */
  readonly permissions: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly soundProfile: SoundProfile;
  /** Present only for TABLE terminals. */
  readonly tableId: string | null;
  /** Stable URL encoded in the printed QR (spec §8). */
  readonly qrUrl: string | null;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
}

export interface RestaurantTable {
  readonly id: string;
  readonly label: string;
  readonly seats: number;
  readonly zone: string | null;
  readonly status: TableStatus;
  readonly terminalId: string;
  readonly qrUrl: string;
  readonly activeOrderIds: readonly string[];
  readonly sortOrder: number;
  readonly createdAt: string;
}

/* ------------------------------------------------------------------- orders */

export interface OrderItemSelection {
  readonly optionId: string;
  readonly choiceId: string;
  readonly name: Localised;
  readonly priceDeltaMinor: number;
}

export interface OrderItemAddon {
  readonly addonId: string;
  readonly name: Localised;
  readonly priceMinor: number;
  readonly quantity: number;
}

export interface OrderItem {
  readonly id: string;
  readonly productId: string;
  /** Name captured at order time: a later menu edit must not rewrite history. */
  readonly name: Localised;
  readonly unitPriceMinor: number;
  readonly quantity: number;
  readonly selections: readonly OrderItemSelection[];
  readonly addons: readonly OrderItemAddon[];
  readonly notes: string | null;
  readonly station: string | null;
  readonly lineTotalMinor: number;
}

/** Who created or acted on something — the accountability record of §15/§19. */
export interface Actor {
  readonly kind: ActorKind;
  readonly userId: string | null;
  readonly userName: string | null;
  readonly terminalId: string | null;
  readonly terminalName: string | null;
}

export interface Order {
  readonly id: string;
  /** Human-facing sequence, unique per restaurant per day: "Order #1042". */
  readonly number: number;
  readonly restaurantId: string;
  readonly tableId: string | null;
  readonly tableLabel: string | null;
  readonly status: OrderStatus;
  readonly source: OrderSource;
  readonly createdBy: Actor;
  readonly servedBy: Actor | null;
  readonly paidBy: Actor | null;
  readonly items: readonly OrderItem[];
  readonly totals: OrderTotals;
  readonly currency: CurrencyConfig;
  readonly notes: string | null;
  readonly guestCount: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export interface Payment {
  readonly id: string;
  readonly orderId: string;
  readonly method: PaymentMethod;
  readonly status: PaymentStatus;
  readonly amountMinor: number;
  readonly tenderedMinor: number | null;
  readonly changeMinor: number | null;
  readonly reference: string | null;
  readonly capturedBy: Actor | null;
  readonly capturedAt: string | null;
  readonly createdAt: string;
}

/* ----------------------------------------------------------------- printing */

export interface Printer {
  readonly id: string;
  readonly name: string;
  readonly transport: PrinterTransport;
  /** Host:port for NETWORK, terminal id for BROWSER, directory for FILE. */
  readonly target: string;
  readonly documentTypes: readonly PrintDocumentType[];
  /** Restrict to products whose `station` is in this list. Empty = all. */
  readonly stations: readonly string[];
  readonly charactersPerLine: number;
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface PrintJob {
  readonly id: string;
  readonly printerId: string;
  readonly documentType: PrintDocumentType;
  readonly orderId: string | null;
  readonly status: 'QUEUED' | 'SENT' | 'FAILED';
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
}

/* --------------------------------------------------------------------- misc */

export interface AuditLogEntry {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly actor: Actor;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly orderId: string | null;
  readonly tableId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly detail: Record<string, unknown>;
}

export interface BackupDescriptor {
  readonly id: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly restaurantId: string;
  readonly appVersion: string;
  readonly createdAt: string;
  readonly checksum: string;
  readonly encrypted: boolean;
  readonly note: string | null;
}

export interface LocaleSummary {
  readonly locale: string;
  readonly name: string;
  readonly englishName: string;
  readonly direction: TextDirection;
  readonly enabled: boolean;
}

export interface ThemeSummary {
  readonly id: string;
  readonly name: string;
  readonly colorScheme: 'light' | 'dark';
  readonly active: boolean;
}
