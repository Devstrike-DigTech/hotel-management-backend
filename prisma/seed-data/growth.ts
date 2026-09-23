/**
 * M4 (Growth tier) demo data for The Palmwine House: housekeeping team and
 * today's board, lost & found, maintenance (tickets, room 106 blocked for two
 * days, preventive schedules, 30 days of diesel), rate plans, seasons,
 * overrides and restrictions, promo codes, corporate accounts with city-ledger
 * invoices across every aging bucket, and owner WhatsApp alert settings.
 *
 * Runs after the operations and guest-side seeds (which rebuild the tenant's
 * reservations), so it deletes and recreates its own rows: idempotent.
 * Every other hotel gets its Best Available Rate plan and the M4 per-night
 * rate snapshot on existing reservations.
 */
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { addDays, dbDate, diffDays, lagosDate, lagosDateTime } from '../../src/common/time/lagos.js';
import { checklistItems, DEFAULT_CHECKLISTS } from '../../src/modules/housekeeping/housekeeping.logic.js';
import { slaDueAt, ticketNumber } from '../../src/modules/maintenance/maintenance.logic.js';
import { promoDiscounts } from '../../src/modules/rates/rates.logic.js';
import { componentsFrom, computeCharge } from '../../src/modules/folios/tax.logic.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NAIRA = 100;

/** Deterministic pseudo-random numbers so re-seeding gives the same demo. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The next occurrence (today or later) of a month-day. */
function nextOn(today: string, mmdd: string): string {
  const y = Number(today.slice(0, 4));
  const d = `${y}-${mmdd}`;
  return d >= today ? d : `${y + 1}-${mmdd}`;
}

// -----------------------------------------------------------------------------
// Every hotel: BAR plan and per-night snapshots
// -----------------------------------------------------------------------------

/** Best Available Rate plan for every property, and M4 rate snapshots on reservations that lack one. */
export async function seedRatePlansEverywhere(prisma: PrismaClient): Promise<number> {
  const properties = await prisma.property.findMany({ select: { id: true, tenantId: true } });
  for (const p of properties) {
    await prisma.ratePlan.upsert({
      where: { tenantId_code: { tenantId: p.tenantId, code: 'BAR' } },
      create: {
        tenantId: p.tenantId,
        propertyId: p.id,
        code: 'BAR',
        name: 'Best Available Rate',
        description: 'Flexible rate at the day\'s best price.',
        kind: 'BAR',
        isBar: true,
        pricing: 'DERIVED',
        sortOrder: 0,
      },
      update: { isBar: true, active: true, kind: 'BAR', pricing: 'DERIVED' },
    });
  }
  await backfillSnapshots(prisma);
  return properties.length;
}

/** Same backfill as the M4 migration: BAR plan and one snapshot night per night at the stay's single rate. */
async function backfillSnapshots(prisma: PrismaClient, tenantId?: string) {
  const scope = tenantId ? `AND r.tenant_id = '${tenantId}'::uuid` : '';
  await prisma.$executeRawUnsafe(`
    UPDATE reservations r SET rate_plan_id = rp.id
      FROM rate_plans rp
     WHERE rp.tenant_id = r.tenant_id AND rp.is_bar AND r.rate_plan_id IS NULL ${scope}`);
  await prisma.$executeRawUnsafe(`
    UPDATE reservations r
       SET nightly_rates = COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'date', to_char(d, 'YYYY-MM-DD'), 'rateKobo', r.rate_kobo, 'baseRateKobo', r.rate_kobo,
                  'source', 'BASE', 'ruleId', NULL, 'ruleName', NULL, 'discountKobo', 0) ORDER BY d)
           FROM generate_series((r.arrival_at AT TIME ZONE 'Africa/Lagos')::date,
                                (r.departure_at AT TIME ZONE 'Africa/Lagos')::date - 1, interval '1 day') AS d
       ), '[]'::jsonb)
     WHERE r.stay_type = 'NIGHTLY' AND r.nightly_rates = '[]'::jsonb ${scope}`);
}

// -----------------------------------------------------------------------------
// The Palmwine House
// -----------------------------------------------------------------------------

interface Person {
  id: string;
  fullName: string;
}

interface NightSnap {
  date: string;
  rateKobo: number;
  baseRateKobo: number;
  source: string;
  ruleId: string | null;
  ruleName: string | null;
  discountKobo: number;
}

export async function seedGrowth(prisma: PrismaClient, tenantSlug: string): Promise<Record<string, number>> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: tenantSlug } });
  const property = await prisma.property.findFirstOrThrow({ where: { tenantId: tenant.id } });
  const tenantId = tenant.id;
  const now = new Date();
  const T = lagosDate(now);
  const rand = prng(20261001);
  const at = (date: string, time: string) => lagosDateTime(date, time);
  /** A time today, never later than `minutesBeforeNow` ago. */
  const todayAt = (time: string, minutesBeforeNow: number) => new Date(Math.min(at(T, time).getTime(), now.getTime() - minutesBeforeNow * MIN));
  const ago = (ms: number) => new Date(now.getTime() - ms);

  const users = new Map<string, Person>();
  for (const u of await prisma.user.findMany({ where: { tenantId } })) users.set(u.email, { id: u.id, fullName: u.fullName });
  const U = (email: string) => users.get(email)!;
  const owner = U('demo@palmwine.ng');
  const tunde = U('tunde@palmwine.ng');
  const ngozi = U('ngozi@palmwine.ng');
  const musa = U('musa@palmwine.ng');
  const blessing = U('blessing@palmwine.ng');
  const grace = U('grace@palmwine.ng');
  const emeka = U('emeka@palmwine.ng');
  const funmi = U('funmi@palmwine.ng');

  const rooms = new Map((await prisma.room.findMany({ where: { tenantId } })).map((r) => [r.number, r]));
  const R = (n: string) => rooms.get(n)!;
  const types = new Map((await prisma.roomType.findMany({ where: { tenantId } })).map((t) => [t.name, t]));
  const standard = types.get('Standard Queen')!;
  const deluxe = types.get('Deluxe King')!;
  const suite = types.get('Palm Suite')!;

  // Rows this seed owns (the operations reset already cleared the reservation-linked ones).
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    for (const table of [
      'city_ledger_allocations', 'city_ledger_payments', 'city_ledger_charges', 'city_ledger_invoices',
      'promo_redemptions', 'guard_alerts', 'room_blocks', 'maintenance_ticket_events', 'maintenance_tickets',
      'maintenance_schedules', 'fuel_logs', 'lost_found_items', 'housekeeping_tasks', 'housekeeping_checklists',
      'rate_overrides', 'rate_restrictions', 'rate_rules', 'notification_settings',
    ]) {
      await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
    }
    await tx.$executeRawUnsafe(`UPDATE reservations SET promo_code_id = NULL, corporate_account_id = NULL WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM corporate_accounts WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(`DELETE FROM promo_codes WHERE tenant_id = $1::uuid`, tenantId);
    await tx.$executeRawUnsafe(
      `DELETE FROM document_counters WHERE tenant_id = $1::uuid AND kind IN ('MAINTENANCE_TICKET', 'CITY_LEDGER')`,
      tenantId,
    );
  });

  // ---------------------------------------------------------------------------
  // Settings: inspection on, stayovers on, deep clean every N stays
  // ---------------------------------------------------------------------------
  await prisma.property.update({ where: { id: property.id }, data: { requireInspection: true, stayoverEnabled: true } });
  await prisma.roomType.update({ where: { id: standard.id }, data: { deepCleanEveryStays: 10 } });
  await prisma.roomType.update({ where: { id: deluxe.id }, data: { deepCleanEveryStays: 8 } });
  await prisma.roomType.update({ where: { id: suite.id }, data: { deepCleanEveryStays: 5 } });
  for (const r of rooms.values()) {
    await prisma.room.update({ where: { id: r.id }, data: { staysSinceDeepClean: Math.floor(rand() * 6) } });
  }

  // ---------------------------------------------------------------------------
  // Housekeeping checklists
  // ---------------------------------------------------------------------------
  const suiteClean = [
    ...DEFAULT_CHECKLISTS.CHECKOUT_CLEAN,
    'Lounge sofa and cushions vacuumed',
    'Soaking tub scrubbed and dried',
    'Terrace swept, furniture wiped',
    'Nespresso pods and cups restocked',
  ];
  const deluxeClean = [...DEFAULT_CHECKLISTS.CHECKOUT_CLEAN, 'Balcony swept and door track cleaned', 'Minibar counted and restocked'];
  const checklistRows: Prisma.HousekeepingChecklistCreateManyInput[] = [
    { tenantId, roomTypeId: standard.id, taskType: 'CHECKOUT_CLEAN', items: checklistItems(DEFAULT_CHECKLISTS.CHECKOUT_CLEAN) },
    { tenantId, roomTypeId: deluxe.id, taskType: 'CHECKOUT_CLEAN', items: checklistItems(deluxeClean) },
    { tenantId, roomTypeId: suite.id, taskType: 'CHECKOUT_CLEAN', items: checklistItems(suiteClean) },
    { tenantId, roomTypeId: null, taskType: 'STAYOVER', items: checklistItems(DEFAULT_CHECKLISTS.STAYOVER) },
    { tenantId, roomTypeId: null, taskType: 'DEEP_CLEAN', items: checklistItems(DEFAULT_CHECKLISTS.DEEP_CLEAN) },
    { tenantId, roomTypeId: suite.id, taskType: 'TURNDOWN', items: checklistItems([...DEFAULT_CHECKLISTS.TURNDOWN, 'Chocolates and tomorrow\'s weather card on the pillow', 'Bathrobe and slippers laid out']) },
  ];
  await prisma.housekeepingChecklist.createMany({ data: checklistRows });
  const listFor = (typeId: string, taskType: string): string[] => {
    const own = checklistRows.find((c) => c.roomTypeId === typeId && c.taskType === taskType) ?? checklistRows.find((c) => c.roomTypeId === null && c.taskType === taskType);
    const items = own ? (own.items as { id: string; label: string }[]).map((i) => i.label) : DEFAULT_CHECKLISTS[taskType as keyof typeof DEFAULT_CHECKLISTS];
    return items;
  };
  const snapshot = (typeId: string, taskType: string, doneCount: number) =>
    checklistItems(listFor(typeId, taskType)).map((c, i) => ({ ...c, done: i < doneCount })) as unknown as Prisma.InputJsonValue;
  const allDone = (typeId: string, taskType: string) => snapshot(typeId, taskType, 99);

  // ---------------------------------------------------------------------------
  // Today's housekeeping board (every state) and two weeks of history
  // ---------------------------------------------------------------------------
  const todayStays = await prisma.reservation.findMany({
    where: { tenantId, roomId: { not: null }, OR: [{ status: 'CHECKED_IN' }, { status: 'CHECKED_OUT', checkedOutAt: { gte: lagosDateTime(T, '00:00') } }] },
  });
  const stayIn = (room: string, status: string) => todayStays.find((s) => s.roomId === R(room).id && s.status === status)?.id ?? null;

  // The arrival due in 206 today moves to 208, so 208's checkout clean is urgent.
  const arrival206 = await prisma.reservation.findFirst({
    where: { tenantId, roomId: R('206').id, status: { in: ['CONFIRMED', 'PENDING'] }, arrivalAt: { gte: lagosDateTime(T, '00:00'), lt: lagosDateTime(addDays(T, 1), '00:00') } },
  });
  if (arrival206) await prisma.reservation.update({ where: { id: arrival206.id }, data: { roomId: R('208').id } });
  await prisma.room.update({ where: { id: R('308').id }, data: { status: 'VACANT_DIRTY' } });
  await prisma.room.update({ where: { id: R('305').id }, data: { status: 'VACANT_DIRTY' } });

  type TaskInput = Prisma.HousekeepingTaskCreateManyInput;
  const tasks: TaskInput[] = [];
  const task = (t: Omit<TaskInput, 'tenantId' | 'businessDate'> & { businessDate?: string }) =>
    tasks.push({ ...t, tenantId, businessDate: dbDate(t.businessDate ?? T) });

  // Checkout cleans.
  const out208 = stayIn('208', 'CHECKED_OUT');
  task({
    roomId: R('208').id, reservationId: out208, type: 'CHECKOUT_CLEAN', reason: 'CHECKOUT', status: 'ASSIGNED', priority: 'URGENT',
    assigneeId: blessing.id, assigneeName: blessing.fullName, dueAt: todayAt('13:30', -180),
    checklist: snapshot(deluxe.id, 'CHECKOUT_CLEAN', 0), notes: 'Arrival due at 14:00; please do this room first.', createdAt: todayAt('09:40', 50),
  });
  task({
    roomId: R('104').id, reservationId: stayIn('104', 'CHECKED_OUT'), type: 'CHECKOUT_CLEAN', reason: 'CHECKOUT', status: 'ASSIGNED', priority: 'NORMAL',
    assigneeId: musa.id, assigneeName: musa.fullName, checklist: snapshot(standard.id, 'CHECKOUT_CLEAN', 0), createdAt: todayAt('10:05', 35),
  });
  task({
    roomId: R('202').id, reservationId: stayIn('202', 'CHECKED_OUT'), type: 'CHECKOUT_CLEAN', reason: 'CHECKOUT', status: 'DONE', priority: 'NORMAL',
    assigneeId: musa.id, assigneeName: musa.fullName, startedAt: todayAt('09:10', 60), completedAt: todayAt('09:52', 20),
    completedById: musa.id, completedByName: musa.fullName, checklist: allDone(standard.id, 'CHECKOUT_CLEAN'), notes: 'Ready for inspection.',
    createdAt: todayAt('08:45', 70),
  });
  task({
    roomId: R('305').id, reservationId: stayIn('305', 'CHECKED_OUT'), type: 'DEEP_CLEAN', reason: 'DEEP_CLEAN_RULE', status: 'IN_PROGRESS', priority: 'HIGH',
    assigneeId: blessing.id, assigneeName: blessing.fullName, startedAt: todayAt('10:15', 15), checklist: snapshot(deluxe.id, 'DEEP_CLEAN', 6),
    notes: 'Deep clean, guest stayed four nights; eighth stay since the last deep clean.', createdAt: todayAt('09:55', 25),
  });
  task({
    roomId: R('308').id, type: 'DEEP_CLEAN', reason: 'DEEP_CLEAN_RULE', status: 'REJECTED', priority: 'HIGH',
    assigneeId: musa.id, assigneeName: musa.fullName, startedAt: todayAt('07:30', 120), checklist: snapshot(suite.id, 'DEEP_CLEAN', 10),
    inspectedById: grace.id, inspectedByName: grace.fullName, inspectionNote: 'Soaking tub has a ring at the waterline and the terrace was not swept. Please redo both.',
    notes: 'Fifth stay since the last deep clean.', createdAt: todayAt('07:10', 130),
  });
  task({
    roomId: R('103').id, type: 'CHECKOUT_CLEAN', reason: 'CHECKOUT', status: 'INSPECTED', priority: 'NORMAL',
    assigneeId: blessing.id, assigneeName: blessing.fullName, startedAt: todayAt('07:05', 150), completedAt: todayAt('07:48', 110),
    completedById: blessing.id, completedByName: blessing.fullName, inspectedAt: todayAt('08:10', 100), inspectedById: grace.id, inspectedByName: grace.fullName,
    inspectionNote: 'Good job.', checklist: allDone(standard.id, 'CHECKOUT_CLEAN'), createdAt: todayAt('06:50', 160),
  });

  // Stayovers for rooms with guests in house.
  const stayovers: { room: string; status: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'DONE' | 'SKIPPED'; who?: Person; note?: string }[] = [
    { room: '101', status: 'DONE', who: musa },
    { room: '105', status: 'ASSIGNED', who: musa },
    { room: '201', status: 'SKIPPED', who: blessing, note: 'Do Not Disturb sign on the door at 10:30 and 12:00' },
    { room: '205', status: 'IN_PROGRESS', who: musa },
    { room: '301', status: 'OPEN' },
    { room: '304', status: 'ASSIGNED', who: blessing },
    { room: '306', status: 'DONE', who: blessing },
  ];
  for (const [i, s] of stayovers.entries()) {
    const typeId = R(s.room).roomTypeId;
    const start = todayAt(`0${8 + (i % 2)}:${String(10 + i * 6).padStart(2, '0')}`, 30 + i * 5);
    task({
      roomId: R(s.room).id,
      reservationId: stayIn(s.room, 'CHECKED_IN'),
      type: 'STAYOVER',
      reason: 'STAYOVER_JOB',
      status: s.status,
      priority: 'NORMAL',
      assigneeId: s.who?.id ?? null,
      assigneeName: s.who?.fullName ?? null,
      startedAt: s.status === 'IN_PROGRESS' || s.status === 'DONE' ? start : null,
      completedAt: s.status === 'DONE' || s.status === 'SKIPPED' ? new Date(start.getTime() + 22 * MIN) : null,
      completedById: s.status === 'DONE' || s.status === 'SKIPPED' ? s.who!.id : null,
      completedByName: s.status === 'DONE' || s.status === 'SKIPPED' ? s.who!.fullName : null,
      skippedReason: s.status === 'SKIPPED' ? s.note : null,
      checklist: s.status === 'DONE' ? allDone(typeId, 'STAYOVER') : snapshot(typeId, 'STAYOVER', s.status === 'IN_PROGRESS' ? 2 : 0),
      createdAt: todayAt('07:00', 180),
    });
  }
  task({
    roomId: R('306').id, reservationId: stayIn('306', 'CHECKED_IN'), type: 'TURNDOWN', reason: 'MANUAL', status: 'OPEN', priority: 'LOW',
    dueAt: at(T, '19:30'), checklist: snapshot(suite.id, 'TURNDOWN', 0), notes: 'VIP guest: evening turndown requested.', createdAt: todayAt('08:20', 90),
  });

  // Two weeks of inspected checkout cleans (housekeeper productivity and inspection reports).
  const pastOuts = await prisma.reservation.findMany({
    where: { tenantId, status: 'CHECKED_OUT', roomId: { not: null }, checkedOutAt: { gte: ago(14 * DAY), lt: lagosDateTime(T, '00:00') } },
    orderBy: { checkedOutAt: 'asc' },
  });
  let history = 0;
  for (const [i, r] of pastOuts.entries()) {
    const who = i % 2 === 0 ? musa : blessing;
    const room = [...rooms.values()].find((x) => x.id === r.roomId)!;
    const started = new Date(r.checkedOutAt!.getTime() + (25 + Math.floor(rand() * 60)) * MIN);
    const done = new Date(started.getTime() + (32 + Math.floor(rand() * 30)) * MIN);
    const failed = i % 11 === 5;
    task({
      businessDate: lagosDate(r.checkedOutAt!),
      roomId: room.id, reservationId: r.id, type: 'CHECKOUT_CLEAN', reason: 'CHECKOUT', status: 'INSPECTED', priority: 'NORMAL',
      assigneeId: who.id, assigneeName: who.fullName, startedAt: started, completedAt: done, completedById: who.id, completedByName: who.fullName,
      inspectedAt: new Date(done.getTime() + (failed ? 70 : 15) * MIN), inspectedById: grace.id, inspectedByName: grace.fullName,
      inspectionNote: failed ? 'Passed on the second check after the shower screen was redone.' : null,
      checklist: allDone(room.roomTypeId, 'CHECKOUT_CLEAN'), createdAt: r.checkedOutAt!,
    });
    history++;
  }
  await prisma.housekeepingTask.createMany({ data: tasks });

  // ---------------------------------------------------------------------------
  // Lost & found
  // ---------------------------------------------------------------------------
  const guestOf = async (roomNumber: string) =>
    prisma.reservation.findFirst({ where: { tenantId, roomId: R(roomNumber).id, status: 'CHECKED_OUT' }, orderBy: { checkedOutAt: 'desc' }, include: { guest: true } });
  const out305 = await guestOf('305');
  const out204 = await guestOf('204');
  const out301 = await guestOf('301');
  await prisma.lostFoundItem.createMany({
    data: [
      {
        tenantId, description: 'Black Ankara print jacket, size L', category: 'Clothing', roomId: R('305').id, location: 'Wardrobe',
        foundById: blessing.id, foundByName: blessing.fullName, foundAt: todayAt('10:25', 10), status: 'HELD', storageLocation: 'Housekeeping store, shelf B',
        guestId: out305?.guestId ?? null, reservationId: out305?.id ?? null, notes: 'Guest checked out this morning; front desk to call.',
      },
      {
        tenantId, description: 'Samsung phone charger with USB-C cable', category: 'Electronics', roomId: R('204').id, location: 'Bedside socket',
        foundById: musa.id, foundByName: musa.fullName, foundAt: ago(26 * HOUR), status: 'HELD', storageLocation: 'Front office cabinet, drawer 2',
        guestId: out204?.guestId ?? null, reservationId: out204?.id ?? null,
      },
      {
        tenantId, description: 'Brown leather wallet with a staff ID card (no cash)', category: 'Documents', roomId: null, location: 'Poolside lounger',
        foundById: blessing.id, foundByName: blessing.fullName, foundAt: ago(3 * DAY), status: 'HELD', storageLocation: 'Duty manager safe',
        notes: 'ID card belongs to a Lagos State Ministry of Health employee; left a message on the number on the card.',
      },
      {
        tenantId, description: 'Reading glasses in a blue case', category: 'Accessories', roomId: R('301').id, location: 'Desk drawer',
        foundById: musa.id, foundByName: musa.fullName, foundAt: ago(6 * DAY), status: 'RETURNED', storageLocation: 'Front office cabinet, drawer 2',
        guestId: out301?.guestId ?? null, reservationId: out301?.id ?? null, returnedTo: out301?.guest.fullName ?? 'Guest in person', returnedAt: ago(5 * DAY),
        notes: 'Collected in person; ID checked.',
      },
      {
        tenantId, description: 'Gold-plated wristwatch', category: 'Jewellery', roomId: R('207').id, location: 'Bathroom shelf',
        foundById: blessing.id, foundByName: blessing.fullName, foundAt: ago(12 * DAY), status: 'RETURNED', storageLocation: 'Duty manager safe',
        returnedTo: 'Sent by GIG Logistics to the guest in Abuja (waybill GIG-58213377)', returnedAt: ago(10 * DAY),
      },
      {
        tenantId, description: 'Half-used toiletries and a travel umbrella', category: 'Other', roomId: R('102').id, location: 'Bathroom',
        foundById: musa.id, foundByName: musa.fullName, foundAt: ago(75 * DAY), status: 'DISPOSED', storageLocation: 'Housekeeping store, shelf C',
        disposedAt: ago(15 * DAY), notes: 'Unclaimed after 60 days; umbrella given to the staff room.',
      },
    ],
  });

  // ---------------------------------------------------------------------------
  // Maintenance: schedules, tickets (106 blocked for two days), diesel
  // ---------------------------------------------------------------------------
  const allRoomIds = [...rooms.values()].map((r) => r.id);
  await prisma.maintenanceSchedule.create({
    data: {
      tenantId, title: 'AC servicing (all guest rooms)', category: 'AC_HVAC', priority: 'NORMAL', roomIds: allRoomIds, area: null, everyDays: 90,
      nextDueAt: at(addDays(T, 12), '06:00'), lastRunAt: at(addDays(T, -78), '06:00'),
      checklist: ['Clean filters', 'Check gas pressure', 'Clear the drain line', 'Check remote and thermostat'],
    },
  });
  const schedGen = await prisma.maintenanceSchedule.create({
    data: {
      tenantId, title: 'Generator servicing', category: 'GENERATOR', priority: 'HIGH', area: 'Generator house', everyDays: 10,
      nextDueAt: at(addDays(T, 1), '06:00'), lastRunAt: at(addDays(T, -9), '06:00'),
      checklist: ['Change engine oil and oil filter', 'Check coolant level', 'Clean air filter', 'Check battery terminals', 'Test automatic changeover'],
    },
  });
  const schedPool = await prisma.maintenanceSchedule.create({
    data: {
      tenantId, title: 'Pool pump and filter service', category: 'OTHER', priority: 'NORMAL', area: 'Swimming pool plant room', everyDays: 30,
      nextDueAt: at(addDays(T, 10), '06:00'), lastRunAt: at(addDays(T, -20), '06:00'),
      checklist: ['Backwash the sand filter', 'Clean the pump strainer basket', 'Check chlorine dosing', 'Inspect seals for leaks'],
    },
  });

  interface TicketSeed {
    room?: string;
    area?: string;
    category: Prisma.MaintenanceTicketCreateInput['category'];
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    status: 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'ON_HOLD' | 'RESOLVED' | 'CLOSED';
    title: string;
    description: string;
    reportedBy: Person;
    assignee?: Person;
    vendor?: { name: string; phone: string };
    createdAgo: number;
    blocksRoom?: boolean;
    costNaira?: number;
    resolution?: string;
    resolvedAgo?: number;
    schedule?: string;
    comments?: { by: Person; note: string; agoMs: number }[];
  }
  const ticketSeeds: TicketSeed[] = [
    {
      category: 'GENERATOR', priority: 'NORMAL', status: 'CLOSED', area: 'Generator house', title: 'Generator servicing',
      description: 'Scheduled generator servicing.', reportedBy: emeka, assignee: emeka, createdAgo: 9 * DAY, costNaira: 68_500,
      resolution: 'Oil and filters changed, coolant topped up, changeover tested.', resolvedAgo: 9 * DAY - 5 * HOUR, schedule: schedGen.id,
    },
    {
      category: 'OTHER', priority: 'NORMAL', status: 'RESOLVED', area: 'Swimming pool plant room', title: 'Pool pump and filter service',
      description: 'Scheduled pool pump and filter service.', reportedBy: emeka, assignee: emeka, createdAgo: 20 * DAY, costNaira: 22_000,
      resolution: 'Filter backwashed, strainer cleaned, pump seal replaced.', resolvedAgo: 20 * DAY - 6 * HOUR, schedule: schedPool.id,
    },
    {
      room: '307', category: 'FURNITURE', priority: 'LOW', status: 'CLOSED', title: 'Wardrobe door hinge loose',
      description: 'Left wardrobe door drops when opened.', reportedBy: musa, assignee: emeka, createdAgo: 8 * DAY, costNaira: 4_500,
      resolution: 'Hinge replaced and door realigned.', resolvedAgo: 6 * DAY,
    },
    {
      room: '301', category: 'APPLIANCE', priority: 'LOW', status: 'RESOLVED', title: 'TV remote not working',
      description: 'Guest reports the remote does nothing; batteries already changed.', reportedBy: ngozi, assignee: emeka, createdAgo: 2 * DAY, costNaira: 3_500,
      resolution: 'Replaced with a new universal remote.', resolvedAgo: 36 * HOUR,
    },
    {
      room: '106', category: 'AC_HVAC', priority: 'NORMAL', status: 'ON_HOLD', title: 'AC compressor not cooling',
      description: 'Split unit runs but blows warm air. Compressor seized; replacement ordered.', reportedBy: musa, assignee: emeka,
      vendor: { name: 'Coolbreeze Refrigeration Services', phone: '+2348023456781' }, createdAgo: 30 * HOUR, blocksRoom: true,
      comments: [
        { by: emeka, note: 'Compressor seized. Coolbreeze will supply and fit a new one; room blocked for two days.', agoMs: 28 * HOUR },
        { by: tunde, note: 'Approved the vendor quote of 185,000 naira.', agoMs: 20 * HOUR },
      ],
    },
    {
      category: 'GENERATOR', priority: 'URGENT', status: 'ASSIGNED', area: 'Generator house', title: 'Generator 2 overheating and shutting down under load',
      description: 'Gen 2 (60 kVA) tripped twice last night around 01:00 when the pool pump and kitchen came on together. Temperature warning light on.',
      reportedBy: tunde, assignee: emeka, vendor: { name: 'Powerline Generators Ltd', phone: '+2348091112233' }, createdAgo: 7 * HOUR,
      comments: [{ by: emeka, note: 'Radiator looks blocked. Waiting for the Powerline technician; running on Gen 1 meanwhile.', agoMs: 5 * HOUR }],
    },
    {
      area: 'Second floor corridor', category: 'IT', priority: 'HIGH', status: 'IN_PROGRESS', title: 'Wi-Fi access point offline on the second floor',
      description: 'Guests in 201-208 report weak or no Wi-Fi since this morning.', reportedBy: ngozi, assignee: emeka, createdAgo: 5 * HOUR,
    },
    {
      room: '204', category: 'PLUMBING', priority: 'NORMAL', status: 'OPEN', title: 'Bathroom tap dripping',
      description: 'Basin tap drips constantly; found during the room clean.', reportedBy: musa, createdAgo: 3 * HOUR,
    },
    {
      area: 'Third floor corridor', category: 'ELECTRICAL', priority: 'NORMAL', status: 'OPEN', title: 'Corridor light fitting flickering',
      description: 'Light outside 305 flickers and buzzes.', reportedBy: blessing, createdAgo: 90 * MIN,
    },
  ];
  ticketSeeds.sort((a, b) => b.createdAgo - a.createdAgo);
  let ticketSeq = 0;
  let block106 = false;
  for (const s of ticketSeeds) {
    ticketSeq++;
    const createdAt = ago(s.createdAgo);
    const resolvedAt = s.resolvedAgo !== undefined ? ago(s.resolvedAgo) : null;
    const room = s.room ? R(s.room) : null;
    const t = await prisma.maintenanceTicket.create({
      data: {
        tenantId,
        number: ticketNumber(ticketSeq),
        roomId: room?.id ?? null,
        area: s.area ?? null,
        category: s.category,
        priority: s.priority,
        status: s.status,
        title: s.title,
        description: s.description,
        reportedById: s.reportedBy.id,
        reportedByName: s.reportedBy.fullName,
        assigneeId: s.assignee?.id ?? null,
        assigneeName: s.assignee?.fullName ?? null,
        vendorName: s.vendor?.name ?? null,
        vendorPhone: s.vendor?.phone ?? null,
        blocksRoom: s.blocksRoom ?? false,
        costKobo: s.costNaira !== undefined ? BigInt(s.costNaira * NAIRA) : null,
        resolutionNote: s.resolution ?? null,
        slaDueAt: slaDueAt(createdAt, s.priority),
        scheduleId: s.schedule ?? null,
        startedAt: ['IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED'].includes(s.status) ? new Date(createdAt.getTime() + 40 * MIN) : null,
        resolvedAt,
        closedAt: s.status === 'CLOSED' ? resolvedAt : null,
        createdAt,
      },
    });
    const events: Prisma.MaintenanceTicketEventCreateManyInput[] = [
      { tenantId, ticketId: t.id, kind: 'CREATED', toValue: 'OPEN', byId: s.reportedBy.id, byName: s.reportedBy.fullName, createdAt },
    ];
    if (s.assignee) {
      events.push({ tenantId, ticketId: t.id, kind: 'ASSIGNED', toValue: s.assignee.fullName, byId: tunde.id, byName: tunde.fullName, createdAt: new Date(createdAt.getTime() + 15 * MIN) });
    }
    if (s.status !== 'OPEN' && s.status !== 'ASSIGNED') {
      events.push({ tenantId, ticketId: t.id, kind: 'STATUS', fromValue: 'ASSIGNED', toValue: 'IN_PROGRESS', byId: s.assignee!.id, byName: s.assignee!.fullName, createdAt: new Date(createdAt.getTime() + 40 * MIN) });
    }
    for (const c of s.comments ?? []) {
      events.push({ tenantId, ticketId: t.id, kind: 'COMMENT', note: c.note, byId: c.by.id, byName: c.by.fullName, createdAt: ago(c.agoMs) });
    }
    if (s.status === 'ON_HOLD') {
      events.push({ tenantId, ticketId: t.id, kind: 'STATUS', fromValue: 'IN_PROGRESS', toValue: 'ON_HOLD', note: 'Waiting for the replacement compressor', byId: emeka.id, byName: emeka.fullName, createdAt: ago(27 * HOUR) });
    }
    if (resolvedAt) {
      events.push({ tenantId, ticketId: t.id, kind: 'STATUS', fromValue: 'IN_PROGRESS', toValue: 'RESOLVED', note: s.resolution ?? null, byId: s.assignee!.id, byName: s.assignee!.fullName, createdAt: resolvedAt });
      if (s.status === 'CLOSED') {
        events.push({ tenantId, ticketId: t.id, kind: 'STATUS', fromValue: 'RESOLVED', toValue: 'CLOSED', byId: tunde.id, byName: tunde.fullName, createdAt: new Date(resolvedAt.getTime() + 2 * HOUR) });
      }
    }
    await prisma.maintenanceTicketEvent.createMany({ data: events });
    if (s.blocksRoom && room) {
      const startsAt = todayAt('08:00', 60);
      await prisma.roomBlock.create({
        data: {
          tenantId, roomId: room.id, roomTypeId: room.roomTypeId, startsAt, endsAt: new Date(startsAt.getTime() + 2 * DAY),
          reason: `${ticketNumber(ticketSeq)}: ${s.title}`, ticketId: t.id, createdById: emeka.id, createdByName: emeka.fullName, createdAt: ago(28 * HOUR),
        },
      });
      await prisma.room.update({ where: { id: room.id }, data: { status: 'OUT_OF_ORDER', notes: 'AC compressor replacement: blocked for two days' } });
      block106 = true;
    }
  }
  await prisma.documentCounter.create({ data: { tenantId, kind: 'MAINTENANCE_TICKET', year: 0, lastValue: ticketSeq } });

  // 30 days of diesel: deliveries every few days, daily run hours.
  const fuelRows: Prisma.FuelLogCreateManyInput[] = [];
  for (let d = 30; d >= 1; d--) {
    const date = addDays(T, -d);
    const gen = rand() < 0.75 ? 'Gen 1 (100 kVA)' : 'Gen 2 (60 kVA)';
    const runHours = Math.round((9 + rand() * 9) * 10) / 10;
    const litres = Math.round(runHours * (gen.startsWith('Gen 1') ? 11.5 : 7.2) * 10) / 10;
    const pricePerLitre = 1_180 + Math.floor(rand() * 90);
    fuelRows.push({
      tenantId,
      date: dbDate(date),
      litres,
      costKobo: BigInt(Math.round(litres * pricePerLitre) * NAIRA),
      supplier: d % 3 === 0 ? 'Ardova depot, Lekki' : 'Mainland Diesel Supplies',
      runHours,
      generator: gen,
      notes: runHours > 16 ? 'Grid supply off most of the day' : '',
      loggedById: emeka.id,
      loggedByName: emeka.fullName,
      createdAt: at(date, '21:30'),
    });
  }
  await prisma.fuelLog.createMany({ data: fuelRows });

  // ---------------------------------------------------------------------------
  // Rate plans, seasons, overrides, restrictions
  // ---------------------------------------------------------------------------
  const plan = async (code: string, data: Omit<Prisma.RatePlanUncheckedCreateInput, 'tenantId' | 'propertyId' | 'code'>) =>
    prisma.ratePlan.upsert({
      where: { tenantId_code: { tenantId, code } },
      create: { tenantId, propertyId: property.id, code, ...data },
      update: data,
    });
  await plan('BAR', {
    name: 'Best Available Rate', description: 'Flexible rate at the day\'s best price. Free cancellation under the hotel policy.',
    kind: 'BAR', isBar: true, pricing: 'DERIVED', channels: ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'], sortOrder: 0, active: true,
  });
  await plan('NRF', {
    name: 'Non-refundable', description: 'Save 10%. Paid in full online; no refund if you cancel or do not arrive.',
    kind: 'NON_REFUNDABLE', isBar: false, pricing: 'DERIVED', adjustmentType: 'PERCENT', adjustmentValue: -1_000,
    cancelPolicy: { nonRefundable: true, freeCancellationHours: 0, lateCancellationFeePct: 100 },
    channels: ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'], sortOrder: 1, active: true,
  });
  const corp = await plan('CORP', {
    name: 'Corporate', description: 'Negotiated rate for companies with a corporate account. Breakfast for one included.',
    kind: 'CORPORATE', isBar: false, pricing: 'FIXED',
    fixedPrices: [
      { roomTypeId: standard.id, rateKobo: 48_000 * NAIRA },
      { roomTypeId: deluxe.id, rateKobo: 72_000 * NAIRA },
      { roomTypeId: suite.id, rateKobo: 140_000 * NAIRA },
    ],
    includesBreakfast: true, channels: ['FRONT_DESK'], sortOrder: 2, active: true,
  });
  await plan('LONG7', {
    name: 'Long stay (7+ nights)', description: '15% off stays of a week or longer.',
    kind: 'LONG_STAY', isBar: false, pricing: 'DERIVED', adjustmentType: 'PERCENT', adjustmentValue: -1_500, minNights: 7,
    channels: ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'], sortOrder: 3, active: true,
  });

  const year = Number(T.slice(0, 4));
  const decStart = T <= `${year}-01-05` ? year - 1 : year;
  const easterYear = easterSunday(year) >= T ? year : year + 1;
  const easter = easterSunday(easterYear);
  await prisma.rateRule.createMany({
    data: [
      {
        tenantId, propertyId: property.id, name: 'Weekend +10%', dateFrom: dbDate(`${year}-01-01`), dateTo: dbDate(`${year + 1}-12-31`),
        daysOfWeek: [5, 6], adjustmentType: 'PERCENT', adjustmentValue: 1_000, priority: 10, color: 'brass',
      },
      {
        tenantId, propertyId: property.id, name: 'Detty December +35%', dateFrom: dbDate(`${decStart}-12-15`), dateTo: dbDate(`${decStart + 1}-01-05`),
        adjustmentType: 'PERCENT', adjustmentValue: 3_500, priority: 50, color: 'laterite',
      },
      {
        tenantId, propertyId: property.id, name: 'Easter +20%', dateFrom: dbDate(addDays(easter, -3)), dateTo: dbDate(addDays(easter, 1)),
        adjustmentType: 'PERCENT', adjustmentValue: 2_000, priority: 40, color: 'palm',
      },
    ],
  });
  const oct1 = nextOn(T, '10-01');
  const nye = nextOn(T, '12-31');
  const xmasEve = nextOn(T, '12-24');
  await prisma.rateOverride.createMany({
    data: [
      { tenantId, roomTypeId: suite.id, date: dbDate(nye), rateKobo: 250_000 * NAIRA, note: 'New Year\'s Eve rooftop party package', updatedById: owner.id, updatedByName: owner.fullName },
      { tenantId, roomTypeId: deluxe.id, date: dbDate(nye), rateKobo: 135_000 * NAIRA, note: 'New Year\'s Eve', updatedById: owner.id, updatedByName: owner.fullName },
      { tenantId, roomTypeId: standard.id, date: dbDate(oct1), rateKobo: 65_000 * NAIRA, note: 'Independence Day weekend demand', updatedById: tunde.id, updatedByName: tunde.fullName },
      { tenantId, roomTypeId: deluxe.id, date: dbDate(oct1), rateKobo: 98_000 * NAIRA, note: 'Independence Day weekend demand', updatedById: tunde.id, updatedByName: tunde.fullName },
    ],
  });
  await prisma.rateRestriction.createMany({
    data: [
      { tenantId, roomTypeId: null, date: dbDate(addDays(nye, -1)), minNights: 3 },
      { tenantId, roomTypeId: null, date: dbDate(nye), minNights: 3 },
      { tenantId, roomTypeId: null, date: dbDate(xmasEve), closedToArrival: true },
    ],
  });

  // ---------------------------------------------------------------------------
  // Promo codes
  // ---------------------------------------------------------------------------
  const welcome = await prisma.promoCode.create({
    data: {
      tenantId, code: 'WELCOME10', description: '10% off your first stay with us', type: 'PERCENT', value: 1_000,
      validFrom: dbDate(addDays(T, -45)), validTo: dbDate(addDays(T, 120)), firstBookingOnly: false, perGuestLimit: 1,
      channels: ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'],
    },
  });
  await prisma.promoCode.create({
    data: {
      tenantId, code: 'LAGOSLONG', description: 'Stay 4 nights, the cheapest night is on us', type: 'FREE_NIGHT', value: 4,
      validFrom: dbDate(addDays(T, -10)), validTo: dbDate(addDays(T, 90)), minNights: 4, channels: ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'],
    },
  });
  const naija = await prisma.promoCode.create({
    data: {
      tenantId, code: 'NAIJA20', description: 'Independence month: 20% off, first 3 bookings only', type: 'PERCENT', value: 2_000,
      validFrom: dbDate(addDays(T, -20)), validTo: dbDate(addDays(T, 30)), maxUses: 3, channels: ['FRONT_DESK', 'BOOKING_SITE', 'MARKETPLACE'],
    },
  });
  const lastEaster = easterSunday(easterYear === year ? year - 1 : year);
  await prisma.promoCode.create({
    data: {
      tenantId, code: 'EASTER15', description: 'Easter getaway: 15% off', type: 'PERCENT', value: 1_500,
      validFrom: dbDate(addDays(lastEaster, -30)), validTo: dbDate(addDays(lastEaster, 1)),
      stayFrom: dbDate(addDays(lastEaster, -3)), stayTo: dbDate(addDays(lastEaster, 1)), channels: ['BOOKING_SITE', 'MARKETPLACE'],
    },
  });

  // Redemptions on upcoming confirmed stays (no nights posted yet, so the discount rides on the snapshot).
  const tax = await prisma.taxSetting.findFirst({ where: { tenantId } });
  const comps = tax ? componentsFrom(tax) : [];
  const upcoming = await prisma.reservation.findMany({
    where: { tenantId, status: 'CONFIRMED', stayType: 'NIGHTLY', arrivalAt: { gte: lagosDateTime(addDays(T, 2), '00:00') }, promoCodeId: null },
    include: { guest: true },
    orderBy: { arrivalAt: 'asc' },
    take: 5,
  });
  let redemptions = 0;
  for (const [i, r] of upcoming.entries()) {
    const promo = i < 3 ? naija : welcome;
    const nights = (r.nightlyRates as unknown as NightSnap[]) ?? [];
    if (!nights.length) continue;
    const disc = promoDiscounts({ type: 'PERCENT', value: promo.value }, nights, comps);
    const snap = nights.map((n, j) => ({ ...n, discountKobo: disc[j] }));
    const total = disc.reduce((a, b) => a + b, 0);
    await prisma.reservation.update({ where: { id: r.id }, data: { promoCodeId: promo.id, nightlyRates: snap as unknown as Prisma.InputJsonValue } });
    await prisma.promoRedemption.create({
      data: {
        tenantId, promoCodeId: promo.id, reservationId: r.id, guestPhone: r.guest.phone, channel: 'FRONT_DESK',
        status: 'CONFIRMED', discountKobo: BigInt(total), nights: nights.length, confirmedAt: r.createdAt, createdAt: r.createdAt,
      },
    });
    await prisma.promoCode.update({ where: { id: promo.id }, data: { uses: { increment: 1 } } });
    redemptions++;
  }

  // ---------------------------------------------------------------------------
  // Corporate accounts and the city ledger
  // ---------------------------------------------------------------------------
  const deltaline = await prisma.corporateAccount.create({
    data: {
      tenantId, name: 'Deltaline Oilfield Services Ltd', contactName: 'Ibrahim Danladi (Travel Coordinator)', email: 'travel@deltaline-oilfield.ng',
      phone: '+2348034455667', address: 'Plot 12, Trans-Amadi Industrial Layout, Port Harcourt, Rivers', taxId: '10458832-0001', ratePlanId: corp.id,
      creditLimitKobo: BigInt(5_000_000 * NAIRA), paymentTermsDays: 30, billingCycle: 'MONTHLY',
      notes: 'Rotating field engineers on Lagos stopovers. Monthly statement to accounts payable.',
    },
  });
  const crestmark = await prisma.corporateAccount.create({
    data: {
      tenantId, name: 'Crestmark Bank Plc', contactName: 'Yetunde Balogun (Admin Services)', email: 'adminservices@crestmarkbank.ng',
      phone: '+2348127788990', address: '22 Adeola Odeku Street, Victoria Island, Lagos', taxId: '02197741-0001', ratePlanId: corp.id,
      creditLimitKobo: BigInt(8_000_000 * NAIRA), paymentTermsDays: 45, billingCycle: 'MONTHLY',
      notes: 'Training-week bookings for branch staff. Purchase order number must appear on every statement.',
    },
  });
  const hope = await prisma.corporateAccount.create({
    data: {
      tenantId, name: 'Hope Bridge Foundation', contactName: 'Amina Yusuf (Programmes Officer)', email: 'programmes@hopebridge.org.ng',
      phone: '+2347038899001', address: '5 Oduduwa Crescent, GRA Ikeja, Lagos', taxId: '', ratePlanId: null,
      creditLimitKobo: BigInt(1_500_000 * NAIRA), paymentTermsDays: 14, billingCycle: 'PER_STAY',
      notes: 'NGO: invoice each stay separately; payment by transfer from the grant account.',
    },
  });

  const guestNames = [
    'Engr. Chinedu Okeke', 'Mr. Tamunotonye Briggs', 'Engr. Ifeanyi Nwosu', 'Mr. Olumide Adebayo', 'Mrs. Kemi Ogunbiyi', 'Mr. Babatunde Lawal',
    'Ms. Chiamaka Eze', 'Dr. Halima Bello', 'Mr. Segun Oladipo', 'Ms. Ebere Onyekachi', 'Mr. Yakubu Garba', 'Mrs. Funke Akindele-Bello',
  ];
  interface InvoiceSeed {
    account: typeof deltaline;
    issuedDaysAgo: number;
    kind: 'PER_STAY' | 'STATEMENT';
    stays: { nights: number; type: typeof standard; guest: string }[];
    paidPct: number;
    note?: string;
  }
  const invoiceSeeds: InvoiceSeed[] = [
    // Deltaline: close to its limit, with a 90+ day invoice.
    { account: deltaline, issuedDaysAgo: 118, kind: 'STATEMENT', stays: [{ nights: 5, type: deluxe, guest: guestNames[0] }, { nights: 4, type: standard, guest: guestNames[1] }], paidPct: 0.4 },
    { account: deltaline, issuedDaysAgo: 84, kind: 'STATEMENT', stays: [{ nights: 6, type: deluxe, guest: guestNames[2] }, { nights: 5, type: deluxe, guest: guestNames[0] }], paidPct: 0 },
    { account: deltaline, issuedDaysAgo: 53, kind: 'STATEMENT', stays: [{ nights: 7, type: deluxe, guest: guestNames[1] }, { nights: 6, type: standard, guest: guestNames[2] }, { nights: 4, type: suite, guest: guestNames[3] }], paidPct: 0 },
    { account: deltaline, issuedDaysAgo: 22, kind: 'STATEMENT', stays: [{ nights: 8, type: deluxe, guest: guestNames[0] }, { nights: 6, type: deluxe, guest: guestNames[2] }, { nights: 5, type: standard, guest: guestNames[1] }], paidPct: 0 },
    // Crestmark: pays, mostly on time.
    { account: crestmark, issuedDaysAgo: 115, kind: 'STATEMENT', stays: [{ nights: 5, type: standard, guest: guestNames[4] }, { nights: 5, type: standard, guest: guestNames[5] }], paidPct: 1 },
    { account: crestmark, issuedDaysAgo: 68, kind: 'STATEMENT', stays: [{ nights: 4, type: deluxe, guest: guestNames[6] }, { nights: 4, type: standard, guest: guestNames[7] }], paidPct: 0.5 },
    { account: crestmark, issuedDaysAgo: 24, kind: 'STATEMENT', stays: [{ nights: 5, type: standard, guest: guestNames[5] }, { nights: 3, type: suite, guest: guestNames[8] }], paidPct: 0 },
    // Hope Bridge: per stay.
    { account: hope, issuedDaysAgo: 96, kind: 'PER_STAY', stays: [{ nights: 3, type: standard, guest: guestNames[9] }], paidPct: 1 },
    { account: hope, issuedDaysAgo: 41, kind: 'PER_STAY', stays: [{ nights: 4, type: standard, guest: guestNames[10] }], paidPct: 0.5 },
    { account: hope, issuedDaysAgo: 9, kind: 'PER_STAY', stays: [{ nights: 2, type: deluxe, guest: guestNames[11] }], paidPct: 0 },
  ];
  const withTax = (net: number) => computeCharge(net, comps).grossKobo;
  const corpRate = (typeId: string) => ({ [standard.id]: 48_000, [deluxe.id]: 72_000, [suite.id]: 140_000 })[typeId] * NAIRA;
  const clSeq = new Map<number, number>();
  const accountPayments: { account: typeof deltaline; invoiceId: string; amount: number; at: Date; number: string }[] = [];
  let invoiceCount = 0;
  for (const s of invoiceSeeds.sort((a, b) => b.issuedDaysAgo - a.issuedDaysAgo)) {
    const issueDate = addDays(T, -s.issuedDaysAgo);
    const y = Number(issueDate.slice(0, 4));
    const seq = (clSeq.get(y) ?? 0) + 1;
    clSeq.set(y, seq);
    const number = `CL-${y}-${String(seq).padStart(6, '0')}`;
    const charges: Prisma.CityLedgerChargeCreateManyInput[] = [];
    let cursor = addDays(issueDate, -(s.kind === 'STATEMENT' ? 28 : s.stays[0].nights + 1));
    for (const st of s.stays) {
      const amount = withTax(corpRate(st.type.id) * st.nights);
      const arrive = cursor;
      const depart = addDays(arrive, st.nights);
      charges.push({
        tenantId, accountId: s.account.id, date: dbDate(depart), amountKobo: BigInt(amount), guestName: st.guest,
        description: `Accommodation: ${st.guest}, ${st.type.name}, ${st.nights} night${st.nights === 1 ? '' : 's'} (${arrive} to ${depart})`,
        createdById: ngozi.id, createdAt: at(depart, '11:40'),
      });
      cursor = addDays(arrive, 2 + Math.floor(rand() * 3));
    }
    const total = charges.reduce((a, c) => a + Number(c.amountKobo), 0);
    const periodFrom = s.kind === 'STATEMENT' ? addDays(issueDate, -30) : null;
    const inv = await prisma.cityLedgerInvoice.create({
      data: {
        tenantId, accountId: s.account.id, number, year: y, seq, kind: s.kind,
        periodFrom: periodFrom ? dbDate(periodFrom) : null, periodTo: s.kind === 'STATEMENT' ? dbDate(addDays(issueDate, -1)) : null,
        issueDate: dbDate(issueDate), dueDate: dbDate(addDays(issueDate, s.account.paymentTermsDays)), totalKobo: BigInt(total),
        issuedById: funmi.id, issuedByName: funmi.fullName, createdAt: at(issueDate, '09:00'),
        remindersSent: diffDays(addDays(issueDate, s.account.paymentTermsDays), T) > 15 && s.paidPct < 1 ? 2 : 0,
        lastReminderAt: diffDays(addDays(issueDate, s.account.paymentTermsDays), T) > 15 && s.paidPct < 1 ? at(addDays(issueDate, s.account.paymentTermsDays + 15), '09:00') : null,
      },
    });
    await prisma.cityLedgerCharge.createMany({ data: charges.map((c) => ({ ...c, invoiceId: inv.id })) });
    if (s.paidPct > 0) {
      const amount = s.paidPct >= 1 ? total : Math.round((total * s.paidPct) / 100) * 100;
      accountPayments.push({ account: s.account, invoiceId: inv.id, amount, at: at(addDays(issueDate, Math.min(s.account.paymentTermsDays, 20)), '12:15'), number });
    }
    invoiceCount++;
  }
  for (const [y, seq] of clSeq) await prisma.documentCounter.create({ data: { tenantId, kind: 'CITY_LEDGER', year: y, lastValue: seq } });
  for (const p of accountPayments) {
    const pay = await prisma.cityLedgerPayment.create({
      data: {
        tenantId, accountId: p.account.id, amountKobo: BigInt(p.amount), method: p.account.id === hope.id ? 'TRANSFER' : rand() < 0.5 ? 'TRANSFER' : 'CHEQUE',
        reference: `${p.account.id === hope.id ? 'HBF' : p.account.id === crestmark.id ? 'CMB' : 'DOS'}/${p.number.slice(-4)}/PAY`,
        receivedAt: p.at, note: `Payment against ${p.number}`, recordedById: funmi.id, recordedByName: funmi.fullName, createdAt: p.at,
      },
    });
    await prisma.cityLedgerAllocation.create({ data: { tenantId, paymentId: pay.id, invoiceId: p.invoiceId, amountKobo: BigInt(p.amount), createdAt: p.at } });
    const inv = await prisma.cityLedgerInvoice.findUniqueOrThrow({ where: { id: p.invoiceId } });
    const paid = Number(inv.paidKobo) + p.amount;
    await prisma.cityLedgerInvoice.update({
      where: { id: inv.id },
      data: { paidKobo: BigInt(paid), status: paid >= Number(inv.totalKobo) ? 'PAID' : 'PARTIALLY_PAID' },
    });
  }
  // This month's Deltaline stays, not yet on a statement (keeps the account near its limit).
  await prisma.cityLedgerCharge.createMany({
    data: [
      {
        tenantId, accountId: deltaline.id, date: dbDate(addDays(T, -6)), amountKobo: BigInt(withTax(corpRate(deluxe.id) * 4)), guestName: guestNames[2],
        description: `Accommodation: ${guestNames[2]}, Deluxe King, 4 nights (${addDays(T, -10)} to ${addDays(T, -6)})`, createdById: ngozi.id, createdAt: at(addDays(T, -6), '11:20'),
      },
      {
        tenantId, accountId: deltaline.id, date: dbDate(addDays(T, -2)), amountKobo: BigInt(withTax(corpRate(standard.id) * 3)), guestName: guestNames[1],
        description: `Accommodation: ${guestNames[1]}, Standard Queen, 3 nights (${addDays(T, -5)} to ${addDays(T, -2)})`, createdById: chidinmaOr(users, ngozi).id, createdAt: at(addDays(T, -2), '10:55'),
      },
    ],
  });
  // Two in-house guests billed to company accounts (check-out to the city ledger demo).
  const inHouse = await prisma.reservation.findMany({ where: { tenantId, status: 'CHECKED_IN', stayType: 'NIGHTLY' }, orderBy: { departureAt: 'desc' }, take: 2 });
  if (inHouse[0]) await prisma.reservation.update({ where: { id: inHouse[0].id }, data: { corporateAccountId: crestmark.id } });
  if (inHouse[1]) await prisma.reservation.update({ where: { id: inHouse[1].id }, data: { corporateAccountId: deltaline.id } });

  // ---------------------------------------------------------------------------
  // Owner WhatsApp alerts: settings and an alert log
  // ---------------------------------------------------------------------------
  await prisma.notificationSetting.create({
    data: {
      tenantId, propertyId: property.id,
      guardAlerts: {
        enabled: true, recipients: { owners: true, managers: true, userIds: [] }, channels: ['WHATSAPP'], debounceMinutes: 3,
        urgentRules: ['OCCUPIED_WITHOUT_STAY', 'PAYMENT_ORPHANED'], urgentAmountKobo: 100_000 * NAIRA,
      },
      quietHours: { enabled: true, start: '23:30', end: '06:00' },
    },
  });
  await prisma.digestSetting.updateMany({ where: { tenantId }, data: { recipients: ['+2348031234567'] } });
  const high = await prisma.guardFlag.findMany({ where: { tenantId, severity: 'HIGH' }, orderBy: { createdAt: 'asc' } });
  const recipients = ['+2348031234567', '+2348055550102'];
  const recipientUserIds = [owner.id, tunde.id];
  const alerts: Prisma.GuardAlertCreateManyInput[] = [];
  const flagAt = (i: number) => high[i]?.createdAt ?? ago((3 - i) * DAY);
  if (high[0]) {
    alerts.push({
      tenantId, status: 'ACKNOWLEDGED', urgent: false, flagIds: [high[0].id], recipients, recipientUserIds,
      scheduledFor: new Date(flagAt(0).getTime() + 3 * MIN), sentAt: new Date(flagAt(0).getTime() + 3 * MIN),
      acknowledgedAt: new Date(flagAt(0).getTime() + 19 * MIN), acknowledgedById: owner.id, acknowledgedByName: owner.fullName, createdAt: flagAt(0),
    });
  }
  if (high[1]) {
    // Raised at night: held until quiet hours ended at 06:00.
    const raised = at(lagosDate(flagAt(1)), '00:40');
    const morning = at(lagosDate(flagAt(1)), '06:00');
    alerts.push({
      tenantId, status: 'SENT', urgent: false, flagIds: [high[1].id], recipients, recipientUserIds, scheduledFor: morning, sentAt: morning,
      deferredReason: 'QUIET_HOURS', createdAt: raised,
    });
  }
  const tail = high.slice(2);
  if (tail.length) {
    const first = tail[0].createdAt;
    alerts.push({
      tenantId, status: 'SENT', urgent: tail.some((f) => f.rule === 'OCCUPIED_WITHOUT_STAY' || f.rule === 'PAYMENT_ORPHANED'), flagIds: tail.map((f) => f.id), recipients, recipientUserIds,
      scheduledFor: new Date(first.getTime() + 3 * MIN), sentAt: new Date(first.getTime() + 3 * MIN), createdAt: first,
    });
  }
  alerts.push({
    tenantId, status: 'SENT', urgent: false, flagIds: [], recipients: [recipients[0]], recipientUserIds: [owner.id], test: true,
    scheduledFor: ago(4 * DAY), sentAt: ago(4 * DAY), createdAt: ago(4 * DAY),
  });
  await prisma.guardAlert.createMany({ data: alerts });

  return {
    housekeepingToday: tasks.length - history,
    housekeepingHistory: history,
    lostFound: 6,
    tickets: ticketSeq,
    roomBlocks: block106 ? 1 : 0,
    fuelLogs: fuelRows.length,
    ratePlans: await prisma.ratePlan.count({ where: { tenantId } }),
    promoCodes: 4,
    promoRedemptions: redemptions,
    corporateAccounts: 3,
    cityLedgerInvoices: invoiceCount,
    guardAlerts: alerts.length,
  };
}

function chidinmaOr(users: Map<string, Person>, fallback: Person): Person {
  return users.get('chidinma@palmwine.ng') ?? fallback;
}
