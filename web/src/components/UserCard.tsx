import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { useDisplayName } from '../lib/displayName'
import { Avatar } from './Avatar'

type Anchor = { top: number; left: number; bottom: number; right: number }

/**
 * Click target that opens a personal nickname card for another user.
 * Self targets render children unchanged.
 */
export function UserChip({
  userId,
  fallbackName,
  children,
  className,
}: {
  userId: string
  fallbackName: string
  children: ReactNode
  className?: string
}) {
  const meId = useStore((s) => s.me?.id)
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const triggerRef = useRef<HTMLSpanElement>(null)

  if (!userId || userId === meId) {
    return <span className={className}>{children}</span>
  }

  function measure(): Anchor | null {
    const el = triggerRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: r.top, left: r.left, bottom: r.bottom, right: r.right }
  }

  function openAt() {
    const a = measure()
    if (!a) return
    setAnchor(a)
    setOpen(true)
  }

  return (
    <>
      <span
        ref={triggerRef}
        className={className ?? 'inline-flex cursor-pointer'}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          if (open) setOpen(false)
          else openAt()
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            if (open) setOpen(false)
            else openAt()
          }
        }}
      >
        {children}
      </span>
      {open && anchor && (
        <UserCardPopover
          userId={userId}
          fallbackName={fallbackName}
          anchor={anchor}
          triggerRef={triggerRef}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function UserCardPopover({
  userId,
  fallbackName,
  anchor,
  triggerRef,
  onClose,
}: {
  userId: string
  fallbackName: string
  anchor: Anchor
  triggerRef: RefObject<HTMLSpanElement | null>
  onClose: () => void
}) {
  const users = useStore((s) => s.users)
  const nicknames = useStore((s) => s.nicknames)
  const setNickname = useStore((s) => s.setNickname)
  const clearNickname = useStore((s) => s.clearNickname)
  const realName = users[userId]?.display_name ?? fallbackName
  const displayName = useDisplayName(userId, fallbackName)
  const existing = nicknames[userId] ?? ''
  const [draft, setDraft] = useState(existing)
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const WIDTH = 280
  const [pos, setPos] = useState({ top: anchor.bottom + 6, left: anchor.left })

  useEffect(() => {
    setDraft(existing)
  }, [existing, userId])

  useLayoutEffect(() => {
    const el = ref.current
    const margin = 8
    const height = el?.offsetHeight ?? 0
    let left = anchor.left
    if (left + WIDTH + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - WIDTH - margin)
    }
    let top = anchor.bottom + 6
    if (top + height + margin > window.innerHeight) {
      top = Math.max(margin, anchor.top - height - 6)
    }
    setPos({ top, left })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      // Let the trigger's own click handler toggle closed (avoid close+reopen).
      if (triggerRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose, triggerRef])

  async function save() {
    const next = draft.trim()
    if (next === existing.trim()) {
      onClose()
      return
    }
    setSaving(true)
    try {
      if (!next) await clearNickname(userId)
      else await setNickname(userId, next)
      onClose()
    } catch {
      /* store already toasted */
    } finally {
      setSaving(false)
    }
  }

  async function clear() {
    setSaving(true)
    try {
      await clearNickname(userId)
      setDraft('')
    } catch {
      /* store already toasted */
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[80] w-[280px] rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-2xl"
      style={{ top: pos.top, left: pos.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-3">
        <Avatar id={userId} name={realName} size={48} nicknameCard={false} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--color-text)]">
            {displayName}
          </div>
          {existing.trim() && existing.trim() !== realName ? (
            <div className="truncate text-[11px] text-[var(--color-text-faint)]">
              Also known as {realName}
            </div>
          ) : (
            <div className="truncate text-[11px] text-[var(--color-text-faint)]">
              {realName}
            </div>
          )}
        </div>
      </div>

      <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
        Nickname for you
      </label>
      <div className="mt-1 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={80}
          placeholder="e.g. 🏴‍☠️ Pirate King"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
        />
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-[var(--color-accent)] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {saving ? '…' : 'Save'}
        </button>
      </div>
      {existing ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => void clear()}
          className="mt-2 text-[11px] text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
        >
          Clear nickname
        </button>
      ) : (
        <p className="mt-2 text-[11px] text-[var(--color-text-faint)]">
          Only you see this name. Emoji welcome.
        </p>
      )}
    </div>,
    document.body,
  )
}
