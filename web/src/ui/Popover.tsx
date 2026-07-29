import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'
import { useDismiss } from './useDismiss'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  /** the always-rendered trigger; the panel anchors to its wrapper's box */
  trigger: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'bottom' | 'top'
  width?: string
  /** inline-size the panel to the trigger's width (combine with a `min-w-*`) */
  matchTriggerWidth?: boolean
  className?: string
  /** classes for the trigger wrapper — for a trigger inside a flex row (`flex`) */
  anchorClassName?: string
  children?: ReactNode
  /** forwarded onto the panel (e.g. role="menu") */
  role?: string
  /** forwarded onto the panel — required when `role` is dialog/menu without a label */
  'aria-label'?: string
}

/** trigger↔panel gap and the viewport margin the panel is kept inside. */
const GAP = 4
const EDGE = 8

type Placement = { top: number; left: number; width?: number }

/**
 * Positioned dropdown panel anchored to its trigger. `useDismiss` covers the
 * trigger wrapper *and* the panel, so clicking either doesn't insta-close.
 * All dropdown panels should build on this rather than hand-rolling absolute
 * positioning.
 *
 * The panel is portaled to `document.body` and `position: fixed`, measured off
 * the trigger's viewport rect. That is what keeps it out of every ancestor
 * `overflow` (modal scroll bodies, `max-h-* overflow-y-auto` lists, the chat
 * scroller) and out of every ancestor stacking context — an absolute panel got
 * clipped or painted under sibling content. It flips to the other side and is
 * clamped to the viewport when it doesn't fit, and re-measures on
 * scroll/resize/content change.
 */
export function Popover({
  open,
  onClose,
  trigger,
  align = 'start',
  side = 'bottom',
  width = 'w-56',
  matchTriggerWidth,
  className,
  anchorClassName = 'relative',
  children,
  role,
  'aria-label': ariaLabel,
}: PopoverProps) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const dismissRefs = useMemo(() => [anchorRef, panelRef], [])
  useDismiss({ ref: dismissRefs, onClose, enabled: open })

  const [pos, setPos] = useState<Placement | null>(null)

  const place = useCallback(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const t = anchor.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    // never ride up under the Tauri titlebar drag strip (0px in the browser)
    const top0 =
      EDGE +
      (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) || 0)
    const ph = panel.offsetHeight
    const pw = panel.offsetWidth

    const below = t.bottom + GAP
    const above = t.top - GAP - ph
    let top = side === 'bottom' ? below : above
    // flip only when the preferred side overflows and the other one fits
    if (side === 'bottom' && top + ph > vh - EDGE && above >= top0) top = above
    if (side === 'top' && top < top0 && below + ph <= vh - EDGE) top = below
    top = Math.max(top0, Math.min(top, vh - EDGE - ph))

    let left =
      align === 'end' ? t.right - pw : align === 'center' ? t.left + (t.width - pw) / 2 : t.left
    left = Math.max(EDGE, Math.min(left, vw - EDGE - pw))

    setPos({ top, left, width: matchTriggerWidth ? t.width : undefined })
  }, [align, side, matchTriggerWidth])

  // Measure before paint so the panel never shows at its pre-placement spot.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    place()
  }, [open, place])

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    // `true` = capture: recompute for any scrolling ancestor, not just window.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    // content-driven height changes (a filtering menu shrinking as you type)
    const ro = panel ? new ResizeObserver(place) : null
    if (panel) ro?.observe(panel)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      ro?.disconnect()
    }
  }, [open, place])

  // Callers own their own scroll cap when they pass one; otherwise keep the
  // panel inside the viewport. Checked here (not two competing max-h classes)
  // because `cn` joins classes without resolving Tailwind conflicts.
  const capHeight = !/(^|\s)max-h-/.test(className ?? '')

  return (
    <div ref={anchorRef} className={anchorClassName}>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role={role}
            aria-label={ariaLabel}
            style={
              pos
                ? { top: pos.top, left: pos.left, width: pos.width }
                : // pre-measurement pass: laid out, not yet visible
                  { top: 0, left: 0, visibility: 'hidden' }
            }
            // The panel sits outside the modal card in the DOM but inside it in
            // the React tree, so a synthetic mousedown would reach Modal's
            // backdrop handler and close the dialog.
            onMouseDown={(e) => e.stopPropagation()}
            className={cn(
              'fixed z-(--z-popover) rounded-xl border border-border bg-panel p-1 shadow-2xl',
              capHeight && 'max-h-[calc(100dvh-1rem)] overflow-y-auto',
              width,
              className,
            )}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  )
}
