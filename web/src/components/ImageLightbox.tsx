import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Overlay } from '../ui'

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string
  alt?: string
  onClose: () => void
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = prev
    }
  }, [onClose])

  // TODO(ds): Overlay does not forward role="dialog"/aria-modal; lightbox keeps
  // its own Escape handling (capture phase) + body scroll lock above.
  return createPortal(
    <Overlay z="lightbox" scrim="bg-black/90" center className="safe-pad" onBackdrop={onClose}>
      <button
        type="button"
        onClick={onClose}
        onMouseDown={(e) => e.stopPropagation()}
        aria-label="Close"
        className="absolute right-3 top-[calc(0.75rem+var(--titlebar-h))] z-10 rounded-md bg-black/50 px-2.5 py-1.5 text-lg leading-none text-white/80 hover:bg-black/70 hover:text-white"
      >
        ✕
      </button>
      <img
        src={src}
        alt={alt || ''}
        onMouseDown={(e) => e.stopPropagation()}
        className="max-h-full max-w-full object-contain select-none"
        draggable={false}
      />
    </Overlay>,
    document.body,
  )
}
