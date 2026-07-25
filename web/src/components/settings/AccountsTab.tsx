// Settings → Connected accounts (Google Calendar today).
//
// Contract: docs/arch/07-calendar.md. Inert when Google OAuth is unconfigured, like every
// optional integration.

import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { isTauri } from '../../lib/desktopAuth'
import { Button, SectionLabel, Spinner } from '../../ui'


export function AccountsTab() {
  const connections = useStore((s) => s.calendarConnections)
  const loadCalendarConnections = useStore((s) => s.loadCalendarConnections)
  const [loading, setLoading] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void loadCalendarConnections().finally(() => setLoading(false))
  }, [loadCalendarConnections])

  async function connectGoogle() {
    setConnecting(true)
    try {
      const { url } = await api.calendar.googleConnectUrl()
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-shell')
        await open(url)
      } else {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not start Google sign-in.')
    } finally {
      setConnecting(false)
    }
  }

  async function disconnect(id: string) {
    setBusyId(id)
    try {
      await api.calendar.disconnect(id)
      await loadCalendarConnections()
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not disconnect.')
    } finally {
      setBusyId(null)
    }
  }

  async function toggleCalendar(calId: string, selected: boolean) {
    setBusyId(calId)
    try {
      await api.calendar.setCalendarSelected(calId, selected)
      await loadCalendarConnections()
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not update calendar.')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel size="xs" className="mb-2 block">Connected calendars</SectionLabel>

        {loading ? (
          <div className="flex min-h-24 items-center justify-center text-[var(--color-text-faint)]">
            <Spinner />
          </div>
        ) : connections.length === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">
            No calendar accounts connected yet.
          </p>
        ) : (
          <div className="space-y-3">
            {connections.map((conn) => (
              <div
                key={conn.id}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      conn.status === 'active' ? 'bg-success' : 'bg-danger'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)]">
                    {conn.provider_email}
                  </span>
                  <span className="shrink-0 text-2xs text-[var(--color-text-faint)]">
                    {conn.status === 'active' ? 'Active' : 'Needs reconnect'}
                  </span>
                </div>

                {conn.calendars.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-[var(--color-border)] pt-2">
                    {conn.calendars.map((cal) => (
                      <label
                        key={cal.id}
                        className="flex cursor-pointer items-center gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          checked={cal.selected}
                          disabled={busyId === cal.id || conn.status !== 'active'}
                          onChange={(e) => void toggleCalendar(cal.id, e.target.checked)}
                          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                        />
                        <span
                          aria-hidden
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ background: cal.color ?? 'var(--color-text-faint)' }}
                        />
                        <span className="truncate text-[var(--color-text-dim)]">
                          {cal.summary || 'Calendar'}
                        </span>
                      </label>
                    ))}
                  </div>
                )}

                <div className="mt-2 flex items-center gap-2">
                  {conn.status === 'invalid' && (
                    <Button size="xs" onClick={() => void connectGoogle()} disabled={connecting}>
                      Reconnect
                    </Button>
                  )}
                  <Button variant="outline" size="xs" onClick={() => void disconnect(conn.id)} disabled={busyId === conn.id}>
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Button className="self-start" onClick={() => void connectGoogle()} disabled={connecting}>
        {connecting ? 'Opening Google…' : 'Connect Google Calendar'}
      </Button>

      <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-2xs leading-5 text-[var(--color-text-faint)]">
        Note: a Google Cloud consent screen left in “Testing” mode expires refresh
        tokens after 7 days — publish it to production (or use an Internal app) to
        keep calendars synced.
      </p>
    </div>
  )
}
