// Shared link-preview plumbing: the per-URL resolve cache, the proxied-image
// loader, and the label helpers.
//
// Contract: docs/arch/01-core.md ("Link previews").
//
// Two surfaces render previews and both go through here, so the same URL is
// fetched once per tab no matter how many cards or chips show it:
//
//   • chat  — `components/LinkPreview.tsx` (server-attached cards, plus the
//             client-resolved cards an encrypted DM needs)
//   • docs  — `components/docs/schema.tsx` (URL chips and bookmark blocks)
//
// The rule that must not be broken: **never `<img src={preview.image_url}>`**.
// Card art and favicons load through `/unfurl/image` so the linked site never
// learns who is reading. `useProxiedImage` is the only sanctioned path.

import { useEffect, useState } from 'react'
import { api, fetchAttachmentBlob, previewImageUrl } from './api'
import type { LinkPreview } from './types'

// One in-flight fetch and one object URL per remote asset, shared by every card
// showing it (the same article linked in three channels loads once).
const imageCache = new Map<string, Promise<string>>()

export function loadPreviewImage(remoteUrl: string): Promise<string> {
  let pending = imageCache.get(remoteUrl)
  if (!pending) {
    pending = fetchAttachmentBlob(previewImageUrl(remoteUrl)).then((b) => URL.createObjectURL(b))
    pending.catch(() => imageCache.delete(remoteUrl))
    imageCache.set(remoteUrl, pending)
  }
  return pending
}

export function useProxiedImage(remoteUrl: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!remoteUrl) {
      setSrc(null)
      return
    }
    let cancelled = false
    loadPreviewImage(remoteUrl)
      .then((url) => !cancelled && setSrc(url))
      .catch(() => !cancelled && setSrc(null))
    return () => {
      cancelled = true
    }
  }, [remoteUrl])
  return src
}

/** A card with nothing but a URL in it is noise — the link already renders. */
export function isRenderablePreview(preview: LinkPreview): boolean {
  return Boolean(preview.title || preview.description || preview.image_url)
}

// ── On-demand resolve ────────────────────────────────────────────────────────────────
//
// `POST /unfurl/resolve` unfurls one URL for a client that holds text the server
// cannot unfurl itself: an encrypted DM (ciphertext) or a doc (a Yjs blob the
// server never parses). It is rate-limited per user, so every caller shares this
// cache and a rate-limit or dead link resolves to `null` — a missing card, never
// an error surface.

const resolveCache = new Map<string, Promise<LinkPreview | null>>()

export function resolvePreview(url: string): Promise<LinkPreview | null> {
  let pending = resolveCache.get(url)
  if (!pending) {
    pending = api
      .resolvePreview(url)
      .then((r) => r.preview)
      .catch(() => null)
    resolveCache.set(url, pending)
  }
  return pending
}

/** Resolve state for one URL. `undefined` while in flight, `null` when it failed. */
export function usePreview(url: string | null): LinkPreview | null | undefined {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined)
  useEffect(() => {
    if (!url) {
      setPreview(null)
      return
    }
    let cancelled = false
    setPreview(undefined)
    resolvePreview(url).then((p) => {
      if (!cancelled) setPreview(p)
    })
    return () => {
      cancelled = true
    }
  }, [url])
  return preview
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Human label for a URL with no title yet: host plus a short tail, so three
 * links to the same site are still told apart. Never longer than ~48 chars.
 */
export function linkLabel(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const host = parsed.host.replace(/^www\./, '')
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  const label = `${host}${path}${parsed.search}`
  return label.length > 48 ? `${label.slice(0, 47)}…` : label
}
