/** Housekeeping rules: task minutes, default checklists, effective priority, auto-balance. */

export type TaskType = 'CHECKOUT_CLEAN' | 'STAYOVER' | 'DEEP_CLEAN' | 'TURNDOWN' | 'INSPECTION' | 'CUSTOM';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export const TASK_MINUTES: Record<TaskType, number> = {
  CHECKOUT_CLEAN: 35,
  STAYOVER: 20,
  DEEP_CLEAN: 90,
  TURNDOWN: 10,
  INSPECTION: 10,
  CUSTOM: 30,
};

const CLEAN = [
  'Bed stripped and made with fresh linen',
  'Bathroom cleaned and disinfected',
  'Towels replaced',
  'Amenities restocked (soap, shampoo, water)',
  'AC remote present and working',
  'TV and remote working',
  'Minibar counted and restocked',
  'Floor swept and mopped',
  'Bins emptied',
  'Windows and curtains checked',
];

export const DEFAULT_CHECKLISTS: Record<TaskType, string[]> = {
  CHECKOUT_CLEAN: CLEAN,
  DEEP_CLEAN: [...CLEAN, 'Mattress turned and checked', 'Behind and under furniture cleaned', 'AC filter cleaned', 'Walls and skirting wiped'],
  STAYOVER: ['Bed made', 'Towels replaced if on the floor', 'Bathroom wiped', 'Bins emptied', 'Water restocked'],
  TURNDOWN: ['Bed turned down', 'Curtains drawn', 'Water at the bedside'],
  INSPECTION: CLEAN,
  CUSTOM: ['Task done as described'],
};

/** Stable ids for checklist items ("i1", "i2", ...). */
export function checklistItems(labels: string[]): { id: string; label: string }[] {
  return labels.map((label, i) => ({ id: `i${i + 1}`, label }));
}

export const PRIORITY_ORDER: Record<Priority, number> = { URGENT: 0, HIGH: 1, NORMAL: 2, LOW: 3 };

/**
 * A room-turning task is URGENT while an arrival is due in the room today and
 * the room is not clean yet; otherwise its stored priority applies.
 */
export function effectivePriority(base: Priority, type: TaskType, arrivalToday: boolean, roomClean: boolean): Priority {
  if (arrivalToday && !roomClean && (type === 'CHECKOUT_CLEAN' || type === 'DEEP_CLEAN' || type === 'INSPECTION')) return 'URGENT';
  return base;
}

export interface BalanceTask {
  id: string;
  floor: number;
  roomNumber: string;
  minutes: number;
  priority: Priority;
  /** Tasks already started keep their housekeeper. */
  lockedTo: string | null;
}

/**
 * Suggests who cleans what: spreads the minutes evenly across housekeepers,
 * keeping rooms on the same floor with the same person where that does not
 * push them more than 20 minutes over the fair share.
 */
export function autoBalance(tasks: BalanceTask[], housekeepers: string[]): { assignments: Map<string, string>; load: Map<string, number>; target: number } {
  const load = new Map(housekeepers.map((h) => [h, 0]));
  const floors = new Map(housekeepers.map((h) => [h, new Set<number>()]));
  const assignments = new Map<string, string>();
  if (!housekeepers.length) return { assignments, load, target: 0 };
  for (const t of tasks) {
    if (t.lockedTo && load.has(t.lockedTo)) {
      load.set(t.lockedTo, load.get(t.lockedTo)! + t.minutes);
      floors.get(t.lockedTo)!.add(t.floor);
      assignments.set(t.id, t.lockedTo);
    }
  }
  const total = tasks.reduce((a, t) => a + t.minutes, 0);
  const target = Math.ceil(total / housekeepers.length);
  const free = tasks
    .filter((t) => !assignments.has(t.id))
    .sort((a, b) => a.floor - b.floor || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.roomNumber.localeCompare(b.roomNumber, 'en', { numeric: true }));
  for (const t of free) {
    const byLoad = [...housekeepers].sort((a, b) => load.get(a)! - load.get(b)! || a.localeCompare(b));
    const sameFloor = byLoad.find((h) => floors.get(h)!.has(t.floor) && load.get(h)! + t.minutes <= target + 20);
    const pick = sameFloor ?? byLoad[0];
    assignments.set(t.id, pick);
    load.set(pick, load.get(pick)! + t.minutes);
    floors.get(pick)!.add(t.floor);
  }
  return { assignments, load, target };
}
