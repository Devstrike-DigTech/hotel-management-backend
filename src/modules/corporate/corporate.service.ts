import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { CorporateAccount, Prisma } from '../../generated/prisma/client.js';
import type { AuthUser } from '../../common/auth-types.js';
import { signToken } from '../../common/crypto/signed-token.js';
import { AppException } from '../../common/errors/app-exception.js';
import { addDays, dbDate, diffDays, fromDbDate, humanDate, isIsoDate, lagosDate, lagosStartOfDay, lagosYear } from '../../common/time/lagos.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { DbService, type Tx } from '../../prisma/db.service.js';
import { AuditService, SYSTEM_ACTOR, userActor, type AuditActor } from '../audit/audit.service.js';
import { DocumentsService } from '../invoices/documents.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { renderTemplate } from '../notifications/templates/templates.js';
import { appError, Err, k, paginate, primaryProperty } from '../ops/ops.helpers.js';
import { buildCityLedgerDocument, invoiceListView } from './city-ledger.document.js';
import { agingBucket, allocateOldestFirst, creditCheck, emptyAging, invoiceStatus, type AgingBucket } from './city-ledger.logic.js';
import type { CorporateAccountDto, CreateStatementDto, LedgerPaymentDto, LedgerQueryDto, UpdateCorporateAccountDto } from './corporate.dto.js';

export interface AccountBalance {
  outstandingKobo: number;
  uninvoicedKobo: number;
  overdueKobo: number;
  aging: Record<AgingBucket, number>;
}

/**
 * Corporate accounts and the City Ledger: negotiated rate plans, credit
 * limits, check-out to the ledger, numbered statements (CL-YYYY-NNNNNN),
 * payments with oldest-first allocation, aging and email reminders.
 */
@Injectable()
export class CorporateService {
  private readonly logger = new Logger(CorporateService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly docs: DocumentsService,
    private readonly notifications: NotificationService,
    private readonly config: AppConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // Balances
  // ---------------------------------------------------------------------------

  async balances(tx: Tx, tenantId: string, accountIds: string[], today = lagosDate()): Promise<Map<string, AccountBalance>> {
    const out = new Map<string, AccountBalance>();
    for (const id of accountIds) out.set(id, { outstandingKobo: 0, uninvoicedKobo: 0, overdueKobo: 0, aging: emptyAging() });
    if (!accountIds.length) return out;
    const charges = await tx.cityLedgerCharge.groupBy({ by: ['accountId'], where: { tenantId, accountId: { in: accountIds } }, _sum: { amountKobo: true } });
    const uninvoiced = await tx.cityLedgerCharge.groupBy({ by: ['accountId'], where: { tenantId, accountId: { in: accountIds }, invoiceId: null }, _sum: { amountKobo: true } });
    const payments = await tx.cityLedgerPayment.groupBy({ by: ['accountId'], where: { tenantId, accountId: { in: accountIds } }, _sum: { amountKobo: true } });
    const invoices = await tx.cityLedgerInvoice.findMany({ where: { tenantId, accountId: { in: accountIds }, status: { in: ['OPEN', 'PARTIALLY_PAID'] } } });
    for (const c of charges) out.get(c.accountId)!.outstandingKobo += k(c._sum.amountKobo);
    for (const p of payments) out.get(p.accountId)!.outstandingKobo -= k(p._sum.amountKobo);
    for (const u of uninvoiced) {
      const b = out.get(u.accountId)!;
      b.uninvoicedKobo = k(u._sum.amountKobo);
      b.aging.CURRENT += b.uninvoicedKobo;
    }
    for (const inv of invoices) {
      const b = out.get(inv.accountId)!;
      const bal = Math.max(0, k(inv.totalKobo) - k(inv.paidKobo));
      b.aging[agingBucket(Math.max(0, diffDays(fromDbDate(inv.issueDate), today)))] += bal;
      if (today > fromDbDate(inv.dueDate)) b.overdueKobo += bal;
    }
    return out;
  }

  async outstanding(tx: Tx, tenantId: string, accountId: string): Promise<number> {
    return (await this.balances(tx, tenantId, [accountId])).get(accountId)!.outstandingKobo;
  }

  private async accountView(tx: Tx, a: CorporateAccount & { ratePlan: { id: string; code: string; name: string } | null }, bal?: AccountBalance) {
    const b = bal ?? (await this.balances(tx, a.tenantId, [a.id])).get(a.id)!;
    const now = new Date();
    const [upcoming, inHouse, recent] = await Promise.all([
      tx.reservation.count({ where: { corporateAccountId: a.id, status: { in: ['PENDING', 'CONFIRMED'] }, arrivalAt: { gte: now } } }),
      tx.reservation.count({ where: { corporateAccountId: a.id, status: 'CHECKED_IN' } }),
      tx.reservation.count({ where: { corporateAccountId: a.id, status: 'CHECKED_OUT', checkedOutAt: { gte: new Date(now.getTime() - 90 * 86_400_000) } } }),
    ]);
    const limit = k(a.creditLimitKobo);
    return {
      id: a.id,
      name: a.name,
      contactName: a.contactName,
      email: a.email,
      phone: a.phone,
      address: a.address,
      taxId: a.taxId,
      ratePlan: a.ratePlan ? { id: a.ratePlan.id, code: a.ratePlan.code, name: a.ratePlan.name } : null,
      creditLimitKobo: limit,
      paymentTermsDays: a.paymentTermsDays,
      billingCycle: a.billingCycle,
      active: a.active,
      notes: a.notes,
      outstandingKobo: b.outstandingKobo,
      uninvoicedKobo: b.uninvoicedKobo,
      availableCreditKobo: limit - b.outstandingKobo,
      overdueKobo: b.overdueKobo,
      aging: b.aging,
      stays: { upcoming, inHouse, last90Days: recent },
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------

  list(user: AuthUser, q: { active?: string; q?: string }) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const rows = await tx.corporateAccount.findMany({
        where: {
          tenantId: user.tenantId,
          ...(q.active === 'true' ? { active: true } : q.active === 'false' ? { active: false } : {}),
          ...(q.q && { name: { contains: q.q, mode: 'insensitive' } }),
        },
        include: { ratePlan: { select: { id: true, code: true, name: true } } },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
      });
      const bal = await this.balances(tx, user.tenantId, rows.map((r) => r.id));
      const out = [];
      for (const r of rows) out.push(await this.accountView(tx, r, bal.get(r.id)));
      return out;
    });
  }

  get(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const a = await tx.corporateAccount.findFirst({ where: { id, tenantId: user.tenantId }, include: { ratePlan: { select: { id: true, code: true, name: true } } } });
      if (!a) throw AppException.notFound('Corporate account');
      const invoices = await tx.cityLedgerInvoice.findMany({
        where: { accountId: id, OR: [{ status: { in: ['OPEN', 'PARTIALLY_PAID'] } }, { createdAt: { gte: new Date(Date.now() - 365 * 86_400_000) } }] },
        include: { account: { select: { id: true, name: true } } },
        orderBy: { issueDate: 'desc' },
        take: 30,
      });
      const uninvoiced = await tx.cityLedgerCharge.findMany({ where: { accountId: id, invoiceId: null }, orderBy: { date: 'asc' } });
      const payments = await tx.cityLedgerPayment.findMany({ where: { accountId: id }, orderBy: { receivedAt: 'desc' }, take: 10, include: { allocations: { include: { invoice: { select: { number: true } } } } } });
      return {
        ...(await this.accountView(tx, a)),
        invoices: invoices.map((i) => invoiceListView(i)),
        uninvoiced: uninvoiced.map((c) => this.chargeView(c, null)),
        recentPayments: payments.map((p) => this.paymentView(p)),
      };
    });
  }

  private async checkPlan(tx: Tx, tenantId: string, ratePlanId: string | null | undefined) {
    if (!ratePlanId) return;
    const p = await tx.ratePlan.findFirst({ where: { id: ratePlanId, tenantId } });
    if (!p) throw Err.validation('ratePlanId', 'Unknown rate plan');
  }

  create(user: AuthUser, dto: CorporateAccountDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      await this.checkPlan(tx, user.tenantId, dto.ratePlanId);
      if (await tx.corporateAccount.findFirst({ where: { tenantId: user.tenantId, name: { equals: dto.name.trim(), mode: 'insensitive' } } })) {
        throw AppException.conflict('An account with this name already exists');
      }
      const a = await tx.corporateAccount.create({
        data: {
          tenantId: user.tenantId,
          name: dto.name.trim(),
          contactName: dto.contactName ?? '',
          email: dto.email.toLowerCase(),
          phone: dto.phone ?? '',
          address: dto.address ?? '',
          taxId: dto.taxId ?? '',
          ratePlanId: dto.ratePlanId ?? null,
          creditLimitKobo: BigInt(dto.creditLimitKobo),
          paymentTermsDays: dto.paymentTermsDays ?? 30,
          billingCycle: dto.billingCycle ?? 'MONTHLY',
          active: dto.active ?? true,
          notes: dto.notes ?? '',
        },
        include: { ratePlan: { select: { id: true, code: true, name: true } } },
      });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'corporate.created', entityType: 'corporate_account', entityId: a.id, metadata: { name: a.name, creditLimitKobo: dto.creditLimitKobo }, ip });
      return this.accountView(tx, a);
    });
  }

  update(user: AuthUser, id: string, dto: UpdateCorporateAccountDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const a = await tx.corporateAccount.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!a) throw AppException.notFound('Corporate account');
      await this.checkPlan(tx, user.tenantId, dto.ratePlanId);
      const updated = await tx.corporateAccount.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name.trim() }),
          ...(dto.contactName !== undefined && { contactName: dto.contactName }),
          ...(dto.email !== undefined && { email: dto.email.toLowerCase() }),
          ...(dto.phone !== undefined && { phone: dto.phone }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.taxId !== undefined && { taxId: dto.taxId }),
          ...(dto.ratePlanId !== undefined && { ratePlanId: dto.ratePlanId }),
          ...(dto.creditLimitKobo !== undefined && { creditLimitKobo: BigInt(dto.creditLimitKobo) }),
          ...(dto.paymentTermsDays !== undefined && { paymentTermsDays: dto.paymentTermsDays }),
          ...(dto.billingCycle !== undefined && { billingCycle: dto.billingCycle }),
          ...(dto.active !== undefined && { active: dto.active }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
        },
        include: { ratePlan: { select: { id: true, code: true, name: true } } },
      });
      await this.audit.record(tx, {
        tenantId: user.tenantId,
        actor: userActor(user),
        action: 'corporate.updated',
        entityType: 'corporate_account',
        entityId: id,
        metadata: { name: updated.name, changes: Object.keys(dto), ...(dto.creditLimitKobo !== undefined && { creditLimitFrom: k(a.creditLimitKobo), creditLimitTo: dto.creditLimitKobo }) },
        ip,
      });
      return this.accountView(tx, updated);
    });
  }

  /** Active account for a booking (404 / ACCOUNT_INACTIVE). */
  async activeAccount(tx: Tx, tenantId: string, id: string) {
    const a = await tx.corporateAccount.findFirst({ where: { id, tenantId } });
    if (!a) throw AppException.notFound('Corporate account');
    if (!a.active) throw appError(HttpStatus.CONFLICT, 'ACCOUNT_INACTIVE', `${a.name} is not active`);
    return a;
  }

  // ---------------------------------------------------------------------------
  // Check-out to the ledger
  // ---------------------------------------------------------------------------

  /** Credit check for a check-out charge; throws CREDIT_LIMIT_EXCEEDED unless overridden. */
  async assertCredit(tx: Tx, tenantId: string, account: CorporateAccount, balanceKobo: number, overridden: boolean) {
    const outstanding = await this.outstanding(tx, tenantId, account.id);
    const c = creditCheck(k(account.creditLimitKobo), outstanding, balanceKobo);
    if (!c.ok && !overridden) {
      throw appError(HttpStatus.CONFLICT, 'CREDIT_LIMIT_EXCEEDED', `${account.name} would go over its credit limit`, {
        creditLimitKobo: k(account.creditLimitKobo),
        outstandingKobo: outstanding,
        balanceKobo,
        availableKobo: c.availableKobo,
      });
    }
    return { withinLimit: c.ok, outstandingKobo: outstanding, availableKobo: c.availableKobo };
  }

  /** Records the stay's balance on the account's ledger; PER_STAY accounts get their invoice at once. */
  async chargeCheckout(
    tx: Tx,
    tenantId: string,
    input: {
      account: CorporateAccount;
      reservation: { id: string; code: string; guestName: string } | null;
      folioId: string;
      folioEntryId: string;
      amountKobo: number;
      actor: { id: string; fullName: string } | null;
      roomLabel: string;
      /** M5: POS charges describe themselves; stays default to "Accommodation, ...". */
      description?: string;
      guestName?: string | null;
      propertyId?: string | null;
    },
  ) {
    const folio = await tx.folio.findFirst({ where: { id: input.folioId }, select: { propertyId: true } });
    const charge = await tx.cityLedgerCharge.create({
      data: {
        tenantId,
        propertyId: input.propertyId ?? folio?.propertyId ?? null,
        accountId: input.account.id,
        reservationId: input.reservation?.id ?? null,
        folioId: input.folioId,
        folioEntryId: input.folioEntryId,
        date: dbDate(lagosDate()),
        description: input.description ?? `Accommodation, ${input.roomLabel} (${input.reservation?.code ?? ''})`,
        amountKobo: BigInt(input.amountKobo),
        guestName: input.guestName ?? input.reservation?.guestName ?? null,
        reservationCode: input.reservation?.code ?? null,
        createdById: input.actor?.id ?? null,
      },
    });
    let invoice = null;
    if (input.account.billingCycle === 'PER_STAY') {
      invoice = await this.issue(tx, tenantId, input.account, [charge.id], { kind: 'PER_STAY', actor: input.actor });
    }
    return { charge: this.chargeView(charge, invoice?.number ?? null), invoice: invoice ? invoiceListView({ ...invoice, account: { id: input.account.id, name: input.account.name } }) : null };
  }

  private chargeView(c: { id: string; propertyId?: string | null; accountId: string; reservationId: string | null; reservationCode: string | null; guestName: string | null; folioId: string | null; date: Date; description: string; amountKobo: bigint; invoiceId: string | null; createdAt: Date }, invoiceNumber: string | null) {
    return {
      id: c.id,
      propertyId: c.propertyId ?? null,
      accountId: c.accountId,
      reservationId: c.reservationId,
      reservationCode: c.reservationCode,
      guestName: c.guestName,
      folioId: c.folioId,
      date: fromDbDate(c.date),
      description: c.description,
      amountKobo: k(c.amountKobo),
      invoiceId: c.invoiceId,
      invoiceNumber,
      createdAt: c.createdAt.toISOString(),
    };
  }

  private paymentView(p: { id: string; accountId: string; amountKobo: bigint; method: string; reference: string | null; receivedAt: Date; note: string | null; recordedById: string | null; recordedByName: string | null; createdAt: Date; allocations?: { invoiceId: string; amountKobo: bigint; invoice?: { number: string } }[] }) {
    const first = p.allocations?.[0];
    return {
      id: p.id,
      accountId: p.accountId,
      invoiceId: first?.invoiceId ?? null,
      invoiceNumber: first?.invoice?.number ?? null,
      allocations: (p.allocations ?? []).map((a) => ({ invoiceId: a.invoiceId, number: a.invoice?.number ?? null, amountKobo: k(a.amountKobo) })),
      amountKobo: k(p.amountKobo),
      method: p.method,
      reference: p.reference,
      receivedAt: p.receivedAt.toISOString(),
      note: p.note,
      recordedBy: p.recordedById ? { id: p.recordedById, fullName: p.recordedByName ?? '' } : null,
      createdAt: p.createdAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------------

  /** Issues a numbered invoice over the given uninvoiced charges. */
  async issue(
    tx: Tx,
    tenantId: string,
    account: CorporateAccount,
    chargeIds: string[],
    opts: { kind: 'PER_STAY' | 'STATEMENT'; periodFrom?: string | null; periodTo?: string | null; notes?: string; actor: { id: string; fullName: string } | null },
  ) {
    const charges = await tx.cityLedgerCharge.findMany({ where: { tenantId, accountId: account.id, id: { in: chargeIds }, invoiceId: null } });
    if (!charges.length) throw AppException.badRequest('There are no uninvoiced charges to put on a statement');
    const total = charges.reduce((a, c) => a + k(c.amountKobo), 0);
    const today = lagosDate();
    const year = lagosYear();
    const { seq, number } = await this.docs.nextNumber(tx, tenantId, 'CITY_LEDGER', year);
    const inv = await tx.cityLedgerInvoice.create({
      data: {
        tenantId,
        accountId: account.id,
        number,
        year,
        seq,
        kind: opts.kind,
        periodFrom: opts.periodFrom ? dbDate(opts.periodFrom) : null,
        periodTo: opts.periodTo ? dbDate(opts.periodTo) : null,
        issueDate: dbDate(today),
        dueDate: dbDate(addDays(today, account.paymentTermsDays)),
        totalKobo: BigInt(total),
        notes: opts.notes ?? '',
        issuedById: opts.actor?.id ?? null,
        issuedByName: opts.actor?.fullName ?? null,
      },
    });
    await tx.cityLedgerCharge.updateMany({ where: { id: { in: charges.map((c) => c.id) } }, data: { invoiceId: inv.id } });
    // Account credit (payments not yet allocated) settles the new invoice first.
    await this.applyCredit(tx, tenantId, account.id);
    await this.audit.record(tx, {
      tenantId,
      actor: opts.actor ? { kind: 'user', id: opts.actor.id, name: opts.actor.fullName } : SYSTEM_ACTOR,
      action: 'city_ledger.invoice_issued',
      entityType: 'city_ledger_invoice',
      entityId: inv.id,
      metadata: { number, account: account.name, totalKobo: total, charges: charges.length, kind: opts.kind },
    });
    return (await tx.cityLedgerInvoice.findUniqueOrThrow({ where: { id: inv.id } }));
  }

  /** Allocates unallocated payment money of the account to open invoices, oldest first. */
  private async applyCredit(tx: Tx, tenantId: string, accountId: string) {
    const payments = await tx.cityLedgerPayment.findMany({ where: { tenantId, accountId }, include: { allocations: true }, orderBy: { receivedAt: 'asc' } });
    for (const p of payments) {
      const left = k(p.amountKobo) - p.allocations.reduce((a, x) => a + k(x.amountKobo), 0);
      if (left <= 0) continue;
      await this.allocate(tx, tenantId, accountId, p.id, left);
    }
  }

  private async allocate(tx: Tx, tenantId: string, accountId: string, paymentId: string, amountKobo: number, onlyInvoiceId?: string) {
    const open = await tx.cityLedgerInvoice.findMany({
      where: { tenantId, accountId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, ...(onlyInvoiceId && { id: onlyInvoiceId }) },
      orderBy: [{ issueDate: 'asc' }, { seq: 'asc' }],
    });
    const plan = allocateOldestFirst(amountKobo, open.map((i) => ({ id: i.id, balanceKobo: k(i.totalKobo) - k(i.paidKobo) })));
    for (const a of plan.allocations) {
      await tx.cityLedgerAllocation.create({ data: { tenantId, paymentId, invoiceId: a.invoiceId, amountKobo: BigInt(a.amountKobo) } });
      const inv = open.find((i) => i.id === a.invoiceId)!;
      const paid = k(inv.paidKobo) + a.amountKobo;
      await tx.cityLedgerInvoice.update({ where: { id: inv.id }, data: { paidKobo: BigInt(paid), status: invoiceStatus(k(inv.totalKobo), paid, false) } });
    }
    return plan;
  }

  createStatement(user: AuthUser, dto: CreateStatementDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const account = await tx.corporateAccount.findFirst({ where: { id: dto.accountId, tenantId: user.tenantId } });
      if (!account) throw AppException.notFound('Corporate account');
      if (dto.periodFrom && !isIsoDate(dto.periodFrom)) throw Err.validation('periodFrom', 'periodFrom must be YYYY-MM-DD');
      if (dto.periodTo && !isIsoDate(dto.periodTo)) throw Err.validation('periodTo', 'periodTo must be YYYY-MM-DD');
      const where: Prisma.CityLedgerChargeWhereInput = {
        tenantId: user.tenantId,
        accountId: account.id,
        invoiceId: null,
        ...(dto.chargeIds?.length && { id: { in: dto.chargeIds } }),
        ...((dto.periodFrom || dto.periodTo) && {
          date: { ...(dto.periodFrom && { gte: dbDate(dto.periodFrom) }), ...(dto.periodTo && { lte: dbDate(dto.periodTo) }) },
        }),
      };
      const charges = await tx.cityLedgerCharge.findMany({ where, select: { id: true, date: true }, orderBy: { date: 'asc' } });
      const inv = await this.issue(tx, user.tenantId, account, charges.map((c) => c.id), {
        kind: 'STATEMENT',
        periodFrom: dto.periodFrom ?? (charges[0] ? fromDbDate(charges[0].date) : null),
        periodTo: dto.periodTo ?? (charges.length ? fromDbDate(charges[charges.length - 1].date) : null),
        notes: dto.notes,
        actor: { id: user.userId, fullName: user.fullName },
      });
      void ip;
      return buildCityLedgerDocument(tx, user.tenantId, inv.id, this.config.get('APP_NAME'));
    });
  }

  /** Monthly job: statements for MONTHLY accounts with uninvoiced charges up to the end of last month. */
  async monthlyStatements(tenantId: string): Promise<number> {
    const today = lagosDate();
    const monthStart = `${today.slice(0, 7)}-01`;
    const lastDay = addDays(monthStart, -1);
    return this.db.tenant(tenantId, async (tx) => {
      const accounts = await tx.corporateAccount.findMany({ where: { tenantId, billingCycle: 'MONTHLY' } });
      let issued = 0;
      for (const a of accounts) {
        const charges = await tx.cityLedgerCharge.findMany({ where: { tenantId, accountId: a.id, invoiceId: null, date: { lte: dbDate(lastDay) } }, select: { id: true, date: true }, orderBy: { date: 'asc' } });
        if (!charges.length) continue;
        await this.issue(tx, tenantId, a, charges.map((c) => c.id), { kind: 'STATEMENT', periodFrom: fromDbDate(charges[0].date), periodTo: lastDay, actor: null });
        issued++;
      }
      return issued;
    });
  }

  summary(user: AuthUser) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const accounts = await tx.corporateAccount.findMany({ where: { tenantId: user.tenantId }, orderBy: { name: 'asc' } });
      const bal = await this.balances(tx, user.tenantId, accounts.map((a) => a.id));
      const aging = emptyAging();
      let outstanding = 0;
      let uninvoiced = 0;
      let overdue = 0;
      const rows = accounts.map((a) => {
        const b = bal.get(a.id)!;
        outstanding += b.outstandingKobo;
        uninvoiced += b.uninvoicedKobo;
        overdue += b.overdueKobo;
        for (const key of Object.keys(aging) as AgingBucket[]) aging[key] += b.aging[key];
        const limit = k(a.creditLimitKobo);
        return {
          id: a.id,
          name: a.name,
          active: a.active,
          creditLimitKobo: limit,
          outstandingKobo: b.outstandingKobo,
          availableCreditKobo: limit - b.outstandingKobo,
          overdueKobo: b.overdueKobo,
          aging: b.aging,
          overLimit: b.outstandingKobo > limit,
        };
      });
      return { outstandingKobo: outstanding, uninvoicedKobo: uninvoiced, overdueKobo: overdue, aging, accounts: rows };
    });
  }

  charges(user: AuthUser, q: LedgerQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.CityLedgerChargeWhereInput = {
        tenantId: user.tenantId,
        ...(q.accountId && { accountId: q.accountId }),
        ...(q.invoiced === 'false' && { invoiceId: null }),
        ...(q.invoiced === 'true' && { invoiceId: { not: null } }),
        ...((q.from || q.to) && { date: { ...(q.from && { gte: dbDate(q.from) }), ...(q.to && { lte: dbDate(q.to) }) } }),
      };
      const rows = await tx.cityLedgerCharge.findMany({ where, include: { invoice: { select: { number: true } } }, orderBy: { date: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.cityLedgerCharge.count({ where });
      return { items: rows.map((c) => this.chargeView(c, c.invoice?.number ?? null)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  invoices(user: AuthUser, q: LedgerQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const today = lagosDate();
      const statuses = q.status?.split(',').filter((s) => ['OPEN', 'PARTIALLY_PAID', 'PAID', 'VOID'].includes(s)) as ('OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'VOID')[] | undefined;
      const where: Prisma.CityLedgerInvoiceWhereInput = {
        tenantId: user.tenantId,
        ...(q.accountId && { accountId: q.accountId }),
        ...(statuses?.length && { status: { in: statuses } }),
        ...(q.overdue === 'true' && { status: { in: ['OPEN', 'PARTIALLY_PAID'] }, dueDate: { lt: dbDate(today) } }),
      };
      let rows = await tx.cityLedgerInvoice.findMany({ where, include: { account: { select: { id: true, name: true } } }, orderBy: [{ issueDate: 'desc' }, { seq: 'desc' }] });
      let items = rows.map((r) => invoiceListView(r, today));
      if (q.bucket) items = items.filter((i) => i.bucket === q.bucket && i.balanceKobo > 0);
      const total = items.length;
      rows = [];
      return { items: items.slice(pg.skip, pg.skip + pg.take), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  invoice(user: AuthUser, id: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const doc = await buildCityLedgerDocument(tx, user.tenantId, id, this.config.get('APP_NAME'));
      if (!doc) throw AppException.notFound('Statement');
      return doc;
    });
  }

  recordInvoicePayment(user: AuthUser, invoiceId: string, dto: LedgerPaymentDto, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const inv = await tx.cityLedgerInvoice.findFirst({ where: { id: invoiceId, tenantId: user.tenantId } });
      if (!inv) throw AppException.notFound('Statement');
      if (inv.status === 'VOID' || inv.status === 'PAID') throw Err.invalidState(inv.status, ['OPEN', 'PARTIALLY_PAID'], 'This statement');
      const balance = k(inv.totalKobo) - k(inv.paidKobo);
      if (dto.amountKobo > balance) throw AppException.badRequest('The payment is more than the statement balance; record it against the account instead', { balanceKobo: balance });
      const p = await this.insertPayment(tx, user, inv.accountId, dto);
      await this.allocate(tx, user.tenantId, inv.accountId, p.id, dto.amountKobo, inv.id);
      await this.auditPayment(tx, user, p.id, inv.accountId, dto, [inv.number], ip);
      return buildCityLedgerDocument(tx, user.tenantId, inv.id, this.config.get('APP_NAME'));
    });
  }

  recordAccountPayment(user: AuthUser, dto: LedgerPaymentDto & { accountId: string }, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const a = await tx.corporateAccount.findFirst({ where: { id: dto.accountId, tenantId: user.tenantId } });
      if (!a) throw AppException.notFound('Corporate account');
      const p = await this.insertPayment(tx, user, a.id, dto);
      const plan = await this.allocate(tx, user.tenantId, a.id, p.id, dto.amountKobo);
      const numbers = await tx.cityLedgerInvoice.findMany({ where: { id: { in: plan.allocations.map((x) => x.invoiceId) } }, select: { id: true, number: true } });
      const num = new Map(numbers.map((n) => [n.id, n.number]));
      await this.auditPayment(tx, user, p.id, a.id, dto, [...num.values()], ip);
      const full = await tx.cityLedgerPayment.findUniqueOrThrow({ where: { id: p.id }, include: { allocations: { include: { invoice: { select: { number: true } } } } } });
      return {
        payment: this.paymentView(full),
        allocations: plan.allocations.map((x) => ({ invoiceId: x.invoiceId, number: num.get(x.invoiceId) ?? '', amountKobo: x.amountKobo })),
        creditKobo: plan.leftoverKobo,
      };
    });
  }

  private insertPayment(tx: Tx, user: AuthUser, accountId: string, dto: LedgerPaymentDto) {
    const receivedAt = dto.receivedAt ? new Date(dto.receivedAt) : new Date();
    if (Number.isNaN(receivedAt.getTime()) || receivedAt.getTime() > Date.now() + 5 * 60_000) throw Err.validation('receivedAt', 'receivedAt must be a past ISO timestamp');
    return tx.cityLedgerPayment.create({
      data: {
        tenantId: user.tenantId,
        accountId,
        amountKobo: BigInt(dto.amountKobo),
        method: dto.method,
        reference: dto.reference ?? null,
        receivedAt,
        note: dto.note ?? null,
        recordedById: user.userId,
        recordedByName: user.fullName,
      },
    });
  }

  private auditPayment(tx: Tx, user: AuthUser, paymentId: string, accountId: string, dto: LedgerPaymentDto, invoices: string[], ip?: string) {
    return this.audit.record(tx, {
      tenantId: user.tenantId,
      actor: userActor(user),
      action: 'city_ledger.payment_recorded',
      entityType: 'city_ledger_payment',
      entityId: paymentId,
      metadata: { accountId, amountKobo: dto.amountKobo, method: dto.method, reference: dto.reference ?? null, invoices },
      ip,
    });
  }

  payments(user: AuthUser, q: LedgerQueryDto) {
    const pg = paginate(q.page, q.pageSize);
    return this.db.tenant(user.tenantId, async (tx) => {
      const where: Prisma.CityLedgerPaymentWhereInput = {
        tenantId: user.tenantId,
        ...(q.accountId && { accountId: q.accountId }),
        ...((q.from || q.to) && {
          receivedAt: { ...(q.from && { gte: lagosStartOfDay(q.from) }), ...(q.to && { lt: lagosStartOfDay(addDays(q.to, 1)) }) },
        }),
      };
      const rows = await tx.cityLedgerPayment.findMany({ where, include: { allocations: { include: { invoice: { select: { number: true } } } } }, orderBy: { receivedAt: 'desc' }, skip: pg.skip, take: pg.take });
      const total = await tx.cityLedgerPayment.count({ where });
      return { items: rows.map((p) => this.paymentView(p)), total, page: pg.page, pageSize: pg.pageSize };
    });
  }

  voidInvoice(user: AuthUser, id: string, reason: string, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const inv = await tx.cityLedgerInvoice.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!inv) throw AppException.notFound('Statement');
      if (inv.status === 'VOID') throw Err.invalidState(inv.status, ['OPEN'], 'This statement');
      if (k(inv.paidKobo) > 0) throw AppException.conflict('A statement with payments cannot be voided');
      await tx.cityLedgerCharge.updateMany({ where: { invoiceId: id }, data: { invoiceId: null } });
      await tx.cityLedgerInvoice.update({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'city_ledger.invoice_voided', entityType: 'city_ledger_invoice', entityId: id, metadata: { number: inv.number, reason }, ip });
      return buildCityLedgerDocument(tx, user.tenantId, id, this.config.get('APP_NAME'));
    });
  }

  shareUrl(tenantId: string, invoiceId: string, expiresInHours = 336) {
    const exp = Math.floor(Date.now() / 1000) + expiresInHours * 3600;
    const token = signToken(this.config.get('SHARE_TOKEN_SECRET'), 'doc', { t: 'CITY_LEDGER_INVOICE', id: invoiceId, tid: tenantId, exp });
    return { token, url: `${this.config.get('ADMIN_URL').replace(/\/$/, '')}/share/${token}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  share(user: AuthUser, id: string, expiresInHours?: number, ip?: string) {
    return this.db.tenant(user.tenantId, async (tx) => {
      const inv = await tx.cityLedgerInvoice.findFirst({ where: { id, tenantId: user.tenantId } });
      if (!inv) throw AppException.notFound('Statement');
      const out = this.shareUrl(user.tenantId, id, expiresInHours ?? 336);
      await this.audit.record(tx, { tenantId: user.tenantId, actor: userActor(user), action: 'city_ledger.invoice_shared', entityType: 'city_ledger_invoice', entityId: id, metadata: { number: inv.number }, ip });
      return out;
    });
  }

  /** Emails a reminder for a statement (manual or from the daily job). */
  async remindTx(tx: Tx, tenantId: string, invoiceId: string, actor: AuditActor, message?: string | null, dedupeKey?: string) {
    const inv = await tx.cityLedgerInvoice.findFirst({ where: { id: invoiceId, tenantId }, include: { account: true } });
    if (!inv) throw AppException.notFound('Statement');
    if (inv.status !== 'OPEN' && inv.status !== 'PARTIALLY_PAID') throw Err.invalidState(inv.status, ['OPEN', 'PARTIALLY_PAID'], 'This statement');
    const p = await primaryProperty(tx, tenantId);
    const today = lagosDate();
    const due = fromDbDate(inv.dueDate);
    const rendered = renderTemplate(
      {
        appName: this.config.get('APP_NAME'),
        appDomain: this.config.get('APP_DOMAIN'),
        supportEmail: this.config.get('SUPPORT_EMAIL'),
        hotel: { name: p.name, accentColor: p.accentColor, logoUrl: p.logoUrl, area: p.area, city: p.city },
        hotelBranded: true,
      },
      {
        template: 'CITY_LEDGER_REMINDER',
        hotelName: p.name,
        accountName: inv.account.name,
        contactName: inv.account.contactName,
        invoiceNumber: inv.number,
        issueHuman: humanDate(fromDbDate(inv.issueDate)),
        dueHuman: humanDate(due),
        totalKobo: k(inv.totalKobo),
        balanceKobo: k(inv.totalKobo) - k(inv.paidKobo),
        daysOverdue: today > due ? diffDays(due, today) : 0,
        message: message ?? null,
        statementUrl: this.shareUrl(tenantId, inv.id).url,
        hotelPhone: p.phone,
        hotelEmail: p.email,
      },
    );
    const ids = await this.notifications.queueTx(tx, [
      {
        tenantId,
        template: 'CITY_LEDGER_REMINDER',
        channel: 'EMAIL',
        audience: 'HOTEL',
        to: inv.account.email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        fromName: p.name,
        dedupeKey,
      },
    ]);
    if (ids.length) {
      await tx.cityLedgerInvoice.update({ where: { id: inv.id }, data: { remindersSent: { increment: 1 }, lastReminderAt: new Date() } });
      await this.audit.record(tx, { tenantId, actor, action: 'city_ledger.reminder_sent', entityType: 'city_ledger_invoice', entityId: inv.id, metadata: { number: inv.number, to: inv.account.email } });
    }
    return { sentTo: inv.account.email, notificationId: ids[0] ?? null };
  }

  async remind(user: AuthUser, id: string, message?: string) {
    const out = await this.db.tenant(user.tenantId, (tx) => this.remindTx(tx, user.tenantId, id, userActor(user), message));
    if (out.notificationId) await this.notifications.dispatch([out.notificationId]);
    return out;
  }

  /** Daily job: reminders at 1, 15 and 30 days overdue (once each). */
  async overdueReminders(tenantId: string): Promise<number> {
    const today = lagosDate();
    const ids = await this.db.tenant(tenantId, async (tx) => {
      const open = await tx.cityLedgerInvoice.findMany({ where: { tenantId, status: { in: ['OPEN', 'PARTIALLY_PAID'] }, dueDate: { lt: dbDate(today) } } });
      const out: string[] = [];
      for (const inv of open) {
        const days = diffDays(fromDbDate(inv.dueDate), today);
        const step = [30, 15, 1].find((d) => days >= d);
        if (!step) continue;
        const r = await this.remindTx(tx, tenantId, inv.id, SYSTEM_ACTOR, null, `CL_REMINDER:${inv.id}:${step}`);
        if (r.notificationId) out.push(r.notificationId);
      }
      return out;
    });
    if (ids.length) await this.notifications.dispatch(ids);
    return ids.length;
  }
}
