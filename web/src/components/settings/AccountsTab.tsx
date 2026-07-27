// Settings → Connected accounts: social sign-in providers, plus Google Calendar.
//
// Contract: docs/arch/01-core.md ("Social sign-in") and docs/arch/07-calendar.md. Both
// halves are inert when their OAuth client is unconfigured, like every optional
// integration — the two are independent, so a server can offer either alone.

import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { toastError, toastSuccess } from '../../lib/toast'
import { isTauri } from '../../lib/desktopAuth'
import type { LinkedAccounts, OAuthConfig, OAuthProvider } from '../../lib/types'
import { PROVIDER_LABEL, PROVIDER_ORDER, ProviderMark } from '../auth/ProviderMark'
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

  /** Open an OAuth consent URL wherever the user can actually complete it. */
  async function openConsent(url: string) {
    if (isTauri) {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }

  async function connectGoogle() {
    setConnecting(true)
    try {
      const { url } = await api.calendar.googleConnectUrl()
      await openConsent(url)
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
      <SignInAccounts openConsent={openConsent} />

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

/**
 * Sign-in providers connected to this account.
 *
 * Connecting runs in a separate tab (the provider's consent screen), so the list is
 * refetched when the window regains focus — that tab is where the change happens,
 * and there's no event to listen for on this side.
 */
function SignInAccounts({ openConsent }: { openConsent: (url: string) => Promise<void> }) {
  const [available, setAvailable] = useState<OAuthConfig>({ google: false, github: false })
  const [linked, setLinked] = useState<LinkedAccounts | null>(null)
  const [busy, setBusy] = useState<OAuthProvider | null>(null)

  const reload = useCallback(async () => {
    try {
      setLinked(await api.oauthAccounts())
    } catch {
      // A transient failure here shouldn't blank the calendar section below.
    }
  }, [])

  useEffect(() => {
    api.oauthConfig().then(setAvailable).catch(() => {})
    void reload()
    const onFocus = () => void reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [reload])

  const offered = PROVIDER_ORDER.filter((p) => available[p])
  const connected = linked?.accounts ?? []
  // Nothing configured on the server and nothing left over from before: stay silent.
  if (offered.length === 0 && connected.length === 0) return null

  async function connect(provider: OAuthProvider) {
    setBusy(provider)
    try {
      const { url } = await api.oauthLinkUrl(provider)
      await openConsent(url)
    } catch (e) {
      toastError(e instanceof Error ? e.message : `Could not start ${PROVIDER_LABEL[provider]}.`)
    } finally {
      setBusy(null)
    }
  }

  async function disconnect(provider: OAuthProvider) {
    if (!window.confirm(`Disconnect ${PROVIDER_LABEL[provider]} from this account?`)) return
    setBusy(provider)
    try {
      await api.oauthUnlink(provider)
      toastSuccess(`${PROVIDER_LABEL[provider]} disconnected.`)
      await reload()
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not disconnect.')
    } finally {
      setBusy(null)
    }
  }

  // Anything the server no longer offers but is still linked stays listed, so it can
  // always be removed.
  const rows = Array.from(new Set([...offered, ...connected.map((a) => a.provider)]))

  return (
    <div>
      <SectionLabel size="xs" className="mb-2 block">Sign in with</SectionLabel>

      <div className="space-y-2">
        {rows.map((provider) => {
          const account = connected.find((a) => a.provider === provider)
          return (
            <div
              key={provider}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
            >
              <ProviderMark provider={provider} size={18} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--color-text)]">
                  {PROVIDER_LABEL[provider]}
                </div>
                <div className="truncate text-2xs text-[var(--color-text-faint)]">
                  {account ? account.email ?? 'Connected' : 'Not connected'}
                </div>
              </div>
              {account ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busy === provider}
                  onClick={() => void disconnect(provider)}
                >
                  Disconnect
                </Button>
              ) : (
                <Button
                  size="xs"
                  disabled={busy === provider || !available[provider]}
                  onClick={() => void connect(provider)}
                >
                  Connect
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {linked && !linked.has_password && (
        <p className="mt-2 text-2xs leading-5 text-[var(--color-text-faint)]">
          This account has no password — it signs in through the provider above. Use
          “Forgot password?” on the sign-in screen to add one.
        </p>
      )}
    </div>
  )
}
