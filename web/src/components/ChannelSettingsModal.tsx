import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { useStore } from '../store'
import { toastError } from '../lib/toast'
import { visibleEmail } from '../lib/util'

const NAME_RE = /^[a-z0-9-]{1,50}$/

export function ChannelSettingsModal({
  channelId,
  onClose,
}: {
  channelId: string
  onClose: () => void
}) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const [tab, setTab] = useState<'about' | 'members'>('about')

  // The channel can vanish under us (deleted, or we were removed from a
  // private one). Close rather than render a broken shell.
  useEffect(() => {
    if (!channel) onClose()
  }, [channel, onClose])
  if (!channel) return null

  return (
    <Modal title={`#${channel.name}`} onClose={onClose} wide>
      <div className="mb-4 flex gap-1 border-b border-[var(--color-border)]">
        <Tab active={tab === 'about'} onClick={() => setTab('about')}>
          About
        </Tab>
        <Tab active={tab === 'members'} onClick={() => setTab('members')}>
          Members
        </Tab>
      </div>
      {tab === 'about' ? (
        <AboutTab channelId={channelId} onClose={onClose} />
      ) : (
        <MembersTab channelId={channelId} />
      )}
    </Modal>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-text)]'
          : 'border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}

function AboutTab({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const me = useStore((s) => s.me)
  const updateChannel = useStore((s) => s.updateChannel)
  const deleteChannel = useStore((s) => s.deleteChannel)
  const muted = useStore((s) => s.mutedChannels.has(channelId))
  const toggleMute = useStore((s) => s.toggleMute)

  const [name, setName] = useState(channel?.name ?? '')
  const [topic, setTopic] = useState(channel?.topic ?? '')
  const [kind, setKind] = useState<'public' | 'private'>(
    channel?.kind === 'private' ? 'private' : 'public',
  )
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  if (!channel) return null
  const isOwner = !!channel.created_by && !!me && channel.created_by === me.id

  const normalized = name.trim().toLowerCase()
  const nameValid = NAME_RE.test(normalized)
  const dirty =
    normalized !== channel.name || topic.trim() !== channel.topic || kind !== channel.kind
  const canSave = nameValid && dirty && !busy

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!canSave || !channel) return
    setBusy(true)
    try {
      await updateChannel(channel.id, {
        name: normalized !== channel.name ? normalized : undefined,
        topic: topic.trim() !== channel.topic ? topic.trim() : undefined,
        kind: kind !== channel.kind ? kind : undefined,
      })
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function doDelete() {
    if (!channel) return
    setDeleting(true)
    try {
      await deleteChannel(channel.id)
      onClose()
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
      setDeleting(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-text-dim)]">Name</span>
        <div className="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-soft)]">
          <span className="text-[var(--color-text-faint)]">#</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 bg-transparent px-2 py-2.5 text-sm focus:outline-none"
          />
        </div>
        <span className="text-[11px] text-[var(--color-text-faint)]">
          Lowercase letters, numbers, and hyphens. 1–50 chars.
        </span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-text-dim)]">Topic</span>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="What's this channel about?"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-sm focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-text-dim)]">Visibility</span>
        <div className="flex gap-2">
          <VisibilityOption
            active={kind === 'public'}
            onClick={() => setKind('public')}
            label="Public"
            desc="Anyone can join"
          />
          <VisibilityOption
            active={kind === 'private'}
            onClick={() => setKind('private')}
            label="Private"
            desc="Invite only"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-text-dim)]">
          Notifications
        </span>
        <button
          type="button"
          onClick={() => toggleMute(channel.id)}
          className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-left hover:border-[var(--color-accent)]"
        >
          <span className="min-w-0">
            <span className="block text-sm font-medium">Mute this channel</span>
            <span className="block text-[11px] text-[var(--color-text-faint)]">
              {muted
                ? 'Muted — no unread badges, toasts, or push.'
                : 'Silence unread badges, toasts, and push for this channel.'}
            </span>
          </span>
          <span
            role="switch"
            aria-checked={muted}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
              muted ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                muted ? 'translate-x-[18px]' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="submit"
          disabled={!canSave}
          className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>

      {isOwner && (
        <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-400">
            Danger zone
          </div>
          {confirmDelete ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-[var(--color-text-dim)]">
                Delete <span className="font-semibold">#{channel.name}</span> and all its
                messages and docs? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={doDelete}
                  disabled={deleting}
                  className="rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleting ? 'Deleting…' : 'Delete channel'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="rounded-lg border border-red-500/40 px-3 py-2 text-sm font-medium text-red-400 hover:bg-red-500/10"
            >
              Delete this channel
            </button>
          )}
        </div>
      )}
    </form>
  )
}

function MembersTab({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const members = useStore((s) => s.members[channelId])
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const loadMembers = useStore((s) => s.loadMembers)
  const addChannelMembers = useStore((s) => s.addChannelMembers)
  const removeChannelMember = useStore((s) => s.removeChannelMember)

  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    loadMembers(channelId)
  }, [channelId, loadMembers])

  const memberRows = useMemo(
    () => [...(members ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [members],
  )

  const candidates = useMemo(() => {
    const memberIds = new Set((members ?? []).map((m) => m.id))
    const q = query.trim().toLowerCase()
    return Object.values(users)
      .filter((u) => !memberIds.has(u.id))
      .filter((u) => !q || u.display_name.toLowerCase().includes(q))
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .slice(0, 8)
  }, [users, members, query])

  async function add(userId: string) {
    setPending(userId)
    try {
      await addChannelMembers(channelId, [userId])
      setQuery('')
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setPending(null)
    }
  }

  async function remove(userId: string) {
    setPending(userId)
    try {
      await removeChannelMember(channelId, userId)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setPending(null)
    }
  }

  const loading = members === undefined

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-text-dim)]">Add people</span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people to add…"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-sm focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
        />
        {query.trim() && (
          <div className="max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)]">
            {candidates.length === 0 ? (
              <div className="px-3 py-3 text-sm text-[var(--color-text-faint)]">
                No one to add.
              </div>
            ) : (
              candidates.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={pending === u.id}
                  onClick={() => add(u.id)}
                  className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left hover:bg-[var(--color-panel-2)] disabled:opacity-50"
                >
                  <Avatar id={u.id} name={u.display_name} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{u.display_name}</div>
                    {visibleEmail(u, me?.id) && (
                      <div className="truncate text-[11px] text-[var(--color-text-faint)]">
                        {visibleEmail(u, me?.id)}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-[var(--color-accent)]">Add</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="text-xs font-medium text-[var(--color-text-dim)]">
        Members{members ? ` · ${members.length}` : ''}
      </div>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-11 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="max-h-[45vh] space-y-1 overflow-y-auto">
          {memberRows.map((u) => {
            const isCreator = u.id === channel?.created_by
            return (
              <div key={u.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                <Avatar id={u.id} name={u.display_name} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{u.display_name}</div>
                  {visibleEmail(u, me?.id) && (
                    <div className="truncate text-[11px] text-[var(--color-text-faint)]">
                      {visibleEmail(u, me?.id)}
                    </div>
                  )}
                </div>
                {isCreator ? (
                  <span className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-faint)]">
                    Owner
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={pending === u.id}
                    onClick={() => remove(u.id)}
                    className="rounded-md px-2.5 py-1 text-xs text-[var(--color-text-dim)] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function VisibilityOption({
  active,
  onClick,
  label,
  desc,
}: {
  active: boolean
  onClick: () => void
  label: string
  desc: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-lg border px-3 py-2 text-left transition ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[11px] text-[var(--color-text-faint)]">{desc}</div>
    </button>
  )
}
