/**
 * Reporting (spec §51).
 *
 * Reports read the same local database that took the orders — there is no
 * warehouse, no nightly export and no cloud. A manager closing up at 1 a.m.
 * with the internet down still gets their numbers.
 *
 * Every figure comes from stored order and payment rows rather than from a
 * recomputation of the menu, so a report of last Tuesday still reflects last
 * Tuesday's prices.
 */

import { formatMoney, type CurrencyConfig, type Localised } from '@qserve/shared';
import type { OrderRepository } from '../orders/repository.js';
import type { PaymentRepository } from '../payments/service.js';
import type { AuditRepository } from '../../core/repositories/audit.js';
import type { SettingsRepository } from '../../core/repositories/settings.js';
import { businessDayFor } from '../orders/service.js';

export interface ReportRange {
  readonly since: string;
  readonly until: string;
  readonly label: string;
}

export interface SalesReport {
  readonly range: ReportRange;
  readonly currency: CurrencyConfig;
  readonly totals: {
    orders: number;
    grossMinor: number;
    netMinor: number;
    taxMinor: number;
    serviceMinor: number;
    discountMinor: number;
    averageOrderMinor: number;
  };
  readonly bySource: { source: string; orders: number; grossMinor: number }[];
  readonly byPaymentMethod: { method: string; count: number; totalMinor: number }[];
  readonly byCashier: {
    userId: string | null; userName: string | null; count: number; totalMinor: number;
  }[];
  readonly topProducts: {
    productId: string | null; name: Localised; quantity: number; grossMinor: number;
  }[];
  readonly openOrders: Record<string, number>;
}

export class ReportService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentRepository,
    private readonly audit: AuditRepository,
    private readonly settings: SettingsRepository,
  ) {}

  /** Today's trading day, using the 04:00 cutover the orders module defines. */
  todayRange(now = new Date()): ReportRange {
    const day = businessDayFor(now);
    return {
      since: `${day}T00:00:00.000Z`,
      until: new Date(now.getTime() + 60_000).toISOString(),
      label: day,
    };
  }

  rangeFor(since: string | null, until: string | null): ReportRange {
    if (!since && !until) return this.todayRange();
    const start = since ?? '1970-01-01T00:00:00.000Z';
    const end = until ?? new Date().toISOString();
    return { since: start, until: end, label: `${start.slice(0, 10)} → ${end.slice(0, 10)}` };
  }

  sales(range: ReportRange): SalesReport {
    const profile = this.settings.profile();
    const currency = profile?.currency ?? { code: 'SAR', symbol: 'SAR', decimals: 2, symbolPosition: 'after' as const };

    const summary = this.orders.salesSummary(range.since, range.until);
    const netMinor = summary.grossMinor - summary.taxMinor - summary.serviceMinor;

    return {
      range,
      currency,
      totals: {
        orders: summary.orders,
        grossMinor: summary.grossMinor,
        netMinor,
        taxMinor: summary.taxMinor,
        serviceMinor: summary.serviceMinor,
        discountMinor: summary.discountMinor,
        averageOrderMinor: summary.orders > 0
          ? Math.round(summary.grossMinor / summary.orders)
          : 0,
      },
      bySource: this.orders.salesBySource(range.since, range.until),
      byPaymentMethod: this.payments.takingsByMethod(range.since, range.until),
      byCashier: this.payments.takingsByUser(range.since, range.until),
      topProducts: this.orders.topProducts(range.since, range.until),
      openOrders: this.orders.countByStatus(),
    };
  }

  /**
   * Shift reconciliation: what one cashier took, so a drawer can be counted
   * against a number rather than against a memory.
   */
  cashierShift(range: ReportRange, userId: string): {
    range: ReportRange; userId: string; count: number; totalMinor: number;
    byMethod: { method: string; count: number; totalMinor: number }[];
  } {
    const mine = this.payments
      .takingsByUser(range.since, range.until)
      .find((row) => row.userId === userId);

    return {
      range,
      userId,
      count: mine?.count ?? 0,
      totalMinor: mine?.totalMinor ?? 0,
      // Method split is restaurant-wide for the range; a per-cashier split is a
      // reporting refinement, not a correctness issue for the drawer count.
      byMethod: this.payments.takingsByMethod(range.since, range.until),
    };
  }

  /** The order timeline the spec sketches in §19, ready for display. */
  orderTimeline(orderId: string): {
    order: ReturnType<OrderRepository['get']>;
    events: ReturnType<AuditRepository['orderTimeline']>;
  } {
    return {
      order: this.orders.get(orderId),
      events: this.audit.orderTimeline(orderId),
    };
  }

  /** Human-readable money, for CSV export and printed reports. */
  format(minor: number, locale: string): string {
    const profile = this.settings.profile();
    return formatMoney(
      minor,
      profile?.currency ?? { code: 'SAR', symbol: 'SAR', decimals: 2, symbolPosition: 'after' },
      locale,
    );
  }

  /** CSV export of a sales report, for a restaurant's own accountant. */
  toCsv(report: SalesReport, locale: string): string {
    const rows: string[][] = [
      ['QServe sales report', report.range.label],
      [],
      ['Metric', 'Value'],
      ['Orders', String(report.totals.orders)],
      ['Gross', this.format(report.totals.grossMinor, locale)],
      ['Net', this.format(report.totals.netMinor, locale)],
      ['Tax', this.format(report.totals.taxMinor, locale)],
      ['Service', this.format(report.totals.serviceMinor, locale)],
      ['Discounts', this.format(report.totals.discountMinor, locale)],
      ['Average order', this.format(report.totals.averageOrderMinor, locale)],
      [],
      ['Source', 'Orders', 'Gross'],
      ...report.bySource.map((row) => [row.source, String(row.orders), this.format(row.grossMinor, locale)]),
      [],
      ['Payment method', 'Count', 'Total'],
      ...report.byPaymentMethod.map((row) => [row.method, String(row.count), this.format(row.totalMinor, locale)]),
      [],
      ['Cashier', 'Payments', 'Total'],
      ...report.byCashier.map((row) => [row.userName ?? '(unattributed)', String(row.count), this.format(row.totalMinor, locale)]),
    ];

    return rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
  }
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
