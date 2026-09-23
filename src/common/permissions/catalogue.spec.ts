import { ALL_PERMISSIONS, missingFrom, PERMISSION_GROUPS, permissionsFor, SYSTEM_ROLES } from './catalogue.js';

describe('permission catalogue', () => {
  it('has unique codes and every system role uses only catalogue codes', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    for (const r of SYSTEM_ROLES) for (const c of r.permissions) expect(ALL_PERMISSIONS).toContain(c);
    expect(PERMISSION_GROUPS.every((g) => g.permissions.length > 0)).toBe(true);
  });

  it('gives OWNER everything and MANAGER everything but the payout account', () => {
    expect(permissionsFor('OWNER').size).toBe(ALL_PERMISSIONS.length);
    const m = permissionsFor('MANAGER');
    expect(m.has('payouts.manage')).toBe(false);
    expect(m.size).toBe(ALL_PERMISSIONS.length - 1);
  });

  it('keeps the M1-M3 role boundaries', () => {
    const desk = permissionsFor('FRONT_DESK');
    expect(desk.has('frontdesk.checkin')).toBe(true);
    expect(desk.has('folio.void')).toBe(false);
    expect(desk.has('staff.manage')).toBe(false);
    const hk = permissionsFor('HOUSEKEEPING');
    expect([...hk].sort()).toEqual(['housekeeping.view', 'housekeeping.work', 'maintenance.report']);
    expect(permissionsFor('SUPERVISOR').has('housekeeping.inspect')).toBe(true);
    expect(permissionsFor('MAINTENANCE').has('maintenance.work')).toBe(true);
    expect(permissionsFor('ACCOUNTANT').has('payments.take')).toBe(false);
  });

  it('gives a custom role only its stored, known codes', () => {
    const p = permissionsFor('CUSTOM', ['reports.view', 'not.a.permission', 'folio.view']);
    expect([...p].sort()).toEqual(['folio.view', 'reports.view']);
    expect(permissionsFor('CUSTOM', null).size).toBe(0);
  });

  it('lists what a grant would add beyond the granter (no escalation)', () => {
    const desk = permissionsFor('FRONT_DESK');
    expect(missingFrom(desk, ['folio.view', 'folio.void', 'staff.manage', 'folio.void'])).toEqual(['folio.void', 'staff.manage']);
    expect(missingFrom(permissionsFor('OWNER'), ALL_PERMISSIONS)).toEqual([]);
  });
});
