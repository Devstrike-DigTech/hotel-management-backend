import { autoBalance, checklistItems, DEFAULT_CHECKLISTS, effectivePriority, type BalanceTask } from './housekeeping.logic.js';

describe('housekeeping rules', () => {
  it('makes a turn task urgent while an arrival waits for a dirty room', () => {
    expect(effectivePriority('NORMAL', 'CHECKOUT_CLEAN', true, false)).toBe('URGENT');
    expect(effectivePriority('NORMAL', 'DEEP_CLEAN', true, false)).toBe('URGENT');
    expect(effectivePriority('NORMAL', 'CHECKOUT_CLEAN', true, true)).toBe('NORMAL');
    expect(effectivePriority('LOW', 'CHECKOUT_CLEAN', false, false)).toBe('LOW');
    expect(effectivePriority('NORMAL', 'STAYOVER', true, false)).toBe('NORMAL');
  });

  it('numbers checklist items stably', () => {
    const items = checklistItems(DEFAULT_CHECKLISTS.STAYOVER);
    expect(items[0]).toEqual({ id: 'i1', label: DEFAULT_CHECKLISTS.STAYOVER[0] });
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('spreads minutes evenly, keeps floors together and respects started tasks', () => {
    const t = (id: string, floor: number, minutes: number, lockedTo: string | null = null): BalanceTask => ({ id, floor, roomNumber: id, minutes, priority: 'NORMAL', lockedTo });
    const tasks = [t('101', 1, 45), t('102', 1, 45), t('103', 1, 20), t('201', 2, 45), t('202', 2, 45), t('203', 2, 20, 'musa')];
    const { assignments, load, target } = autoBalance(tasks, ['blessing', 'musa']);
    expect(target).toBe(110);
    expect(assignments.get('203')).toBe('musa');
    expect(assignments.size).toBe(6);
    const loads = [...load.values()];
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(45);
    // Each housekeeper works mostly one floor.
    const floorsOf = (h: string) => new Set(tasks.filter((x) => assignments.get(x.id) === h).map((x) => x.floor));
    expect(floorsOf('musa').has(2)).toBe(true);
    expect(floorsOf('blessing').has(1)).toBe(true);
  });

  it('assigns nothing without housekeepers', () => {
    expect(autoBalance([{ id: 'a', floor: 1, roomNumber: '101', minutes: 30, priority: 'NORMAL', lockedTo: null }], []).assignments.size).toBe(0);
  });
});
