// Doc-list reducers shared by the store actions and the WS event handler.
//
// Contract: docs/arch/02-docs.md.
//
// Docs, canvases and boards are all `docs` rows with a different `kind`, so all three
// flow through these helpers. `DocSlice` is deliberately a narrow slice of the store
// rather than the whole `State`: these are pure and testable, and callers spread the
// result.

import type { Doc, DocDeletedPayload, DocMention } from '../types'

export function sortDocs(docs: Doc[]): Doc[] {
  return [...docs].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
}

export function countUnread(mentions: DocMention[]): number {
  return mentions.reduce((n, m) => n + (m.read_at ? 0 : 1), 0)
}

export type DocSlice = {
  docsByChannel: Record<string, Doc[]>
  trashByChannel: Record<string, Doc[]>
  docMeta: Record<string, Doc>
}

export function withoutDoc(map: Record<string, Doc[]>, channelId: string, id: string): Record<string, Doc[]> {
  const list = map[channelId]
  if (!list) return map
  const next = list.filter((d) => d.id !== id)
  return next.length === list.length ? map : { ...map, [channelId]: next }
}

/** Upsert a doc into the right bucket (active/trash) based on my_role + deleted_at. */
export function placeDoc(s: DocSlice, doc: Doc): DocSlice {
  const cid = doc.channel_id
  if (doc.my_role === 'none') return removeDoc(s, doc.id, cid)

  const docMeta = { ...s.docMeta, [doc.id]: doc }
  let docsByChannel = withoutDoc(s.docsByChannel, cid, doc.id)
  let trashByChannel = withoutDoc(s.trashByChannel, cid, doc.id)

  if (doc.deleted_at) {
    // Only track trash for channels whose trash was explicitly loaded.
    if (trashByChannel[cid]) {
      trashByChannel = { ...trashByChannel, [cid]: sortDocs([...trashByChannel[cid], doc]) }
    }
  } else {
    const cur = docsByChannel[cid] ?? []
    docsByChannel = { ...docsByChannel, [cid]: sortDocs([...cur, doc]) }
  }
  return { docMeta, docsByChannel, trashByChannel }
}

export function removeDoc(s: DocSlice, id: string, channelId?: string): DocSlice {
  const cid = channelId ?? s.docMeta[id]?.channel_id
  const docMeta = { ...s.docMeta }
  delete docMeta[id]
  if (!cid) return { ...s, docMeta }
  return {
    docMeta,
    docsByChannel: withoutDoc(s.docsByChannel, cid, id),
    trashByChannel: withoutDoc(s.trashByChannel, cid, id),
  }
}

export function applyDocDeleted(s: DocSlice, p: DocDeletedPayload): DocSlice {
  if (p.permanent) return removeDoc(s, p.doc_id, p.channel_id)
  const existing =
    s.docMeta[p.doc_id] ?? s.docsByChannel[p.channel_id]?.find((d) => d.id === p.doc_id)
  if (!existing) {
    // Nothing cached: just drop from the active list if present.
    return { ...s, docsByChannel: withoutDoc(s.docsByChannel, p.channel_id, p.doc_id) }
  }
  return placeDoc(s, { ...existing, deleted_at: existing.deleted_at ?? new Date().toISOString() })
}
