import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../Modal'
import { Avatar } from '../Avatar'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { toastError } from '../../lib/toast'
import type { Doc } from '../../lib/types'
import { visibleEmail } from '../../lib/util'

type EveryoneRole = 'editor' | 'viewer' | 'none'
type MemberRole = 'editor' | 'viewer' | 'none'

export function DocRolesModal({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const patchDoc = useStore((s) => s.patchDoc)
  const members = useStore((s) => s.members[doc.channel_id])
  const me = useStore((s) => s.me)
  const loadMembers = useStore((s) => s.loadMembers)
  // Per-user overrides keyed by user id. The server's roles endpoint only
  // returns explicit overrides, so members without one fall back to the
  // everyone_role — the modal lists every channel member regardless.
  const [overrides, setOverrides] = useState<Record<string, MemberRole>>({})
  const [loading, setLoading] = useState(true)
  const [everyoneRole, setEveryoneRole] = useState<EveryoneRole>(doc.everyone_role)

  useEffect(() => {
    loadMembers(doc.channel_id)
  }, [doc.channel_id, loadMembers])

  useEffect(() => {
    let cancelled = false
    api
      .docRoles(doc.id)
      .then((res) => {
        if (cancelled) return
        const map: Record<string, MemberRole> = {}
        for (const r of res.roles) map[r.user.id] = r.role as MemberRole
        setOverrides(map)
      })
      .catch((e) => {
        if (!cancelled && e instanceof Error) toastError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [doc.id])

  const rows = useMemo(
    () =>
      [...(members ?? [])].sort((a, b) => a.display_name.localeCompare(b.display_name)),
    [members],
  )

  async function changeEveryone(role: EveryoneRole) {
    const prev = everyoneRole
    setEveryoneRole(role)
    try {
      await patchDoc(doc.id, { everyone_role: role })
    } catch (e) {
      setEveryoneRole(prev)
      if (e instanceof Error) toastError(e.message)
    }
  }

  async function changeMember(userId: string, role: MemberRole) {
    const prev = overrides
    setOverrides((o) => ({ ...o, [userId]: role }))
    try {
      await api.putDocRole(doc.id, userId, role)
    } catch (e) {
      setOverrides(prev)
      if (e instanceof Error) toastError(e.message)
    }
  }

  const membersLoading = loading || members === undefined

  return (
    <Modal title="Permissions" onClose={onClose} wide>
      <div className="mb-4">
        <div className="mb-1.5 text-xs font-medium text-[var(--color-text-dim)]">
          Everyone in this channel
        </div>
        <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5">
          <span className="text-sm">Default access</span>
          <RoleSelect
            value={everyoneRole}
            onChange={(v) => changeEveryone(v as EveryoneRole)}
          />
        </div>
      </div>

      <div className="mb-1.5 text-xs font-medium text-[var(--color-text-dim)]">Members</div>
      {membersLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="skeleton h-11 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="max-h-[45vh] space-y-1 overflow-y-auto">
          {rows.map((u) => {
            const isCreator = u.id === doc.created_by
            const role = overrides[u.id] ?? everyoneRole
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
                  <RoleSelect
                    value={role}
                    onChange={(v) => changeMember(u.id, v as MemberRole)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}

function RoleSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-sm focus:border-[var(--color-accent)] focus:outline-none"
    >
      <option value="editor">Can edit</option>
      <option value="viewer">Can view</option>
      <option value="none">No access</option>
    </select>
  )
}
