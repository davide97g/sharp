import { type ReactNode } from 'react'
import { cn } from './cn'

export type OverlayZ = 'slideover' | 'modal' | 'overlay' | 'lightbox'

const zClass: Record<OverlayZ, string> = {
  slideover: 'z-(--z-slideover)',
  modal: 'z-(--z-modal)',
  overlay: 'z-(--z-overlay)',
  lightbox: 'z-(--z-lightbox)',
}

/**
 * The backdrop primitive shared by every full-screen overlay (modals,
 * slide-overs, lightboxes). Fills the viewport with an optional scrim + blur;
 * a mousedown on the backdrop itself (not its children) fires `onBackdrop`.
 * Never hand-roll `fixed inset-0` dialogs outside the ui/ primitives.
 */
export function Overlay({
  z = 'modal',
  blur = true,
  scrim = 'bg-black/60',
  onBackdrop,
  center = false,
  className,
  children,
}: {
  z?: OverlayZ
  blur?: boolean
  scrim?: string
  onBackdrop?: () => void
  center?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <div
      className={cn(
        'fixed inset-0 flex',
        zClass[z],
        blur && 'backdrop-blur-sm',
        scrim,
        center && 'items-center justify-center p-4',
        className,
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBackdrop?.()
      }}
    >
      {children}
    </div>
  )
}
