import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * THE focus behaviour every modal overlay needs: move focus into the panel on
 * open, loop Tab at its edges, restore the previously focused element on close.
 * Shared by `Modal` and `Sheet` — never hand-roll a Tab loop locally.
 *
 * - `ref`: the panel element focus stays inside.
 * - `initialFocusRef`: element focused on open (defaults to the first focusable).
 */
export function useFocusTrap({
  ref,
  initialFocusRef,
}: {
  ref: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const focusables = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE)
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
  }, [ref])

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const target =
      initialFocusRef?.current ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current
    target?.focus()
    return () => previousFocus?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
