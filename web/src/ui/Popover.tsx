import { useRef, type ReactNode } from 'react'
import { cn } from './cn'
import { useDismiss } from './useDismiss'

export interface PopoverProps {
  open: boolean
  onClose: () => void
  /** the always-rendered trigger; the panel anchors relative to its wrapper */
  trigger: ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  width?: string
  className?: string
  children?: ReactNode
  /** forwarded onto the panel (e.g. role="menu") */
  role?: string
}

/**
 * Positioned dropdown panel anchored to its trigger. `useDismiss` lives on the
 * wrapper so clicking the trigger doesn't insta-close the panel. All dropdown
 * panels should build on this rather than hand-rolling absolute positioning.
 */
export function Popover({
  open,
  onClose,
  trigger,
  align = 'start',
  side = 'bottom',
  width = 'w-56',
  className,
  children,
  role,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  useDismiss({ ref, onClose, enabled: open })

  return (
    <div ref={ref} className="relative">
      {trigger}
      {open && (
        <div
          role={role}
          className={cn(
            'absolute z-(--z-dropdown) rounded-xl border border-border bg-panel p-1 shadow-2xl',
            side === 'bottom' ? 'top-full mt-1' : 'bottom-full mb-1',
            align === 'end' ? 'right-0' : 'left-0',
            width,
            className,
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}
