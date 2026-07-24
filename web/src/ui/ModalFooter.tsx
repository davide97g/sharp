import { type ReactNode } from 'react'
import { cn } from './cn'

/**
 * Action row for forms living inside a Modal body that don't use the Modal's
 * `footer` prop (e.g. a submit button pinned to the bottom of the scroll body).
 */
export function ModalFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex justify-end gap-2 pt-4', className)}>{children}</div>
}
