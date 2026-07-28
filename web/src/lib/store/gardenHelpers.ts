// Pure reducers for Garden creator-mode edits.
//
// One implementation, three callers: the optimistic path in `saveGardenLayout`,
// the undo stack, and (indirectly) any client that needs to replay ops. Keeping
// it pure is what lets the store apply an edit before the server confirms it and
// still converge on the authoritative list afterwards.

import type { GardenLayoutOp, GardenObject } from '../types'

/**
 * Apply creator-mode ops to a layout, returning a new array.
 *
 * `add` is idempotent on id, matching the server's `ON CONFLICT DO NOTHING`, so a
 * replayed batch cannot duplicate scenery. `move` on a missing id is a no-op
 * rather than an error: the object may have been deleted by another admin between
 * the gesture and the request.
 */
export function applyLayoutOps(
  layout: GardenObject[],
  ops: GardenLayoutOp[],
): GardenObject[] {
  let next = layout
  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        if (next.some((object) => object.id === op.id)) break
        next = [
          ...next,
          { id: op.id, kind: op.kind, x: op.x, y: op.y, flip: op.flip ?? false },
        ]
        break
      }
      case 'move': {
        next = next.map((object) =>
          object.id === op.id
            ? { ...object, x: op.x, y: op.y, flip: op.flip ?? object.flip }
            : object,
        )
        break
      }
      case 'remove': {
        next = next.filter((object) => object.id !== op.id)
        break
      }
    }
  }
  return next
}

/**
 * The ops that undo `ops`, given the layout they were applied to. Reversed, so
 * applying them in order restores the original state.
 */
export function invertLayoutOps(
  layout: GardenObject[],
  ops: GardenLayoutOp[],
): GardenLayoutOp[] {
  const before = new Map(layout.map((object) => [object.id, object]))
  const inverse: GardenLayoutOp[] = []
  for (const op of ops) {
    if (op.op === 'add') {
      inverse.push({ op: 'remove', id: op.id })
      continue
    }
    const original = before.get(op.id)
    if (!original) continue
    if (op.op === 'remove') {
      inverse.push({
        op: 'add',
        id: original.id,
        kind: original.kind,
        x: original.x,
        y: original.y,
        flip: original.flip,
      })
      continue
    }
    inverse.push({
      op: 'move',
      id: original.id,
      x: original.x,
      y: original.y,
      flip: original.flip,
    })
  }
  return inverse.reverse()
}
