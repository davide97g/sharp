import { useEffect, useRef, type RefObject } from 'react'

/**
 * Every live Escape-dismissable layer, in registration order. Escape is handled
 * by the last one only, so closing a picker inside a modal doesn't also close
 * the modal (both listen on `window`; a React `stopPropagation` can't reach a
 * listener outside the React root). Registration is keyed on `enabled`, never on
 * `onClose` identity — re-registering on every render would keep shuffling an
 * outer layer back to the top.
 */
const escapeLayers: object[] = []

/**
 * THE shared click-outside + Escape dismiss hook for every popover, menu, and
 * dropdown. Never re-implement `window.addEventListener('mousedown'|'keydown')`
 * dismiss logic locally — use this.
 *
 * - `outside`: a mousedown outside every `ref` calls `onClose`. Pass an array
 *   when the widget spans detached subtrees (a portaled panel plus its
 *   trigger) — a click in any of them counts as inside. Memoize the array.
 * - `escape`: pressing Escape calls `onClose`, but only on the topmost layer.
 * - `enabled`: gate the whole thing (e.g. only when the popover is open).
 */
export function useDismiss({
  ref,
  onClose,
  escape = true,
  outside = true,
  enabled = true,
}: {
  ref: RefObject<HTMLElement | null> | Array<RefObject<HTMLElement | null>>
  onClose: () => void
  escape?: boolean
  outside?: boolean
  enabled?: boolean
}) {
  // Latest callback without it being an effect dependency — callers pass inline
  // arrows, and re-subscribing every render would churn the layer stack.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!enabled || !outside) return
    function onMouseDown(e: MouseEvent) {
      const refs = Array.isArray(ref) ? ref : [ref]
      const target = e.target as Node
      const els = refs.map((r) => r.current).filter(Boolean) as HTMLElement[]
      if (els.length && !els.some((el) => el.contains(target))) closeRef.current()
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [ref, outside, enabled])

  useEffect(() => {
    if (!enabled || !escape) return
    const layer = {}
    escapeLayers.push(layer)
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (escapeLayers[escapeLayers.length - 1] !== layer) return
      closeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      const i = escapeLayers.indexOf(layer)
      if (i !== -1) escapeLayers.splice(i, 1)
    }
  }, [escape, enabled])
}
