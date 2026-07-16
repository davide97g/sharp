import { create } from 'zustand'
import { sound } from './sound'

export type Toast = {
  id: number
  kind: 'error' | 'info' | 'success' | 'notify'
  message: string
  /** notify only: bold header line (who + where). */
  title?: string
  /** notify only: avatar initial for the little accent bubble. */
  initial?: string
  /** click handler (e.g. deep-link into the channel). */
  onClick?: () => void
}

type NotifyExtra = Pick<Toast, 'title' | 'initial' | 'onClick'>

type ToastState = {
  toasts: Toast[]
  push: (kind: Toast['kind'], message: string, extra?: NotifyExtra) => void
  dismiss: (id: number) => void
}

let seq = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, extra) => {
    const id = seq++
    // One sound per toast (fires here, not on each render). Info/notify stay
    // silent — the notification chime already covers notify toasts.
    if (kind === 'success') sound.toastSuccess()
    else if (kind === 'error') sound.toastError()
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, ...extra }] }))
    // Notification toasts linger a touch longer so they're readable.
    const ttl = kind === 'notify' ? 6000 : 4500
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, ttl)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export function toastError(message: string) {
  useToasts.getState().push('error', message)
}
export function toastInfo(message: string) {
  useToasts.getState().push('info', message)
}
export function toastSuccess(message: string) {
  useToasts.getState().push('success', message)
}
/** Rich, attention-grabbing toast for an incoming notification. */
export function toastNotify(body: string, extra: NotifyExtra) {
  useToasts.getState().push('notify', body, extra)
}
