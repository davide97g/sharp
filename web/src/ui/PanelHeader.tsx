import { type ReactNode } from 'react'
import { cn } from './cn'
import { IconButton } from './IconButton'
import { CloseIcon } from './icons'

/**
 * The h-14 border-b header used by slide-overs and contextual panels: optional
 * leading icon, a title/subtitle column, trailing actions, and an optional
 * close button.
 */
export function PanelHeader({
  title,
  subtitle,
  icon,
  actions,
  onClose,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  onClose?: () => void
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex min-h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text">{title}</div>
          {subtitle && <div className="truncate text-2xs text-text-faint">{subtitle}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {onClose && (
          <IconButton label="Close" size="xl" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        )}
      </div>
    </div>
  )
}
