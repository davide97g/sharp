import { useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'
import { IconButton } from './IconButton'
import { CloseIcon } from './icons'
import { Overlay } from './Overlay'
import { useDismiss } from './useDismiss'
import { useFocusTrap } from './useFocusTrap'

/**
 * Bottom sheet — the touch-native way to pick one thing out of a list (a
 * section, a mode, a filter). Rises from the bottom edge, grabber affordance,
 * Escape + backdrop dismiss, focus trap, safe-area padding.
 *
 * Reach for it instead of:
 * - a native `<select>`, whose OS listbox ignores the theme and covers the page;
 * - `Menu`, when the trigger sits at the top of a small screen and a popover
 *   would hide the content it belongs to.
 *
 * `Sheet` is the choice surface; `.mobile-sheet` (index.css) is the different,
 * full-height mobile panel used for threads and Sharpy.
 */
export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  initialFocusRef,
  className,
}: {
  title: string
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  /** pinned action row under the scroll body */
  footer?: ReactNode
  /** element focused on open (defaults to the first focusable) */
  initialFocusRef?: RefObject<HTMLElement | null>
  className?: string
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDismiss({ ref: panelRef, onClose, outside: false })
  useFocusTrap({ ref: panelRef, initialFocusRef })

  return createPortal(
    <Overlay z="modal" scrim="bg-black/55" className="items-end justify-center" onBackdrop={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'sharp-sheet flex max-h-[min(82dvh,42rem)] w-full flex-col rounded-t-2xl border border-border bg-panel pb-[max(0.75rem,var(--safe-bottom))] shadow-2xl outline-none sm:mb-4 sm:max-w-[26rem] sm:rounded-2xl',
          className,
        )}
      >
        <div className="shrink-0 px-3 pt-2.5">
          <div className="mx-auto h-1 w-9 rounded-full bg-border" aria-hidden />
          <div className="flex min-h-11 items-center gap-2 pl-1 pt-1.5">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold">{title}</h2>
              {subtitle != null && (
                <p className="truncate text-2xs text-text-faint">{subtitle}</p>
              )}
            </div>
            <IconButton label="Close" size="lg" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-1">{children}</div>
        {footer && <div className="shrink-0 border-t border-border px-3 pt-2.5">{footer}</div>}
      </div>
    </Overlay>,
    document.body,
  )
}
