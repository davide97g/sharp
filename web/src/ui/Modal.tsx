import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { sound } from '../lib/sound'
import { cn } from './cn'
import { IconButton } from './IconButton'
import { CloseIcon } from './icons'

export type ModalSize = 'md' | 'lg' | 'xl'

const sizeClass: Record<ModalSize, string> = {
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  size?: ModalSize
  /** legacy alias for size="lg" */
  wide?: boolean
  /** rendered in a sticky action bar under the scroll body */
  footer?: ReactNode
  /** glyph shown left of the title */
  headerIcon?: ReactNode
  /** element focused on open (defaults to the first focusable in the card) */
  initialFocusRef?: RefObject<HTMLElement | null>
}

/**
 * THE dialog primitive — Escape + backdrop dismiss, open/close sound, focus
 * trap, mobile full-bleed / desktop top-anchored card. Never hand-roll a
 * `fixed inset-0` dialog; extend this instead.
 */
export function Modal({
  title,
  onClose,
  children,
  size,
  wide,
  footer,
  headerIcon,
  initialFocusRef,
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null)
  const resolvedSize: ModalSize = size ?? (wide ? 'lg' : 'md')

  // Escape close + Tab focus-trap (loop focusables inside the card).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
      if (!focusables?.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Move focus into the dialog on open, restore it on close.
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const target =
      initialFocusRef?.current ??
      cardRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      cardRef.current
    target?.focus()
    return () => previousFocus?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Soft thup on open, slightly lower on close — every modal shares this.
  useEffect(() => {
    sound.modalOpen()
    return () => sound.modalClose()
  }, [])

  return (
    <div
      className="fixed inset-0 z-(--z-modal) flex items-stretch justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-start sm:p-4 sm:pt-[max(12vh,calc(var(--safe-top)+1.5rem))] sm:pb-[max(1rem,var(--safe-bottom))] sm:pl-[max(1rem,var(--safe-left))] sm:pr-[max(1rem,var(--safe-right))]"
      onMouseDown={onClose}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'flex min-h-0 w-full flex-col animate-in border border-border bg-panel pt-[var(--safe-top)] shadow-2xl outline-none max-sm:max-w-none max-sm:rounded-none sm:max-h-[min(76dvh,48rem)] sm:rounded-xl sm:pt-0',
          sizeClass[resolvedSize],
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            {headerIcon}
            <h2 className="truncate text-sm font-semibold">{title}</h2>
          </div>
          <IconButton label="Close" size="xl" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,var(--safe-bottom))]">
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
