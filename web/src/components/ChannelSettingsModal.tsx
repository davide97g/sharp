import { effectiveNicknames } from '../lib/displayName'
import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { UserChip } from './UserCard'
import { ToggleVisual } from './Toggle'
import { Button, ChoiceCard, Field, Input, Select, Tabs } from '../ui'
import { useStore } from '../store'
import { toastError } from '../lib/toast'
import { channelLabel, visibleEmail } from '../lib/util'
import { VoiceTriggerEditor } from './VoiceTriggerEditor'

const NAME_RE = /^[a-z0-9-]{1,50}$/

export function ChannelSettingsModal({
  channelId,
  onClose,
}: {
  channelId: string
  onClose: () => void
}) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const nicknames = useStore(effectiveNicknames)
  const [tab, setTab] = useState<'about' | 'members' | 'triggers'>('about')

  // The channel can vanish under us (deleted, or we were removed from a
  // private one). Close rather than render a broken shell.
  useEffect(() => {
    if (!channel) onClose()
  }, [channel, onClose])
  if (!channel) return null

  if (channel.kind === 'dm') {
    return (
      <Modal title={channelLabel(channel, nicknames)} onClose={onClose} wide>
        <VoiceTriggersTab channelId={channelId} />
      </Modal>
    )
  }

  return (
    <Modal title={`#${channel.name}`} onClose={onClose} wide>
      <Tabs
        className="mb-4"
        active={tab}
        onChange={(key) => setTab(key as 'about' | 'members' | 'triggers')}
        items={[
          { key: 'about', label: 'About' },
          { key: 'members', label: 'Members' },
          { key: 'triggers', label: 'Voice triggers' },
        ]}
      />
      {tab === 'about' ? (
        <AboutTab channelId={channelId} onClose={onClose} />
      ) : tab === 'members' ? (
        <MembersTab channelId={channelId} />
      ) : (
        <VoiceTriggersTab channelId={channelId} />
      )}
    </Modal>
  )
}

function VoiceTriggersTab({ channelId }: { channelId: string }) {
  const channel = useStore((state) => state.channels.find((item) => item.id === channelId))
  const triggers = useStore((state) => state.channelVoiceTriggers[channelId])
  const loadTriggers = useStore((state) => state.loadChannelVoiceTriggers)
  const createTrigger = useStore((state) => state.createChannelVoiceTrigger)
  const deleteTrigger = useStore((state) => state.deleteChannelVoiceTrigger)
  const [loading, setLoading] = useState(triggers === undefined)

  useEffect(() => {
    if (triggers !== undefined) {
      setLoading(false)
      return
    }
    let active = true
    setLoading(true)
    loadTriggers(channelId)
      .catch((error: unknown) => {
        if (active && error instanceof Error) toastError(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [channelId, loadTriggers, triggers])

  const canEdit = channel?.my_role === 'owner' || channel?.my_role === 'editor'
  return (
    <VoiceTriggerEditor
      triggers={triggers ?? []}
      loading={loading}
      canEdit={canEdit}
      hint="When anyone’s live transcription in this call contains a phrase, sharp posts a GIF picked from the last messages. Active only while transcription is on."
      onAdd={async (phrase) => {
        await createTrigger(channelId, phrase)
      }}
      onDelete={async (triggerId) => {
        await deleteTrigger(channelId, triggerId)
      }}
    />
  )
}

function AboutTab({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
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
  const isOwner = channel.my_role === 'owner'

  const normalized = name.trim().toLowerCase()
  const nameValid = NAME_RE.test(normalized)
  const dirty =
    normalized !== channel.name || topic.trim() !== channel.topic || kind !== channel.kind
  const canSave = isOwner && nameValid && dirty && !busy

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
      <Field label="Name" hint="Lowercase letters, numbers, and hyphens. 1–50 chars.">
        <Input
          prefix="#"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!isOwner}
        />
      </Field>

      <Field label="Topic">
        <Input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          disabled={!isOwner}
          placeholder="What's this channel about?"
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-[var(--color-text-dim)]">Visibility</span>
        <div className="flex gap-2">
          <ChoiceCard
            selected={kind === 'public'}
            onSelect={() => setKind('public')}
            title="Public"
            description="Anyone can join"
            selectedStyle="fill"
            disabled={!isOwner}
            className="flex-1"
          />
          <ChoiceCard
            selected={kind === 'private'}
            onSelect={() => setKind('private')}
            title="Private"
            description="Invite only"
            selectedStyle="fill"
            disabled={!isOwner}
            className="flex-1"
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
            <span className="block text-2xs text-[var(--color-text-faint)]">
              {muted
                ? 'Muted — no unread badges, toasts, or push.'
                : 'Silence unread badges, toasts, and push for this channel.'}
            </span>
          </span>
          <span role="switch" aria-checked={muted}>
            <ToggleVisual checked={muted} />
          </span>
        </button>
      </div>

      {isOwner && (
        <div className="flex justify-end pt-1">
          <Button type="submit" className="px-4" disabled={!canSave}>
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}

      {isOwner && (
        <div className="mt-2 rounded-lg border border-danger-fg/30 bg-danger-soft p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-danger-fg">
            Danger zone
          </div>
          {confirmDelete ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-[var(--color-text-dim)]">
                Delete <span className="font-semibold">#{channel.name}</span> and all its
                messages and docs? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={doDelete} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Delete channel'}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(true)}
              className="border-danger-fg/40 text-danger-fg hover:bg-danger-soft hover:text-danger-fg"
            >
              Delete this channel
            </Button>
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
  const nicknames = useStore(effectiveNicknames)
  const me = useStore((s) => s.me)
  const loadMembers = useStore((s) => s.loadMembers)
  const addChannelMembers = useStore((s) => s.addChannelMembers)
  const removeChannelMember = useStore((s) => s.removeChannelMember)
  const setMemberRole = useStore((s) => s.setMemberRole)

  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    loadMembers(channelId)
  }, [channelId, loadMembers])

  const labelOf = (id: string, fallback: string) =>
    nicknames[id]?.trim() || fallback

  const memberRows = useMemo(
    () =>
      [...(members ?? [])].sort((a, b) =>
        labelOf(a.id, a.display_name).localeCompare(labelOf(b.id, b.display_name)),
      ),
    // labelOf closes over nicknames
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [members, nicknames],
  )
  const iAmOwner = channel?.my_role === 'owner'
  const ownersCount = (members ?? []).filter((member) => member.role === 'owner').length

  const candidates = useMemo(() => {
    const memberIds = new Set((members ?? []).map((m) => m.id))
    const q = query.trim().toLowerCase()
    return Object.values(users)
      .filter((u) => !memberIds.has(u.id))
      .filter((u) => {
        if (!q) return true
        const nick = nicknames[u.id]?.toLowerCase() ?? ''
        return u.display_name.toLowerCase().includes(q) || nick.includes(q)
      })
      .sort((a, b) =>
        labelOf(a.id, a.display_name).localeCompare(labelOf(b.id, b.display_name)),
      )
      .slice(0, 8)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [users, members, query, nicknames])

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

  async function changeRole(userId: string, role: 'owner' | 'editor' | 'viewer') {
    setPending(userId)
    try {
      await setMemberRole(channelId, userId, role)
    } catch {
      // Store rolls back optimistic state and surfaces the error.
    } finally {
      setPending(null)
    }
  }

  const loading = members === undefined

  return (
    <div className="flex flex-col gap-3">
      {iAmOwner && (
        <Field label="Add people" htmlFor="channel-add-people">
          <Input
            id="channel-add-people"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people to add…"
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
                      <div className="truncate text-sm font-medium">
                        {labelOf(u.id, u.display_name)}
                      </div>
                      {visibleEmail(u, me?.id) && (
                        <div className="truncate text-2xs text-[var(--color-text-faint)]">
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
        </Field>
      )}

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
            const isLastOwner = u.role === 'owner' && ownersCount === 1
            return (
              <div key={u.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                <Avatar id={u.id} name={u.display_name} size={30} />
                <div className="min-w-0 flex-1">
                  <UserChip
                    userId={u.id}
                    fallbackName={u.display_name}
                    className="truncate text-sm font-medium hover:underline"
                  >
                    {labelOf(u.id, u.display_name)}
                  </UserChip>
                  {visibleEmail(u, me?.id) && (
                    <div className="truncate text-2xs text-[var(--color-text-faint)]">
                      {visibleEmail(u, me?.id)}
                    </div>
                  )}
                </div>
                {iAmOwner ? (
                  <div className="flex items-center gap-1">
                    <Select
                      uiSize="sm"
                      surface="panel"
                      value={u.role}
                      disabled={pending === u.id || isLastOwner}
                      onChange={(e) =>
                        void changeRole(
                          u.id,
                          e.target.value as 'owner' | 'editor' | 'viewer',
                        )
                      }
                    >
                      <option value="owner">Owner</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </Select>
                    {!isLastOwner && (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={pending === u.id}
                        onClick={() => remove(u.id)}
                        className="text-[var(--color-text-dim)] hover:bg-danger-soft hover:text-danger-fg"
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ) : (
                  <span className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-faint)]">
                    {u.role.charAt(0).toUpperCase() + u.role.slice(1)}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
