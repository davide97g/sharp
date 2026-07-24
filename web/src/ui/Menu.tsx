import { type ReactNode } from 'react'
import { cn } from './cn'
import { Popover, type PopoverProps } from './Popover'

/** A Popover whose panel is a menu (`role="menu"`). */
export function Menu(props: Omit<PopoverProps, 'role'>) {
  return <Popover {...props} role="menu" />
}

export function MenuItem({
  icon,
  danger,
  disabled,
  onClick,
  className,
  children,
  trailing,
}: {
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  className?: string
  children: ReactNode
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm text-text outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 disabled:hover:bg-transparent',
        danger && 'text-danger-fg hover:bg-danger-soft',
        className,
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing != null && <span className="ml-auto flex items-center gap-1.5">{trailing}</span>}
    </button>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-3xs font-semibold uppercase tracking-wide text-text-faint">
      {children}
    </div>
  )
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-border" />
}
