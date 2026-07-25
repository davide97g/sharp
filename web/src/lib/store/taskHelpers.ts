// Task list ordering.
//
// Contract: docs/arch/11-tasks.md.
//
// Order is the server's fracIndex string (`sort_order`), compared as a string — never
// parsed as a number. Ties break on id so the order is total and stable across renders;
// without that, two tasks inserted at the same index would swap on every re-sort.

import type { Task } from '../types'

export function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) =>
    a.sort_order < b.sort_order
      ? -1
      : a.sort_order > b.sort_order
        ? 1
        : a.id < b.id
          ? -1
          : 1,
  )
}
