// Link preview cards — the unfurl of a URL posted in chat.
//
// Contract: docs/arch/01-core.md ("Link previews"). The server owns what a card
// says; this file only decides how it looks.
//
// Two rules worth keeping:
//
//   1. **Never `<img src={preview.image_url}>`.** Card art is fetched through
//      `/unfurl/image` so the linked site never learns who read the message —
//      that proxy is the whole point of storing a remote URL instead of a blob.
//   2. **The player frame only appears after a click.** `embed_url` is already
//      restricted to an allowlist server-side; click-to-play means a channel
//      full of video links still makes zero third-party requests until someone
//      asks for one.

import { useEffect, useMemo, useState } from 'react'
import { api, fetchAttachmentBlob, previewImageUrl } from '../lib/api'
import { extractUrls } from '../lib/linkUrls'
import { toastError } from '../lib/toast'
import { useStore } from '../store'
import type { LinkPreview } from '../lib/types'
import { IconButton } from '../ui'
import { ImageLightbox } from './ImageLightbox'

// One in-flight fetch and one object URL per remote asset, shared by every card
// showing it (the same article linked in three channels loads once).
const imageCache = new Map<string, Promise<string>>()
function loadPreviewImage(remoteUrl: string): Promise<string> {
  let pending = imageCache.get(remoteUrl)
  if (!pending) {
    pending = fetchAttachmentBlob(previewImageUrl(remoteUrl)).then((b) => URL.createObjectURL(b))
    pending.catch(() => imageCache.delete(remoteUrl))
    imageCache.set(remoteUrl, pending)
  }
  return pending
}

function useProxiedImage(remoteUrl: string | null): string | null {
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
function isRenderable(preview: LinkPreview): boolean {
  return Boolean(preview.title || preview.description || preview.image_url)
}

// ── Encrypted DMs ────────────────────────────────────────────────────────────────────
//
// The server stores an E2EE DM as ciphertext, so it cannot unfurl one. Here the
// client does the extraction on the decrypted text and asks the server to resolve
// each URL. The result is per-viewer and lives only in this tab: nothing is
// attached to the message, which is the point — the conversation stays opaque to
// the server beyond the URL itself.

const resolveCache = new Map<string, Promise<LinkPreview | null>>()
function resolvePreview(url: string): Promise<LinkPreview | null> {
  let pending = resolveCache.get(url)
  if (!pending) {
    pending = api
      .resolvePreview(url)
      .then((r) => r.preview)
      // A rate-limit or a dead link is a missing card, never an error surface.
      .catch(() => null)
    resolveCache.set(url, pending)
  }
  return pending
}

/**
 * Cards for a decrypted message. Renders nothing until the resolves land, so a
 * DM never reflows on send — the cards fade in the way the server-side ones do.
 */
export function DecryptedLinkPreviews({
  text,
  align = 'start',
}: {
  text: string
  align?: 'start' | 'end'
}) {
  const enabled = useStore((s) => s.ui.linkPreviews)
  const [previews, setPreviews] = useState<LinkPreview[]>([])
  const urls = useMemo(() => (enabled ? extractUrls(text) : []), [enabled, text])
  const key = urls.join('\n')

  useEffect(() => {
    if (!key) {
      setPreviews([])
      return
    }
    let cancelled = false
    Promise.all(key.split('\n').map(resolvePreview)).then((results) => {
      if (!cancelled) setPreviews(results.filter((p): p is LinkPreview => p !== null))
    })
    return () => {
      cancelled = true
    }
  }, [key])

  if (!enabled || previews.length === 0) return null
  // No ✕: there is nothing stored to remove. Settings → Chat turns them all off.
  return (
    <LinkPreviewList previews={previews} messageId="" canRemove={false} align={align} />
  )
}

export function LinkPreviewList({
  previews,
  messageId,
  canRemove,
  align = 'start',
}: {
  previews: LinkPreview[]
  messageId: string
  /** Author-only ✕ that hides the cards for everyone. */
  canRemove: boolean
  align?: 'start' | 'end'
}) {
  const enabled = useStore((s) => s.ui.linkPreviews)
  const cards = previews.filter(isRenderable)
  if (!enabled || cards.length === 0) return null
  return (
    <div
      className={`mt-1.5 flex w-full flex-col gap-2 ${align === 'end' ? 'items-end' : 'items-start'}`}
    >
      {cards.map((preview) => (
        <LinkPreviewCard
          key={preview.url}
          preview={preview}
          messageId={messageId}
          canRemove={canRemove}
        />
      ))}
    </div>
  )
}

function LinkPreviewCard({
  preview,
  messageId,
  canRemove,
}: {
  preview: LinkPreview
  messageId: string
  canRemove: boolean
}) {
  const [playing, setPlaying] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const [removing, setRemoving] = useState(false)
  const image = useProxiedImage(preview.image_url)

  // Wide art gets the full-width treatment (Discord's "large" embed); a small
  // or unknown-size thumbnail sits beside the text instead of dominating it.
  const wide =
    preview.kind !== 'link' || (preview.image_width ?? 0) >= 400 || !preview.title

  async function remove() {
    if (removing) return
    setRemoving(true)
    try {
      await api.hideMessagePreviews(messageId)
    } catch (e) {
      setRemoving(false)
      if (e instanceof Error) toastError(e.message)
    }
  }

  const host = hostOf(preview.url)
  const accent = preview.color ?? undefined

  return (
    <div
      className="group/preview relative w-full max-w-md overflow-hidden rounded-xl border border-border bg-panel"
      style={accent ? { borderLeftColor: accent, borderLeftWidth: 3 } : undefined}
    >
      {canRemove && (
        <div className="absolute right-1 top-1 z-10 opacity-0 transition-opacity group-hover/preview:opacity-100 focus-within:opacity-100">
          <IconButton
            label="Remove preview"
            size="sm"
            variant="ghost"
            onClick={remove}
            disabled={removing}
            className="bg-panel-2/80 backdrop-blur-sm"
          >
            <span aria-hidden className="text-xs leading-none">
              ✕
            </span>
          </IconButton>
        </div>
      )}

      <div className="flex flex-col gap-1.5 p-3">
        <div className="flex items-center gap-1.5 text-2xs text-text-faint">
          <Favicon url={preview.favicon_url} />
          <span className="truncate">{preview.site_name || host}</span>
          {preview.author && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{preview.author}</span>
            </>
          )}
        </div>

        <div className={wide ? 'flex flex-col gap-1.5' : 'flex items-start gap-3'}>
          <div className="min-w-0 flex-1">
            {preview.title && (
              <a
                href={preview.url}
                target="_blank"
                rel="noreferrer noopener"
                className="line-clamp-2 text-sm font-semibold text-accent hover:underline"
              >
                {preview.title}
              </a>
            )}
            {preview.description && (
              <p className="mt-1 line-clamp-3 text-xs text-text-dim">{preview.description}</p>
            )}
          </div>

          {!wide && image && (
            <button
              type="button"
              onClick={() => setLightbox(true)}
              className="shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-border bg-panel-2 p-0"
            >
              <img src={image} alt="" className="h-20 w-20 object-cover" />
            </button>
          )}
        </div>

        {wide && (
          <WideMedia
            preview={preview}
            image={image}
            playing={playing}
            onPlay={() => setPlaying(true)}
            onZoom={() => setLightbox(true)}
          />
        )}
      </div>

      {lightbox && image && (
        <ImageLightbox src={image} alt={preview.title ?? ''} onClose={() => setLightbox(false)} />
      )}
    </div>
  )
}

function WideMedia({
  preview,
  image,
  playing,
  onPlay,
  onZoom,
}: {
  preview: LinkPreview
  image: string | null
  playing: boolean
  onPlay: () => void
  onZoom: () => void
}) {
  if (preview.embed_url && playing) {
    return (
      <iframe
        src={`${preview.embed_url}${preview.embed_url.includes('?') ? '&' : '?'}autoplay=1`}
        title={preview.title ?? 'Embedded player'}
        allow="accelerometer; autoplay; encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="aspect-video w-full rounded-lg border border-border bg-black"
      />
    )
  }
  if (!image) {
    // Reserve the slot only for media we know is coming, so a text-only card
    // does not render an empty grey block.
    return preview.image_url ? <div className="skeleton aspect-video w-full rounded-lg" /> : null
  }
  if (preview.embed_url) {
    return (
      <button
        type="button"
        onClick={onPlay}
        aria-label={`Play ${preview.title ?? 'video'}`}
        className="group/play relative w-full overflow-hidden rounded-lg border border-border bg-black p-0"
      >
        <img src={image} alt="" className="aspect-video w-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center bg-black/25 transition-colors group-hover/play:bg-black/10">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-lg text-white shadow-lg transition-transform group-hover/play:scale-110">
            ▶
          </span>
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onZoom}
      className="w-full cursor-zoom-in overflow-hidden rounded-lg border border-border bg-panel-2 p-0"
    >
      <img src={image} alt={preview.title ?? ''} className="max-h-72 w-full object-cover" />
    </button>
  )
}

function Favicon({ url }: { url: string | null }) {
  const src = useProxiedImage(url)
  if (!src) return null
  return <img src={src} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}
