// Typed Yjs helper layer for board docs (kind === 'board'). All Yjs-touching
// logic lives here so board components stay thin: they call readSnapshot() for a
// plain-JS view and the mutation functions (each wrapped in a single transaction)
// to write. Mirrors the shared-type layout documented in the plan:
//
//   ydoc.getMap('board')  — { properties: Y.Array<Y.Map>, groupByPropertyId }
//   ydoc.getMap('cards')  — cardId -> Y.Map { id, title, description, order, values: Y.Map }
//
// `color` on options is a palette key (see boardColors.ts), never hex. The server
// never interprets any of this (title-only search, no backlinks).
import * as Y from 'yjs'

export type BoardPropertyType = 'select' | 'multiSelect' | 'date' | 'assignee'

export type BoardOption = { id: string; label: string; color: string }

export type BoardProperty = {
  id: string
  type: BoardPropertyType
  name: string
  options?: BoardOption[]
}

export type BoardCardData = {
  id: string
  title: string
  description: string
  order: string
  values: Record<string, string | string[]>
}

export type BoardSnapshot = {
  properties: BoardProperty[]
  groupByPropertyId: string | null
  cards: BoardCardData[]
}

const uid = (): string => crypto.randomUUID()

// ---- map accessors ---------------------------------------------------------

export function getBoardMaps(ydoc: Y.Doc): { board: Y.Map<unknown>; cards: Y.Map<unknown> } {
  return { board: ydoc.getMap('board'), cards: ydoc.getMap('cards') }
}

function propertiesArray(board: Y.Map<unknown>): Y.Array<Y.Map<unknown>> | undefined {
  return board.get('properties') as Y.Array<Y.Map<unknown>> | undefined
}

function findProperty(ydoc: Y.Doc, propertyId: string): Y.Map<unknown> | null {
  const { board } = getBoardMaps(ydoc)
  const props = propertiesArray(board)
  if (!props) return null
  for (const p of props) if (p.get('id') === propertyId) return p
  return null
}

function optionsArray(prop: Y.Map<unknown>): Y.Array<Y.Map<unknown>> | undefined {
  return prop.get('options') as Y.Array<Y.Map<unknown>> | undefined
}

function groupById(board: Y.Map<unknown>): string | null {
  return (board.get('groupByPropertyId') as string | undefined) ?? null
}

// ---- builders --------------------------------------------------------------

function buildOption(label: string, color: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('id', uid())
  m.set('label', label)
  m.set('color', color)
  return m
}

function buildProperty(
  type: BoardPropertyType,
  name: string,
  options: Array<{ label: string; color: string }> = [],
): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('id', uid())
  m.set('type', type)
  m.set('name', name)
  if (type === 'select' || type === 'multiSelect') {
    const arr = new Y.Array<Y.Map<unknown>>()
    if (options.length) arr.push(options.map((o) => buildOption(o.label, o.color)))
    m.set('options', arr)
  }
  return m
}

// ---- seeding ---------------------------------------------------------------

// Create the default schema (a Status select driving the columns) exactly once.
// Guarded by an empty-map check inside the transaction so the first writer wins
// on a fresh-board race. Callers must gate this on provider `synced`.
export function seedBoardIfEmpty(ydoc: Y.Doc): void {
  const { board } = getBoardMaps(ydoc)
  ydoc.transact(() => {
    if (board.size > 0) return
    const status = buildProperty('select', 'Status', [
      { label: 'Todo', color: 'gray' },
      { label: 'In progress', color: 'blue' },
      { label: 'Done', color: 'green' },
    ])
    const props = new Y.Array<Y.Map<unknown>>()
    props.push([status])
    board.set('properties', props)
    board.set('groupByPropertyId', status.get('id') as string)
  })
}

// ---- snapshot --------------------------------------------------------------

function optionToPlain(opt: Y.Map<unknown>): BoardOption {
  return {
    id: opt.get('id') as string,
    label: (opt.get('label') as string) ?? '',
    color: (opt.get('color') as string) ?? 'gray',
  }
}

function propertyToPlain(prop: Y.Map<unknown>): BoardProperty {
  const type = prop.get('type') as BoardPropertyType
  const out: BoardProperty = {
    id: prop.get('id') as string,
    type,
    name: (prop.get('name') as string) ?? '',
  }
  const opts = optionsArray(prop)
  if (opts) out.options = opts.map(optionToPlain)
  return out
}

function valuesToPlain(values: Y.Map<unknown> | undefined): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  if (!values) return out
  values.forEach((v, k) => {
    out[k] = v instanceof Y.Array ? (v.toArray() as string[]) : (v as string)
  })
  return out
}

export function readSnapshot(ydoc: Y.Doc): BoardSnapshot {
  const { board, cards } = getBoardMaps(ydoc)
  const props = propertiesArray(board)
  const cardList: BoardCardData[] = []
  cards.forEach((c) => {
    const card = c as Y.Map<unknown>
    cardList.push({
      id: card.get('id') as string,
      title: (card.get('title') as string) ?? '',
      description: (card.get('description') as string) ?? '',
      order: (card.get('order') as string) ?? '',
      values: valuesToPlain(card.get('values') as Y.Map<unknown> | undefined),
    })
  })
  return {
    properties: props ? props.map(propertyToPlain) : [],
    groupByPropertyId: groupById(board),
    cards: cardList,
  }
}

// ---- card mutations --------------------------------------------------------

// `order` is a fractional-index key (see fracIndex.ts) computed by the caller.
export function createCard(
  ydoc: Y.Doc,
  args: { title: string; order: string; statusOptionId?: string | null },
): string {
  const { board, cards } = getBoardMaps(ydoc)
  const id = uid()
  ydoc.transact(() => {
    const card = new Y.Map<unknown>()
    card.set('id', id)
    card.set('title', args.title)
    card.set('description', '')
    card.set('order', args.order)
    const values = new Y.Map<unknown>()
    const gid = groupById(board)
    if (gid && args.statusOptionId != null) values.set(gid, args.statusOptionId)
    card.set('values', values)
    cards.set(id, card)
  })
  return id
}

export function updateCardField(
  ydoc: Y.Doc,
  cardId: string,
  field: 'title' | 'description',
  value: string,
): void {
  const { cards } = getBoardMaps(ydoc)
  ydoc.transact(() => {
    const card = cards.get(cardId) as Y.Map<unknown> | undefined
    if (card) card.set(field, value)
  })
}

// value: select -> string, multiSelect -> string[], date/assignee -> string.
// null/undefined deletes the key.
export function setCardValue(
  ydoc: Y.Doc,
  cardId: string,
  propertyId: string,
  value: string | string[] | null | undefined,
): void {
  const { cards } = getBoardMaps(ydoc)
  ydoc.transact(() => {
    const card = cards.get(cardId) as Y.Map<unknown> | undefined
    if (!card) return
    const values = card.get('values') as Y.Map<unknown> | undefined
    if (!values) return
    if (value == null) {
      values.delete(propertyId)
    } else if (Array.isArray(value)) {
      const arr = new Y.Array<string>()
      arr.push(value)
      values.set(propertyId, arr)
    } else {
      values.set(propertyId, value)
    }
  })
}

// Move a card: rewrite its order and, if given, its group (status) membership.
// statusOptionId === null clears the group value (card becomes uncategorized).
export function moveCard(
  ydoc: Y.Doc,
  cardId: string,
  order: string,
  statusOptionId: string | null,
): void {
  const { board, cards } = getBoardMaps(ydoc)
  ydoc.transact(() => {
    const card = cards.get(cardId) as Y.Map<unknown> | undefined
    if (!card) return
    card.set('order', order)
    const gid = groupById(board)
    if (!gid) return
    const values = card.get('values') as Y.Map<unknown> | undefined
    if (!values) return
    if (statusOptionId === null) values.delete(gid)
    else values.set(gid, statusOptionId)
  })
}

export function deleteCard(ydoc: Y.Doc, cardId: string): void {
  const { cards } = getBoardMaps(ydoc)
  ydoc.transact(() => {
    cards.delete(cardId)
  })
}

// ---- property / option mutations -------------------------------------------

export function addProperty(
  ydoc: Y.Doc,
  args: { type: BoardPropertyType; name: string },
): string {
  const { board } = getBoardMaps(ydoc)
  let id = ''
  ydoc.transact(() => {
    let props = propertiesArray(board)
    if (!props) {
      props = new Y.Array<Y.Map<unknown>>()
      board.set('properties', props)
    }
    const prop = buildProperty(args.type, args.name)
    id = prop.get('id') as string
    props.push([prop])
  })
  return id
}

export function renameProperty(ydoc: Y.Doc, propertyId: string, name: string): void {
  ydoc.transact(() => {
    const prop = findProperty(ydoc, propertyId)
    if (prop) prop.set('name', name)
  })
}

export function deleteProperty(ydoc: Y.Doc, propertyId: string): void {
  const { board } = getBoardMaps(ydoc)
  ydoc.transact(() => {
    const props = propertiesArray(board)
    if (!props) return
    for (let i = 0; i < props.length; i++) {
      if (props.get(i).get('id') === propertyId) {
        props.delete(i, 1)
        break
      }
    }
  })
}

export function addOption(
  ydoc: Y.Doc,
  propertyId: string,
  args: { label: string; color: string },
): string {
  let id = ''
  ydoc.transact(() => {
    const prop = findProperty(ydoc, propertyId)
    if (!prop) return
    const opts = optionsArray(prop)
    if (!opts) return
    const opt = buildOption(args.label, args.color)
    id = opt.get('id') as string
    opts.push([opt])
  })
  return id
}

export function updateOption(
  ydoc: Y.Doc,
  propertyId: string,
  optionId: string,
  args: { label?: string; color?: string },
): void {
  ydoc.transact(() => {
    const prop = findProperty(ydoc, propertyId)
    if (!prop) return
    const opts = optionsArray(prop)
    if (!opts) return
    for (const opt of opts) {
      if (opt.get('id') === optionId) {
        if (args.label !== undefined) opt.set('label', args.label)
        if (args.color !== undefined) opt.set('color', args.color)
        break
      }
    }
  })
}

export function deleteOption(ydoc: Y.Doc, propertyId: string, optionId: string): void {
  ydoc.transact(() => {
    const prop = findProperty(ydoc, propertyId)
    if (!prop) return
    const opts = optionsArray(prop)
    if (!opts) return
    for (let i = 0; i < opts.length; i++) {
      if (opts.get(i).get('id') === optionId) {
        opts.delete(i, 1)
        break
      }
    }
  })
}

// Reorder an option within its property (option order == column order for the
// group-by select). Delete + re-insert a fresh clone in one transaction.
export function moveOption(
  ydoc: Y.Doc,
  propertyId: string,
  optionId: string,
  toIndex: number,
): void {
  ydoc.transact(() => {
    const prop = findProperty(ydoc, propertyId)
    if (!prop) return
    const opts = optionsArray(prop)
    if (!opts) return
    let from = -1
    for (let i = 0; i < opts.length; i++) {
      if (opts.get(i).get('id') === optionId) {
        from = i
        break
      }
    }
    if (from === -1) return
    const src = opts.get(from)
    const clone = buildOption(
      (src.get('label') as string) ?? '',
      (src.get('color') as string) ?? 'gray',
    )
    clone.set('id', optionId) // preserve id so card values keep pointing at it
    opts.delete(from, 1)
    const dest = Math.max(0, Math.min(toIndex, opts.length))
    opts.insert(dest, [clone])
  })
}
