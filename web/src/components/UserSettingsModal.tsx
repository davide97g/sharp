import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store'
import { api } from '../lib/api'
import type {
  ChannelNotifyMode,
  DuckContext,
  DuckCooldownSecs,
  GifSettings,
  GiphyUsage,
  VoiceTrigger,
  PasskeyRecord,
  E2eeBackup,
  E2eeDevice,
} from '../lib/types'
import { toastError, toastSuccess } from '../lib/toast'
import { ApiRequestError } from '../lib/api'
import {
  deleteLocalDevice,
  ensureDevice,
  fingerprint,
  getDevices,
  getLocalDevice,
  invalidateDevices,
  type LocalDevice,
} from '../lib/e2ee'
import { createBackup, restoreBackup } from '../lib/e2ee/backup'
import { isTauri, openPasskeyManagement } from '../lib/desktopAuth'
import { isPasskeyCancellation, registerPasskey, supportsPasskeys } from '../lib/passkeys'
import { getSoundSettings, setSoundSettings, sound, subscribeSoundSettings } from '../lib/sound'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { AvatarCropper } from './AvatarCropper'
import { ChatLayoutPicker } from './ChatLayoutChooser'
import { NotificationSetup } from './NotificationSetup'
import { Toggle } from './Toggle'
import { ThemePicker } from './ThemePicker'
import { NavigationPicker } from './NavigationPicker'
import { VoiceTriggerEditor } from './VoiceTriggerEditor'
import { setAudioAuraPreference, useAudioAuraPreference } from '../lib/meetingEffects'
import { AudioAuraPreview } from './voice/AudioAuraAvatar'
import { getThemePreset, setThemePreset, type ThemePreset } from '../lib/theme'

type Tab =
  | 'profile'
  | 'chat'
  | 'notifications'
  | 'appearance'
  | 'meetings'
  | 'security'
  | 'encryption'
  | 'workspace'
  | 'accounts'
  | 'about'

const SETTINGS_TABS: Tab[] = [
  'profile',
  'chat',
  'notifications',
  'appearance',
  'meetings',
  'accounts',
  'security',
  'encryption',
  'workspace',
  'about',
]

function isSettingsTab(value: string | undefined): value is Tab {
  return SETTINGS_TABS.includes(value as Tab)
}

export function UserSettingsPage() {
  return <UserSettingsModal page />
}

export function UserSettingsModal({
  onClose,
  initialTab,
  page = false,
}: {
  onClose?: () => void
  initialTab?: Tab
  page?: boolean
}) {
  const me = useStore((s) => s.me)
  const chatLayout = useStore((s) => s.chatLayout)
  const updateProfile = useStore((s) => s.updateProfile)
  const uploadAvatar = useStore((s) => s.uploadAvatar)
  const removeAvatar = useStore((s) => s.removeAvatar)
  const setChatLayout = useStore((s) => s.setChatLayout)
  const railPosition = useStore((s) => s.railPosition)
  const setRailPosition = useStore((s) => s.setRailPosition)
  const dockAutoHide = useStore((s) => s.dockAutoHide)
  const setDockAutoHide = useStore((s) => s.setDockAutoHide)

  const navigate = useNavigate()
  const location = useLocation()
  const { section } = useParams<{ section?: string }>()
  const [modalTab, setModalTab] = useState<Tab>(initialTab ?? 'profile')
  const tab = page && isSettingsTab(section) ? section : modalTab
  const [theme, setTheme] = useState<ThemePreset>(() => getThemePreset())
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

  function selectTab(next: Tab) {
    if (page) navigate(`/settings/${next}`, { replace: true, state: location.state })
    else setModalTab(next)
  }

  function closeSettings() {
    if (onClose) {
      onClose()
      return
    }
    const from = (location.state as { from?: unknown } | null)?.from
    navigate(typeof from === 'string' && from.startsWith('/') ? from : '/', { replace: true })
  }

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

  const content = tab === 'profile' ? (
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
                <Avatar id={me.id} name={me.display_name} size={72} nicknameCard={false} />
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
      ) : tab === 'notifications' ? (
        <NotificationsSettings />
      ) : tab === 'appearance' ? (
        <div className="flex flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            Theme
          </div>
          <ThemePicker
            value={theme}
            onChange={(preset) => {
              setTheme(preset)
              setThemePreset(preset)
            }}
          />
          <p className="text-[11px] text-[var(--color-text-faint)]">
            Saved on this device. Themes change colors only — layout stays the same.
          </p>
          <div className="mt-3 border-t border-[var(--color-border)] pt-5">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              Navigation
            </div>
            <NavigationPicker value={railPosition} onChange={setRailPosition} />
            {railPosition !== 'left' && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] px-3 py-2">
                <div>
                  <div className="text-sm font-medium text-[var(--color-text)]">
                    Automatically hide the dock
                  </div>
                  <div className="text-[11px] text-[var(--color-text-faint)]">
                    {railPosition === 'top'
                      ? 'The dock tucks into a notch. Move the cursor to the notch to show it.'
                      : 'The dock slides away. Move the cursor to the bottom edge to show it.'}
                  </div>
                </div>
                <DockAutoHideSwitch checked={dockAutoHide} onChange={setDockAutoHide} />
              </div>
            )}
            <p className="mt-3 text-[11px] text-[var(--color-text-faint)]">
              Desktop only. Mobile always uses its bottom tabs.
            </p>
          </div>
        </div>
      ) : tab === 'meetings' ? (
        <MeetingEffectsSettings userId={me.id} />
      ) : tab === 'accounts' ? (
        <AccountsTab />
      ) : tab === 'security' ? (
        <PasskeySecurityTab />
      ) : tab === 'encryption' ? (
        <EncryptionSettingsTab userId={me.id} />
      ) : tab === 'about' ? (
        <AboutTab />
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
      )

  if (page) {
    return (
      <SettingsPageShell
        activeTab={tab}
        email={me.email ?? ''}
        name={me.display_name}
        userId={me.id}
        onClose={closeSettings}
        onSelect={selectTab}
      >
        {content}
      </SettingsPageShell>
    )
  }

  return (
    <Modal title="Settings" onClose={closeSettings} wide>
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-[var(--color-border)]">
        {SETTINGS_TABS.map((item) => (
          <TabBtn key={item} active={tab === item} onClick={() => selectTab(item)}>
            {SETTINGS_META[item].label}
          </TabBtn>
        ))}
      </div>
      {content}
    </Modal>
  )
}

const SETTINGS_META: Record<Tab, { label: string; description: string; group: string }> = {
  profile: { label: 'My profile', description: 'How you appear across Sharp.', group: 'Personal' },
  chat: { label: 'Chat', description: 'Choose how conversations feel and flow.', group: 'Personal' },
  notifications: { label: 'Notifications', description: 'Control what alerts you, where, and when.', group: 'Personal' },
  appearance: { label: 'Appearance', description: 'Tune Sharp to your space and style.', group: 'Personal' },
  meetings: { label: 'Meetings', description: 'Control voice and meeting effects.', group: 'Personal' },
  accounts: { label: 'Connected accounts', description: 'Manage calendar connections and external accounts.', group: 'Account' },
  security: { label: 'Security', description: 'Protect your account with passkeys.', group: 'Account' },
  encryption: { label: 'Encryption', description: 'Manage trusted devices and encrypted backups.', group: 'Account' },
  workspace: { label: 'Workspace', description: 'Shared GIF and automation controls.', group: 'Workspace' },
  about: { label: 'About Sharp', description: 'Version details, updates, and product information.', group: 'Sharp' },
}

function SettingsPageShell({
  activeTab,
  children,
  email,
  name,
  onClose,
  onSelect,
  userId,
}: {
  activeTab: Tab
  children: React.ReactNode
  email: string
  name: string
  onClose: () => void
  onSelect: (tab: Tab) => void
  userId: string
}) {
  const logout = useStore((state) => state.logout)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
    document.getElementById('settings-content')?.scrollTo({ top: 0 })
  }, [activeTab])

  const groups = ['Personal', 'Account', 'Workspace', 'Sharp']

  return (
    <div className="settings-page flex min-h-0 flex-1 overflow-hidden bg-[var(--color-ink)] text-[var(--color-text)]">
      <aside className="hidden w-[18rem] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)] md:flex">
        <div className="border-b border-[var(--color-border)] px-6 pb-5 pt-[max(1.5rem,calc(var(--safe-top)+1rem))]">
          <div className="flex items-center gap-3">
            <Avatar id={userId} name={name} size={46} nicknameCard={false} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{name}</div>
              <div className="truncate text-xs text-[var(--color-text-faint)]">{email}</div>
            </div>
          </div>
        </div>
        <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          {groups.map((group) => (
            <div key={group} className="mb-5 last:mb-0">
              <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
                {group}
              </div>
              {SETTINGS_TABS.filter((item) => SETTINGS_META[item].group === group).map((item) => (
                <SettingsNavButton
                  key={item}
                  active={activeTab === item}
                  label={SETTINGS_META[item].label}
                  tab={item}
                  onClick={() => onSelect(item)}
                />
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-[var(--color-border)] p-4 pb-[max(1rem,var(--safe-bottom))]">
          <button
            type="button"
            onClick={logout}
            className="flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-sm font-medium text-[#ff8a80] outline-none transition-colors hover:bg-[#ff6b5f]/10 focus-visible:ring-2 focus-visible:ring-[#ff8a80]"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-[max(1rem,var(--safe-left))] pt-[max(0.75rem,var(--safe-top))] md:hidden">
          <div className="flex min-h-12 items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-dim)] outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <CloseIcon />
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">Settings</div>
              <div className="truncate text-xs text-[var(--color-text-faint)]">{name}</div>
            </div>
            <Avatar id={userId} name={name} size={34} nicknameCard={false} />
          </div>
          <label className="block pb-3 pt-2">
            <span className="sr-only">Settings section</span>
            <select
              value={activeTab}
              onChange={(event) => onSelect(event.target.value as Tab)}
              className="min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-base font-medium text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            >
              {SETTINGS_TABS.map((item) => (
                <option key={item} value={item}>{SETTINGS_META[item].label}</option>
              ))}
            </select>
          </label>
        </header>

        <main
          id="settings-content"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--color-ink)] px-[max(1rem,var(--safe-left))] pb-[max(2rem,var(--safe-bottom))] pr-[max(1rem,var(--safe-right))] md:px-10 md:pb-12 lg:px-16"
        >
          <div className="mx-auto w-full max-w-[48rem] pb-10 pt-7 md:pt-12">
            <div className="mb-8 flex items-start justify-between gap-6">
              <div>
                <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--color-accent-hover)]">
                  {SETTINGS_META[activeTab].group}
                </p>
                <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold tracking-tight outline-none md:text-3xl">
                  {SETTINGS_META[activeTab].label}
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--color-text-dim)]">
                  {SETTINGS_META[activeTab].description}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close settings"
                title="Close settings"
                className="hidden h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text-dim)] outline-none transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] md:flex"
              >
                <CloseIcon />
              </button>
            </div>
            <section className="settings-content-card rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.18)] sm:p-6">
              {children}
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}

function SettingsNavButton({ active, label, onClick, tab }: { active: boolean; label: string; onClick: () => void; tab: Tab }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`mb-0.5 flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]'
      }`}
    >
      <SettingsIcon tab={tab} />
      <span>{label}</span>
    </button>
  )
}

function SettingsIcon({ tab }: { tab: Tab }) {
  const paths: Record<Tab, React.ReactNode> = {
    profile: <><circle cx="12" cy="8" r="3" /><path d="M5 21a7 7 0 0 1 14 0" /></>,
    chat: <path d="M4 5h16v11H8l-4 4V5Z" />,
    notifications: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
    appearance: <><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></>,
    meetings: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
    accounts: <><circle cx="8" cy="8" r="3" /><path d="M2 20a6 6 0 0 1 12 0M16 8h6M19 5v6" /></>,
    security: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    encryption: <><path d="M12 3 5 6v5c0 4.5 2.8 8.2 7 10 4.2-1.8 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>,
    workspace: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {paths[tab]}
    </svg>
  )
}

function CloseIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="m6 6 12 12M18 6 6 18" /></svg>
}

function EncryptionSettingsTab({ userId }: { userId: string }) {
  const [local, setLocal] = useState<LocalDevice | null>(null)
  const [devices, setDevices] = useState<E2eeDevice[]>([])
  const [backup, setBackup] = useState<E2eeBackup | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePassphrase, setRestorePassphrase] = useState('')

  async function load() {
    setLoading(true)
    try {
      const current = await getLocalDevice()
      invalidateDevices(userId)
      const own = await getDevices(userId)
      let status: E2eeBackup | null = null
      try {
        status = await api.getBackup()
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 404) throw error
      }
      setLocal(current)
      setDevices(own)
      setBackup(status)
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not load encryption settings.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [userId])

  async function revoke(device: E2eeDevice) {
    if (!window.confirm(`Revoke “${device.name}”? That device will lose access to new encrypted messages.`)) return
    setBusy(true)
    try {
      await api.deleteDevice(device.id)
      if (device.id === local?.id) {
        await deleteLocalDevice()
        await ensureDevice()
      }
      invalidateDevices(userId)
      await load()
      toastSuccess('Device revoked.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not revoke device.')
    } finally {
      setBusy(false)
    }
  }

  async function saveBackup() {
    if (passphrase.length < 8) return toastError('Backup passphrase must be at least 8 characters.')
    if (passphrase !== confirmPassphrase) return toastError('Passphrases do not match.')
    setBusy(true)
    try {
      await createBackup(passphrase)
      setPassphrase('')
      setConfirmPassphrase('')
      await load()
      toastSuccess('Encryption backup saved.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not save encryption backup.')
    } finally {
      setBusy(false)
    }
  }

  async function restore() {
    if (!restorePassphrase) return
    setBusy(true)
    try {
      await restoreBackup(restorePassphrase)
      invalidateDevices(userId)
      setRestorePassphrase('')
      setRestoreOpen(false)
      await load()
      await useStore.getState().refreshDmEncryption(userId)
      toastSuccess('Encryption keys restored.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not restore encryption backup.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="py-10 text-center text-sm text-[var(--color-text-faint)]">Loading encryption settings…</div>
  const shortFingerprint = local
    ? fingerprint(local.x25519_pub, local.ed25519_pub, local.x25519_pub, local.ed25519_pub)
        .split(' ')
        .slice(0, 4)
        .join(' ')
    : 'Unavailable'

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">This device</div>
        {local ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3 text-sm">
            <dt className="text-[var(--color-text-faint)]">Name</dt><dd>{local.name}</dd>
            <dt className="text-[var(--color-text-faint)]">Fingerprint</dt><dd className="tracking-wider">{shortFingerprint}</dd>
            <dt className="text-[var(--color-text-faint)]">Device id</dt><dd className="truncate font-mono text-xs" title={local.id}>{local.id}</dd>
          </dl>
        ) : <p className="text-sm text-[var(--color-text-dim)]">No encryption identity on this browser.</p>}
      </section>

      <section>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">My devices</div>
        <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
          {devices.map((device) => (
            <div key={device.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0"><div className="truncate text-sm font-medium">{device.name}{device.id === local?.id ? ' · Current' : ''}</div><div className="text-[11px] text-[var(--color-text-faint)]">Added {new Date(device.created_at).toLocaleDateString()}</div></div>
              <button type="button" disabled={busy} onClick={() => void revoke(device)} className="shrink-0 text-xs text-red-400 disabled:opacity-50">Revoke</button>
            </div>
          ))}
          {!devices.length ? <div className="p-3 text-sm text-[var(--color-text-faint)]">No registered devices.</div> : null}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div><div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">Backup</div><p className="mt-1 text-xs text-[var(--color-text-dim)]">{backup ? `Saved ${new Date(backup.updated_at).toLocaleString()}` : 'No backup saved'}</p></div>
        <input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder={backup ? 'New passphrase' : 'Passphrase (8+ characters)'} className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm" />
        <input type="password" autoComplete="new-password" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} placeholder="Confirm passphrase" className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm" />
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !passphrase || !confirmPassphrase} onClick={() => void saveBackup()} className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Working…' : backup ? 'Change passphrase' : 'Set passphrase'}</button><button type="button" disabled={busy || !backup} onClick={() => setRestoreOpen((open) => !open)} className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm disabled:opacity-50">Restore from backup</button></div>
        {restoreOpen ? <div className="flex gap-2 rounded-lg border border-[var(--color-border)] p-3"><input type="password" autoComplete="current-password" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} placeholder="Backup passphrase" className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm" /><button type="button" disabled={busy || !restorePassphrase} onClick={() => void restore()} className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Restore</button></div> : null}
      </section>
    </div>
  )
}

function PasskeySecurityTab() {
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([])
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [name, setName] = useState('My passkey')
  const [password, setPassword] = useState('')
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const result = await api.passkeys()
      setEnabled(result.enabled)
      setPasskeys(result.passkeys)
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not load passkeys.')
    }
  }

  useEffect(() => { void load() }, [])

  async function add() {
    if (!name.trim() || !password || busy) return
    setBusy(true)
    try {
      await registerPasskey(name.trim(), password)
      setPassword('')
      await load()
    } catch (error) {
      if (!isPasskeyCancellation(error)) toastError(error instanceof Error ? error.message : 'Could not add passkey.')
    } finally {
      setBusy(false)
    }
  }

  async function rename(passkey: PasskeyRecord) {
    const next = window.prompt('Passkey name', passkey.name)?.trim()
    if (!next || next === passkey.name) return
    try {
      await api.renamePasskey(passkey.id, next)
      await load()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not rename passkey.')
    }
  }

  async function remove() {
    if (!removeId || !password || busy) return
    setBusy(true)
    try {
      await api.removePasskey(removeId, password)
      setPassword('')
      setRemoveId(null)
      await load()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not remove passkey.')
    } finally {
      setBusy(false)
    }
  }

  if (enabled === null) return <div className="py-10 text-center text-sm text-[var(--color-text-faint)]">Loading security settings…</div>
  if (!enabled) return <div className="text-sm text-[var(--color-text-dim)]">Passkeys are not configured on this Sharp server.</div>
  if (isTauri) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--color-text-dim)]">Manage passkeys in your system browser so Face ID, Touch ID, Windows Hello, and security keys can verify the Sharp server.</p>
        <button type="button" onClick={() => void openPasskeyManagement().catch((error) => toastError(error instanceof Error ? error.message : 'Could not open browser.'))} className="self-start rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white">Manage passkeys in browser</button>
      </div>
    )
  }
  if (!supportsPasskeys()) return <div className="text-sm text-[var(--color-text-dim)]">This browser cannot use passkeys. Open Sharp over HTTPS in a supported browser.</div>

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">Your passkeys</div>
        <p className="text-xs text-[var(--color-text-dim)]">Your password remains available for account recovery.</p>
      </div>
      {passkeys.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-text-faint)]">No passkeys enrolled.</div> : (
        <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
          {passkeys.map((passkey) => (
            <div key={passkey.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--color-text)]">{passkey.name}</div>
                <div className="text-[11px] text-[var(--color-text-faint)]">Added {new Date(passkey.created_at).toLocaleDateString()}{passkey.last_used_at ? ` · Last used ${new Date(passkey.last_used_at).toLocaleDateString()}` : ''}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => void rename(passkey)} className="text-xs text-[var(--color-accent-hover)]">Rename</button>
                <button type="button" onClick={() => { setRemoveId(passkey.id); setPassword('') }} className="text-xs text-red-400">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3">
        <div className="text-sm font-semibold">Add passkey</div>
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Passkey name" className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm" />
        <input type="password" autoComplete="current-password" value={removeId ? '' : password} onChange={(event) => setPassword(event.target.value)} placeholder="Confirm current password" disabled={removeId !== null} className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm disabled:opacity-40" />
        <button type="button" disabled={busy || !!removeId || !name.trim() || !password} onClick={() => void add()} className="self-start rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Working…' : 'Add passkey'}</button>
      </div>
      {removeId && (
        <div className="flex flex-col gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <div className="text-sm font-semibold">Remove passkey?</div>
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Confirm current password" className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm" />
          <div className="flex gap-2">
            <button type="button" disabled={busy || !password} onClick={() => void remove()} className="rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Remove</button>
            <button type="button" onClick={() => { setRemoveId(null); setPassword('') }} className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

function readSafeInset(side: 'top' | 'right' | 'bottom' | 'left'): string {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-${side},0px)`
  document.body.appendChild(el)
  const value = getComputedStyle(el).height
  el.remove()
  return value
}

function viewportDiagnostics() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return {
    window: `${window.innerWidth} × ${window.innerHeight}`,
    screen: `${screen.width} × ${screen.height}`,
    insets: `${readSafeInset('top')} / ${readSafeInset('right')} / ${readSafeInset('bottom')} / ${readSafeInset('left')}`,
    mode: standalone ? 'standalone (installed)' : 'browser tab',
  }
}

function AboutTab() {
  const [diag, setDiag] = useState(viewportDiagnostics)
  useEffect(() => {
    const update = () => setDiag(viewportDiagnostics())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)] text-lg font-extrabold text-white">
            #
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">sharp</div>
            <div className="text-[11px] text-[var(--color-text-faint)]">
              Self-hosted team chat, docs, canvas, and calls.
            </div>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-[var(--color-text-faint)]">Version</dt>
          <dd className="font-mono text-[13px] tabular-nums">{__APP_VERSION__}</dd>
          <dt className="text-[var(--color-text-faint)]">Build</dt>
          <dd className="break-all font-mono text-[13px]">{__BUILD_ID__}</dd>
        </dl>
      </div>
      <p className="text-[11px] leading-5 text-[var(--color-text-faint)]">
        The build id changes on every deploy. If it matches your latest deploy, this
        device is running the newest version — updates are picked up automatically
        within moments of reopening the app.
      </p>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Display diagnostics
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-[var(--color-text-faint)]">Window</dt>
          <dd className="font-mono text-[13px] tabular-nums">{diag.window}</dd>
          <dt className="text-[var(--color-text-faint)]">Screen</dt>
          <dd className="font-mono text-[13px] tabular-nums">{diag.screen}</dd>
          <dt className="text-[var(--color-text-faint)]">Safe insets</dt>
          <dd className="font-mono text-[13px] tabular-nums">{diag.insets}</dd>
          <dt className="text-[var(--color-text-faint)]">Mode</dt>
          <dd className="font-mono text-[13px]">{diag.mode}</dd>
        </dl>
        <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-faint)]">
          When installed on iOS, window height should match screen height and the
          top/bottom safe insets should be non-zero. A shorter window means iOS
          launched the app with a stale viewport — the app self-corrects; rotating
          the device once also forces it.
        </p>
      </div>
    </div>
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
            className="range-slider flex-1 disabled:cursor-default disabled:opacity-50"
            style={{
              // Filled portion up to the thumb, then the empty track color.
              background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-panel) ${pct}%)`,
            }}
          />
          <span className="w-10 text-right text-xs tabular-nums text-[var(--color-text-dim)]">
            {pct}%
          </span>
        </div>
      </div>
    </div>
  )
}

// ---- Notifications tab ----

const DEFAULT_QUIET_START = 22 * 60 // 22:00
const DEFAULT_QUIET_END = 7 * 60 // 07:00

function minutesToHHMM(min: number | null, fallback: number): string {
  const m = min ?? fallback
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(':').map((n) => Number(n))
  if (Number.isNaN(h) || Number.isNaN(m)) return 0
  return h * 60 + m
}

type DndModeChoice = 'off' | 'on' | 'scheduled'

function NotificationsSettings() {
  const dnd = useStore((s) => s.dnd)
  const dndScheduled = useStore((s) => s.dndScheduled)
  const dndStart = useStore((s) => s.dndStart)
  const dndEnd = useStore((s) => s.dndEnd)
  const setDnd = useStore((s) => s.setDnd)
  const updateNotifyPrefs = useStore((s) => s.updateNotifyPrefs)
  const notifyDm = useStore((s) => s.notifyDm)
  const notifyMention = useStore((s) => s.notifyMention)
  const notifyReply = useStore((s) => s.notifyReply)
  const notifyTask = useStore((s) => s.notifyTask)
  const notifyPoll = useStore((s) => s.notifyPoll)
  const channels = useStore((s) => s.channels)
  const channelModes = useStore((s) => s.channelModes)
  const setChannelMode = useStore((s) => s.setChannelMode)

  const dndMode: DndModeChoice = dnd ? 'on' : dndScheduled ? 'scheduled' : 'off'
  const tzOffset = -new Date().getTimezoneOffset() // minutes east of UTC

  async function selectDndMode(next: DndModeChoice) {
    if (next === 'off') {
      await Promise.all([setDnd(false), updateNotifyPrefs({ dnd_scheduled: false })])
    } else if (next === 'on') {
      await Promise.all([setDnd(true), updateNotifyPrefs({ dnd_scheduled: false })])
    } else {
      await Promise.all([
        setDnd(false),
        updateNotifyPrefs({
          dnd_scheduled: true,
          dnd_start: dndStart ?? DEFAULT_QUIET_START,
          dnd_end: dndEnd ?? DEFAULT_QUIET_END,
          tz_offset: tzOffset,
        }),
      ])
    }
  }

  const memberChannels = channels.filter((c) => c.is_member)

  const TYPES: { key: string; label: string; hint: string; value: boolean; field: string }[] = [
    { key: 'dm', label: 'Direct messages', hint: 'New messages in your DMs.', value: notifyDm, field: 'notify_dm' },
    { key: 'mention', label: 'Mentions & @all', hint: 'When someone @-mentions you or the channel.', value: notifyMention, field: 'notify_mention' },
    { key: 'reply', label: 'Thread replies', hint: 'Replies to threads you started.', value: notifyReply, field: 'notify_reply' },
    { key: 'task', label: 'Task activity', hint: 'Assigned a task or a new comment on one.', value: notifyTask, field: 'notify_task' },
    { key: 'poll', label: 'Poll results', hint: 'When a poll you created or voted in ends.', value: notifyPoll, field: 'notify_poll' },
  ]

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Delivery
        </div>
        <NotificationSetup />
        <p className="text-[11px] leading-5 text-[var(--color-text-faint)]">
          Push works on this website, installed PWAs (macOS &amp; iOS Home-Screen app), and the
          desktop app. Enable it once per device.
        </p>
      </section>

      <SoundSettingsSection />

      <section className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Do Not Disturb
        </div>
        <div className="flex flex-col gap-2">
          {(
            [
              { value: 'off', label: 'Off', hint: 'Deliver notifications normally.' },
              { value: 'on', label: 'On', hint: 'Silence all push, toasts, and sounds.' },
              { value: 'scheduled', label: 'Scheduled', hint: 'Quiet during set hours each day.' },
            ] as { value: DndModeChoice; label: string; hint: string }[]
          ).map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
            >
              <input
                type="radio"
                name="dnd-mode"
                checked={dndMode === opt.value}
                onChange={() => void selectDndMode(opt.value)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-sm font-medium text-[var(--color-text)]">{opt.label}</span>
                <span className="mt-0.5 block text-xs text-[var(--color-text-faint)]">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {dndMode === 'scheduled' && (
          <div className="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                From
              </span>
              <input
                type="time"
                value={minutesToHHMM(dndStart, DEFAULT_QUIET_START)}
                onChange={(e) =>
                  void updateNotifyPrefs({ dnd_start: hhmmToMinutes(e.target.value), tz_offset: tzOffset })
                }
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                To
              </span>
              <input
                type="time"
                value={minutesToHHMM(dndEnd, DEFAULT_QUIET_END)}
                onChange={(e) =>
                  void updateNotifyPrefs({ dnd_end: hhmmToMinutes(e.target.value), tz_offset: tzOffset })
                }
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
              />
            </label>
            <p className="min-w-[8rem] flex-1 text-[11px] leading-5 text-[var(--color-text-faint)]">
              Uses this device&rsquo;s time zone. Windows past midnight are fine.
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Notify me about
        </div>
        {TYPES.map((t) => (
          <label
            key={t.key}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
          >
            <input
              type="checkbox"
              checked={t.value}
              onChange={(e) => void updateNotifyPrefs({ [t.field]: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-[var(--color-text)]">{t.label}</span>
              <span className="mt-0.5 block text-xs text-[var(--color-text-faint)]">{t.hint}</span>
            </span>
          </label>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            Per-channel
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-faint)]">
            Override the defaults above for a specific conversation.
          </p>
        </div>
        {memberChannels.length === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">No channels yet.</p>
        ) : (
          <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {memberChannels.map((c) => {
              const label = c.kind === 'dm' ? c.dm_user?.display_name ?? 'Direct message' : `# ${c.name}`
              const mode = (channelModes[c.id] ?? 'all') as ChannelNotifyMode
              return (
                <div key={c.id} className="flex items-center justify-between gap-3 p-3">
                  <span className="min-w-0 truncate text-sm text-[var(--color-text)]">{label}</span>
                  <select
                    value={mode}
                    onChange={(e) => void setChannelMode(c.id, e.target.value as ChannelNotifyMode)}
                    className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                  >
                    <option value="all">All messages</option>
                    <option value="mentions">Mentions only</option>
                    <option value="muted">Muted</option>
                  </select>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function MeetingEffectsSettings({ userId }: { userId: string }) {
  const preference = useAudioAuraPreference(userId)
  const enabled = preference === true

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Speaking effects
        </div>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-faint)]">
          Optional visual effects shown during calls. Your microphone audio stays on device.
        </p>
      </div>
      <label className="group flex cursor-pointer items-center gap-4 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4 transition-colors hover:border-[#796cff]/45">
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-[radial-gradient(circle,#796cff22,transparent_70%)]">
          <AudioAuraPreview size={46} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-[var(--color-text)]">Audio Aura</span>
            <span className="rounded-full bg-[#796cff]/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.16em] text-[#a99fff]">
              Advanced
            </span>
          </span>
          <span id="audio-aura-setting-description" className="mt-1 block text-xs leading-5 text-[var(--color-text-faint)]">
            Speaking volume drives avatar bounce, plasma glow, and orbit speed.
          </span>
          <span className="mt-1 block text-[10px] font-medium text-[var(--color-text-dim)]">
            {preference === null ? 'Not decided — you will be asked once in a call.' : enabled ? 'On' : 'Off'}
          </span>
        </span>
        <span className="relative flex h-7 w-12 shrink-0 items-center rounded-full bg-[var(--color-border)] p-1 transition-colors has-[:checked]:bg-[#796cff]">
          <input
            type="checkbox"
            checked={enabled}
            aria-describedby="audio-aura-setting-description"
            onChange={(event) => setAudioAuraPreference(userId, event.target.checked)}
            className="peer sr-only"
          />
          <span className="h-5 w-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-5" />
        </span>
      </label>
      <p className="text-[11px] leading-5 text-[var(--color-text-faint)]">
        Honors your system’s reduced-motion preference by replacing movement with a static glow.
      </p>
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

function DockAutoHideSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return <Toggle checked={checked} onChange={onChange} label="Automatically hide the dock" />
}
