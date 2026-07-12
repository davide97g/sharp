import { create } from 'zustand'

export type Toast = {
  id: number
  kind: 'error' | 'info' | 'success'
  message: string
}

type ToastState = {
  toasts: Toast[]
  push: (kind: Toast['kind'], message: string) => void
  dismiss: (id: number) => void
}

let seq = 1

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = seq++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 4500)
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
