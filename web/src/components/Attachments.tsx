import { useEffect, useState } from 'react'
import { fetchAttachmentBlob } from '../lib/api'
import { decryptAttachmentBlob } from '../lib/e2ee/attachments'
import { toastError } from '../lib/toast'
import { fmtBytes } from '../lib/util'
import type { Attachment } from '../lib/types'
import { ImageLightbox } from './ImageLightbox'

// SVG is excluded from inline rendering — it can carry script; treat it as a
// download instead (matches the server, which serves non-safe types as downloads).
function isInlineImage(contentType: string): boolean {
  return contentType.startsWith('image/') && contentType !== 'image/svg+xml'
}

async function attachmentBlob(att: Attachment, download = false): Promise<Blob> {
  const ciphertext = await fetchAttachmentBlob(`${att.url}${download ? '?download=1' : ''}`)
  return att.encrypted ? decryptAttachmentBlob(ciphertext, att) : ciphertext
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((a) =>
        isInlineImage(a.content_type) ? (
          <AuthedImage key={a.id} att={a} />
        ) : (
          <FileChip key={a.id} att={a} />
        ),
      )}
    </div>
  )
}

function AuthedImage({ att }: { att: Attachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    let obj: string | null = null
    attachmentBlob(att)
      .then((blob) => {
        if (cancelled) return
        obj = URL.createObjectURL(blob)
        setSrc(obj)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [att])

  if (failed) return <FileChip att={att} />

  return (
    <>
      <button
        type="button"
        onClick={() => src && setOpen(true)}
        disabled={!src}
        title={att.filename}
        className="block cursor-zoom-in overflow-hidden rounded-lg border border-[var(--color-border)] bg-transparent p-0 text-left disabled:cursor-default"
      >
        {src ? (
          <img
            src={src}
            alt={att.filename}
            className="max-h-80 max-w-xs object-cover"
          />
        ) : (
          <div className="skeleton h-40 w-56" />
        )}
      </button>
      {open && src ? (
        <ImageLightbox src={src} alt={att.filename} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

function FileChip({ att }: { att: Attachment }) {
  const [busy, setBusy] = useState(false)

  async function download() {
    if (busy) return
    setBusy(true)
    try {
      const blob = await attachmentBlob(att, true)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = att.filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={download}
      disabled={busy}
      className="flex max-w-xs items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-left text-sm hover:border-[var(--color-text-faint)] disabled:opacity-50"
    >
      <span className="text-lg">{busy ? '⏳' : '📄'}</span>
      <span className="min-w-0">
        <span className="block truncate text-[var(--color-text)]">{att.filename}</span>
        <span className="block text-[11px] text-[var(--color-text-faint)]">
          {fmtBytes(att.size)}
        </span>
      </span>
    </button>
  )
}
