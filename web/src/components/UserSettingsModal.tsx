import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import type {
  DuckContext,
  DuckCooldownSecs,
  GifSettings,
  GiphyUsage,
  VoiceTrigger,
} from '../lib/types'
import { toastError } from '../lib/toast'
import { isTauri } from '../lib/desktopAuth'
import { getSoundSettings, setSoundSettings, sound, subscribeSoundSettings } from '../lib/sound'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { AvatarCropper } from './AvatarCropper'
import { ChatLayoutPicker } from './ChatLayoutChooser'
import { VoiceTriggerEditor } from './VoiceTriggerEditor'

type Tab = 'profile' | 'chat' | 'workspace' | 'accounts'

export function UserSettingsModal({
  onClose,
  initialTab,
}: {
  onClose: () => void
  initialTab?: Tab
}) {
  const me = useStore((s) => s.me)
  const chatLayout = useStore((s) => s.chatLayout)
  const updateProfile = useStore((s) => s.updateProfile)
  const uploadAvatar = useStore((s) => s.uploadAvatar)
  const removeAvatar = useStore((s) => s.removeAvatar)
  const setChatLayout = useStore((s) => s.setChatLayout)

  const [tab, setTab] = useState<Tab>(initialTab ?? 'profile')
  const [name, setName] = useState(me?.display_name ?? '')
  const [savingName, setSavingName] = useState(false)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const [gifSettings, setGifSettings] = useState<GifSettings | null>(null)
  const [savedGifSettings, setSavedGifSettings] = useState<GifSettings | null>(null)
  const [gifLoadAttempted, setGifLoadAttempted] = useState(false)
  const [gifLoading, setGifLoading] = useState(false)
  const [gifSaving, setGifSaving] = useState(false)
  const [gifApiKey, setGifApiKey] = useState('')
  const [gifSaved, setGifSaved] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const gifSavedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    if (tab !== 'workspace' || gifLoadAttempted) return
    setGifLoadAttempted(true)
    setGifLoading(true)
    api
      .getGifSettings()
      .then((settings) => {
        if (!mountedRef.current) return
        setGifSettings(settings)
        setSavedGifSettings(settings)
      })
      .catch((error: unknown) => {
        if (mountedRef.current && error instanceof Error) toastError(error.message)
      })
      .finally(() => {
        if (mountedRef.current) setGifLoading(false)
      })
  }, [gifLoadAttempted, tab])

  // Keep GIPHY usage fresh while the workspace tab is open.
  useEffect(() => {
    if (tab !== 'workspace' || !gifSettings) return
    const refresh = () => {
      api
        .getGifSettings()
        .then((settings) => {
          if (!mountedRef.current) return
          setGifSettings((prev) =>
            prev
              ? {
                  ...prev,
                  giphy_usage: settings.giphy_usage,
                  deepseek_configured: settings.deepseek_configured,
                  has_api_key: settings.has_api_key,
                }
              : settings,
          )
          setSavedGifSettings((prev) =>
            prev
              ? {
                  ...prev,
                  giphy_usage: settings.giphy_usage,
                  deepseek_configured: settings.deepseek_configured,
                  has_api_key: settings.has_api_key,
                }
              : settings,
          )
        })
        .catch(() => {
          /* ignore background refresh errors */
        })
    }
    const id = window.setInterval(refresh, 15_000)
    return () => window.clearInterval(id)
  }, [tab, gifSettings?.provider])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (gifSavedTimerRef.current) clearTimeout(gifSavedTimerRef.current)
    }
  }, [])

  if (!me) return null
  const nameDirty = name.trim() !== me.display_name && name.trim().length > 0

  async function saveName() {
    if (!nameDirty) return
    setSavingName(true)
    try {
      await updateProfile({ display_name: name.trim() })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setSavingName(false)
    }
  }

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!f) return
    if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') {
      toastError('Please choose a raster image (png/jpeg/webp/gif).')
      return
    }
    setCropFile(f)
  }

  async function onCropped(blob: Blob) {
    setSavingAvatar(true)
    try {
      await uploadAvatar(blob)
      setCropFile(null)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setSavingAvatar(false)
    }
  }

  async function onRemove() {
    setSavingAvatar(true)
    try {
      await removeAvatar()
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setSavingAvatar(false)
    }
  }

  function showGifSaved() {
    setGifSaved(true)
    if (gifSavedTimerRef.current) clearTimeout(gifSavedTimerRef.current)
    gifSavedTimerRef.current = setTimeout(() => setGifSaved(false), 1600)
  }

  async function updateGifSettings(body: {
    provider?: string
    api_key?: string
    duck_enabled?: boolean
    duck_cooldown_secs?: DuckCooldownSecs
    duck_context?: DuckContext
  }) {
    setGifSaving(true)
    try {
      const settings = await api.putGifSettings(body)
      setGifSettings(settings)
      setSavedGifSettings(settings)
      setGifApiKey('')
      await useStore.getState().refreshGifConfig()
      showGifSaved()
    } catch (error) {
      if (error instanceof Error) toastError(error.message)
    } finally {
      setGifSaving(false)
    }
  }

  async function saveGifSettings() {
    if (!gifSettings || !savedGifSettings) return
    const body: {
      provider?: string
      api_key?: string
      duck_enabled?: boolean
      duck_cooldown_secs?: DuckCooldownSecs
      duck_context?: DuckContext
    } = {}
    if (gifSettings.provider !== savedGifSettings.provider) body.provider = gifSettings.provider
    if (gifSettings.duck_enabled !== savedGifSettings.duck_enabled) {
      body.duck_enabled = gifSettings.duck_enabled
    }
    if (gifSettings.duck_cooldown_secs !== savedGifSettings.duck_cooldown_secs) {
      body.duck_cooldown_secs = gifSettings.duck_cooldown_secs
    }
    if (gifSettings.duck_context !== savedGifSettings.duck_context) {
      body.duck_context = gifSettings.duck_context
    }
    if (gifApiKey) body.api_key = gifApiKey
    await updateGifSettings(body)
  }

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="mb-4 flex gap-1 border-b border-[var(--color-border)]">
        <TabBtn active={tab === 'profile'} onClick={() => setTab('profile')}>
          Profile
        </TabBtn>
        <TabBtn active={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat
        </TabBtn>
        <TabBtn active={tab === 'accounts'} onClick={() => setTab('accounts')}>
          Accounts
        </TabBtn>
        <TabBtn active={tab === 'workspace'} onClick={() => setTab('workspace')}>
          Workspace
        </TabBtn>
      </div>

      {tab === 'profile' ? (
        <div className="flex flex-col gap-5">
          {/* avatar */}
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              Profile picture
            </div>
            {cropFile ? (
              <AvatarCropper
                file={cropFile}
                busy={savingAvatar}
                onCancel={() => setCropFile(null)}
                onDone={onCropped}
              />
            ) : (
              <div className="flex items-center gap-4">
                <Avatar id={me.id} name={me.display_name} size={72} />
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={savingAvatar}
                    className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                  >
                    Upload photo
                  </button>
                  {me.avatar_url && (
                    <button
                      onClick={onRemove}
                      disabled={savingAvatar}
                      className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] disabled:opacity-50"
                    >
                      Remove photo
                    </button>
                  )}
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={pickFile}
                />
              </div>
            )}
          </div>

          {/* display name */}
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              Display name
            </label>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                onKeyDown={(e) => e.key === 'Enter' && saveName()}
                className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
              />
              <button
                onClick={saveName}
                disabled={!nameDirty || savingName}
                className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                {savingName ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>

          <SoundSettingsSection />

          <PersonalVoiceTriggers />

          <div className="text-[11px] text-[var(--color-text-faint)]">
            Signed in as {me.email}
          </div>
        </div>
      ) : tab === 'chat' ? (
        <div className="flex flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            Direct message layout
          </div>
          <ChatLayoutPicker value={chatLayout} onChange={(l) => void setChatLayout(l)} />
          <p className="text-[11px] text-[var(--color-text-faint)]">
            Applies to 1:1 conversations. Channels always use the classic layout.
          </p>
        </div>
      ) : tab === 'accounts' ? (
        <AccountsTab />
      ) : !gifLoadAttempted || gifLoading ? (
        <div
          className="flex min-h-48 items-center justify-center text-[var(--color-text-faint)]"
          aria-label="Loading GIF settings"
        >
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]" />
        </div>
      ) : !gifSettings ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-[var(--color-text-dim)]">
          <span>Could not load GIF settings.</span>
          <button
            type="button"
            onClick={() => setGifLoadAttempted(false)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 hover:bg-[var(--color-panel-2)]"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            GIFs
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              Provider
            </label>
            <select
              value={gifSettings.provider}
              onChange={(event) =>
                setGifSettings((settings) =>
                  settings ? { ...settings, provider: event.target.value } : settings,
                )
              }
              className="w-full cursor-default rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text-dim)] opacity-80 focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            >
              <option value="giphy">GIPHY</option>
              <option value="tenor">Tenor (legacy — no new API clients)</option>
            </select>
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              API key
            </label>
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={gifApiKey}
                onChange={(event) => setGifApiKey(event.target.value)}
                placeholder={
                  gifSettings.has_api_key
                    ? '•••••••• (saved)'
                    : gifSettings.provider === 'tenor'
                      ? 'Tenor API key'
                      : 'GIPHY API key'
                }
                className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
              />
              {gifSettings.has_api_key ? (
                <button
                  type="button"
                  disabled={gifSaving}
                  onClick={() => void updateGifSettings({ api_key: '' })}
                  className="shrink-0 text-xs text-[var(--color-text-faint)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-text-dim)] disabled:opacity-50"
                >
                  Clear key
                </button>
              ) : null}
            </div>
          </div>

          {gifSettings.provider === 'giphy' && gifSettings.giphy_usage ? (
            <GiphyUsageBar usage={gifSettings.giphy_usage} />
          ) : null}

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
            <input
              type="checkbox"
              checked={gifSettings.duck_enabled}
              onChange={(event) =>
                setGifSettings((settings) =>
                  settings ? { ...settings, duck_enabled: event.target.checked } : settings,
                )
              }
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-[var(--color-text)]">
                Duck GIF suggestions
              </span>
              <span className="mt-1 block text-xs text-[var(--color-text-faint)]">
                An AI duck watches fast chat streaks and suggests a roast GIF.
              </span>
            </span>
          </label>

          {gifSettings.duck_enabled ? (
            <>
              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                  Suggestion slow mode
                </label>
                <select
                  value={gifSettings.duck_cooldown_secs}
                  onChange={(event) =>
                    setGifSettings((settings) =>
                      settings
                        ? {
                            ...settings,
                            duck_cooldown_secs: Number(event.target.value) as DuckCooldownSecs,
                          }
                        : settings,
                    )
                  }
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
                >
                  <option value={30}>30 seconds</option>
                  <option value={60}>1 minute</option>
                  <option value={120}>2 minutes</option>
                  <option value={300}>5 minutes</option>
                </select>
                <p className="mt-1.5 text-xs text-[var(--color-text-faint)]">
                  Minimum wait between duck suggestions in a channel.
                </p>
              </div>

              <div>
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                  Suggestion context
                </label>
                <select
                  value={gifSettings.duck_context}
                  onChange={(event) =>
                    setGifSettings((settings) =>
                      settings
                        ? {
                            ...settings,
                            duck_context: event.target.value as DuckContext,
                          }
                        : settings,
                    )
                  }
                  className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
                >
                  <option value="1m">Last 1 minute</option>
                  <option value="2m">Last 2 minutes</option>
                  <option value="3m">Last 3 minutes</option>
                </select>
                <p className="mt-1.5 text-xs text-[var(--color-text-faint)]">
                  How much recent chat the duck reads when picking a GIF.
                </p>
              </div>
            </>
          ) : null}

          <div className="rounded-lg border border-[var(--color-border)] px-3 py-2.5 text-sm text-[var(--color-text-dim)]">
            DeepSeek (duck AI):{' '}
            {gifSettings.deepseek_configured
              ? 'configured'
              : 'not configured — set DEEPSEEK_API_KEY on the server'}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void saveGifSettings()}
              disabled={gifSaving}
              className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
            >
              {gifSaving ? 'Saving…' : 'Save'}
            </button>
            {gifSaved ? <span className="text-xs text-[var(--color-text-dim)]">Saved</span> : null}
          </div>

          <p className="text-[11px] text-[var(--color-text-faint)]">
            Workspace-wide settings — every member can edit them.
          </p>
        </div>
      )}
    </Modal>
  )
}

function AccountsTab() {
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
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Connected calendars
        </div>

        {loading ? (
          <div className="flex min-h-24 items-center justify-center text-[var(--color-text-faint)]">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]" />
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
                      conn.status === 'active' ? 'bg-[#66c7aa]' : 'bg-[#ff6b5f]'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)]">
                    {conn.provider_email}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
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
                    <button
                      type="button"
                      onClick={() => void connectGoogle()}
                      disabled={connecting}
                      className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                    >
                      Reconnect
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void disconnect(conn.id)}
                    disabled={busyId === conn.id}
                    className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => void connectGoogle()}
        disabled={connecting}
        className="flex items-center justify-center gap-2 self-start rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
      >
        {connecting ? 'Opening Google…' : 'Connect Google Calendar'}
      </button>

      <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-[11px] leading-5 text-[var(--color-text-faint)]">
        Note: a Google Cloud consent screen left in “Testing” mode expires refresh
        tokens after 7 days — publish it to production (or use an Internal app) to
        keep calendars synced.
      </p>
    </div>
  )
}

function PersonalVoiceTriggers() {
  const [triggers, setTriggers] = useState<VoiceTrigger[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    api.voiceTriggers
      .listPersonal()
      .then(({ triggers }) => {
        if (active) setTriggers(triggers)
      })
      .catch((error: unknown) => {
        if (active && error instanceof Error) toastError(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <VoiceTriggerEditor
      triggers={triggers}
      loading={loading}
      canEdit
      hint="When your live transcription in a call contains a phrase, sharp posts a GIF picked from the last messages. Active only while transcription is on."
      onAdd={async (phrase) => {
        const trigger = await api.voiceTriggers.createPersonal(phrase)
        setTriggers((current) => [...current, trigger])
      }}
      onDelete={async (triggerId) => {
        await api.voiceTriggers.deletePersonal(triggerId)
        setTriggers((current) => current.filter((trigger) => trigger.id !== triggerId))
      }}
    />
  )
}

function formatResetRemaining(resetsAt: string | null, nowMs: number): string {
  if (!resetsAt) return 'Ready'
  const ms = new Date(resetsAt).getTime() - nowMs
  if (ms <= 0) return 'soon'
  const totalSec = Math.ceil(ms / 1000)
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins >= 60) {
    const hours = Math.floor(mins / 60)
    const remMins = mins % 60
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`
  }
  if (mins > 0) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  return `${secs}s`
}

function GiphyUsageBar({ usage }: { usage: GiphyUsage }) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const limit = Math.max(1, usage.limit)
  const used = Math.min(usage.used, limit)
  const pct = Math.round((used / limit) * 1000) / 10
  const atLimit = used >= limit
  const resetLabel = formatResetRemaining(usage.resets_at, nowMs)

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          GIPHY usage
        </span>
        <span
          className={`text-xs tabular-nums ${
            atLimit ? 'text-amber-400' : 'text-[var(--color-text-dim)]'
          }`}
        >
          {used} / {limit} searches
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-[var(--color-panel)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-label="GIPHY hourly search usage"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            atLimit
              ? 'bg-amber-400'
              : pct >= 80
                ? 'bg-[var(--color-accent-hover)]'
                : 'bg-[var(--color-accent)]'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--color-text-faint)]">
        <span>Sliding 1-hour window · free-tier cap</span>
        <span className="tabular-nums">
          {usage.used === 0
            ? 'No searches yet'
            : atLimit
              ? `Resets in ${resetLabel}`
              : `Next free slot in ${resetLabel}`}
        </span>
      </div>
    </div>
  )
}

function SoundSettingsSection() {
  const settings = useSyncExternalStore(
    subscribeSoundSettings,
    getSoundSettings,
    getSoundSettings,
  )
  const pct = Math.round(settings.volume * 100)
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
        Sounds
      </div>
      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => {
            setSoundSettings({ enabled: e.target.checked })
            if (e.target.checked) sound.previewTick()
          }}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-sm font-medium text-[var(--color-text)]">
            Interface sounds
          </span>
          <span className="mt-1 block text-xs text-[var(--color-text-faint)]">
            Crisp synthesized cues for messages, calls, and navigation.
          </span>
        </span>
      </label>
      <div>
        <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Volume
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            value={pct}
            disabled={!settings.enabled}
            onChange={(e) => {
              setSoundSettings({ volume: Number(e.target.value) / 100 })
              // Preview at the new level so dragging is audible feedback.
              sound.previewTick()
            }}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--color-panel)] accent-[var(--color-accent)] disabled:cursor-default disabled:opacity-50"
          />
          <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-dim)]">
            {pct}%
          </span>
        </div>
      </div>
    </div>
  )
}

function TabBtn({
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
          : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]'
      }`}
    >
      {children}
    </button>
  )
}
