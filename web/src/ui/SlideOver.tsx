import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'
import { Overlay } from './Overlay'
import { PanelHeader } from './PanelHeader'

/**
 * Right-hand slide-over panel — the notification-center / contextual-card
 * pattern. Escape closes; a backdrop mousedown closes. Portals to the body by
 * default so it escapes overflow/stacking contexts.
 */
export function SlideOver({
  title,
  subtitle,
  icon,
  onClose,
  width = 'max-w-[26rem]',
  portal = true,
  footer,
  headerActions,
  className,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  onClose: () => void
  width?: string
  portal?: boolean
  footer?: ReactNode
  headerActions?: ReactNode
  className?: string
  children: ReactNode
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const content = (
    <Overlay
      z="overlay"
      scrim="bg-black/45"
      className="justify-end backdrop-blur-[2px]"
      onBackdrop={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'inbox-panel flex h-full w-full flex-col border-l border-border bg-panel shadow-2xl max-md:max-w-none',
          width,
          className,
        )}
        style={{
          paddingTop: 'calc(var(--titlebar-h) + var(--safe-top))',
          paddingBottom: 'var(--safe-bottom)',
        }}
      >
        <PanelHeader title={title} subtitle={subtitle} icon={icon} actions={headerActions} onClose={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>
        )}
      </aside>
    </Overlay>
  )

  return portal ? createPortal(content, document.body) : content
}
