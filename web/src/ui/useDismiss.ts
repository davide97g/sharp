import { useEffect, type RefObject } from 'react'

/**
 * THE shared click-outside + Escape dismiss hook for every popover, menu, and
 * dropdown. Never re-implement `window.addEventListener('mousedown'|'keydown')`
 * dismiss logic locally — use this.
 *
 * - `outside`: a mousedown outside `ref.current` calls `onClose`.
 * - `escape`: pressing Escape calls `onClose`.
 * - `enabled`: gate the whole thing (e.g. only when the popover is open).
 */
export function useDismiss({
  ref,
  onClose,
  escape = true,
  outside = true,
  enabled = true,
}: {
  ref: RefObject<HTMLElement | null>
  onClose: () => void
  escape?: boolean
  outside?: boolean
  enabled?: boolean
}) {
  useEffect(() => {
    if (!enabled) return

    function onMouseDown(e: MouseEvent) {
      const el = ref.current
      if (el && !el.contains(e.target as Node)) onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }

    if (outside) window.addEventListener('mousedown', onMouseDown)
    if (escape) window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [ref, onClose, escape, outside, enabled])
}
