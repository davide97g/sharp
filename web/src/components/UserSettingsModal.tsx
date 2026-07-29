// The settings shell: tab registry, navigation, and the profile + workspace panes.
//
// Each tab's body lives in ./settings/<Name>.tsx — this file owns only the chrome and the
// `Tab` union, which is the single list every part of the UI agrees on. Adding a tab means
// three edits here (the union, SETTINGS_TABS, SETTINGS_META) plus the new file; the union
// makes a missing entry a type error rather than a blank pane.
//
// Rendered two ways from the same component: as a modal over the app, and as a full page
// at /settings/:tab (mobile, and deep links from notifications). The route is the source
// of truth for the active tab so both stay linkable.
//
// Guardrail: presentation preferences go through `patchUi` into the synced blob; anything
// the *server* must honour (notification types, DND, privacy) is a real column and goes
// through its own endpoint. See server/src/routes/prefs.rs for which is which.

import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore, streamShieldOn } from '../store'
import { api } from '../lib/api'
import type {
  DuckContext,
  DuckCooldownSecs,
  GifSettings,
} from '../lib/types'
import { toastError } from '../lib/toast'
import { Button, CheckIcon, ChevronDownIcon, Input, Select, SectionLabel, Sheet, Spinner } from '../ui'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { AvatarCropper } from './AvatarCropper'
import { AboutTab } from './settings/AboutTab'
import { AccountsTab } from './settings/AccountsTab'
import { AppearanceSettings } from './settings/AppearanceSettings'
import { ChatSettings } from './settings/ChatSettings'
import { MeetingEffectsSettings } from './settings/MeetingEffectsSettings'
import { NotificationsSettings } from './settings/NotificationsSettings'
import { PrivacySettings } from './settings/PrivacySettings'
import { EncryptionSettingsTab, PasskeySecurityTab } from './settings/SecuritySettings'
import { StreamingSettings } from './settings/StreamingSettings'
import { GiphyUsageBar, PersonalVoiceTriggers } from './settings/WorkspaceSettings'

export type Tab =
  | 'profile'
  | 'chat'
  | 'notifications'
  | 'appearance'
  | 'meetings'
  | 'streaming'
  | 'privacy'
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
  'streaming',
  'privacy',
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

  const navigate = useNavigate()
  const location = useLocation()
  const { section } = useParams<{ section?: string }>()
  const [modalTab, setModalTab] = useState<Tab>(initialTab ?? 'profile')
  const tab = page && isSettingsTab(section) ? section : modalTab
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
            <SectionLabel size="xs" className="mb-2">Profile picture</SectionLabel>
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
                  <Button size="sm" onClick={() => fileRef.current?.click()} disabled={savingAvatar}>
                    Upload photo
                  </Button>
                  {me.avatar_url && (
                    <Button variant="outline" size="sm" onClick={onRemove} disabled={savingAvatar}>
                      Remove photo
                    </Button>
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
            <SectionLabel as="label" size="xs" className="mb-2 block">Display name</SectionLabel>
            <div className="flex gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                onKeyDown={(e) => e.key === 'Enter' && saveName()}
                className="flex-1"
              />
              <Button onClick={saveName} disabled={!nameDirty || savingName}>
                {savingName ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>

          <PersonalVoiceTriggers />

          <div className="text-2xs text-[var(--color-text-faint)]">
            Signed in as <MaskedEmail email={me.email ?? ''} />
          </div>
        </div>
      ) : tab === 'chat' ? (
        <ChatSettings
          chatLayout={chatLayout}
          onChatLayout={(l) => void setChatLayout(l)}
        />
      ) : tab === 'notifications' ? (
        <NotificationsSettings />
      ) : tab === 'appearance' ? (
        <AppearanceSettings />
      ) : tab === 'meetings' ? (
        <MeetingEffectsSettings userId={me.id} />
      ) : tab === 'privacy' ? (
        <PrivacySettings onOpen={(next) => (page ? navigate(`/settings/${next}`) : setModalTab(next))} />
      ) : tab === 'streaming' ? (
        <StreamingSettings />
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
          <Spinner />
        </div>
      ) : !gifSettings ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-[var(--color-text-dim)]">
          <span>Could not load GIF settings.</span>
          <Button variant="outline" size="sm" onClick={() => setGifLoadAttempted(false)}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <SectionLabel size="xs">GIFs</SectionLabel>

          <div>
            <SectionLabel as="label" size="xs" className="mb-2 block">Provider</SectionLabel>
            <Select
              value={gifSettings.provider}
              onChange={(event) =>
                setGifSettings((settings) =>
                  settings ? { ...settings, provider: event.target.value } : settings,
                )
              }
              className="cursor-default text-[var(--color-text-dim)] opacity-80"
            >
              <option value="giphy">GIPHY</option>
              <option value="tenor">Tenor (legacy — no new API clients)</option>
            </Select>
          </div>

          <div>
            <SectionLabel as="label" size="xs" className="mb-2 block">API key</SectionLabel>
            <div className="flex items-center gap-2">
              <Input
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
                className="min-w-0 flex-1"
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
                <SectionLabel as="label" size="xs" className="mb-2 block">Suggestion slow mode</SectionLabel>
                <Select
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
                >
                  <option value={30}>30 seconds</option>
                  <option value={60}>1 minute</option>
                  <option value={120}>2 minutes</option>
                  <option value={300}>5 minutes</option>
                </Select>
                <p className="mt-1.5 text-xs text-[var(--color-text-faint)]">
                  Minimum wait between duck suggestions in a channel.
                </p>
              </div>

              <div>
                <SectionLabel as="label" size="xs" className="mb-2 block">Suggestion context</SectionLabel>
                <Select
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
                >
                  <option value="1m">Last 1 minute</option>
                  <option value="2m">Last 2 minutes</option>
                  <option value="3m">Last 3 minutes</option>
                </Select>
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
            <Button onClick={() => void saveGifSettings()} disabled={gifSaving}>
              {gifSaving ? 'Saving…' : 'Save'}
            </Button>
            {gifSaved ? <span className="text-xs text-[var(--color-text-dim)]">Saved</span> : null}
          </div>

          <p className="text-2xs text-[var(--color-text-faint)]">
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
  streaming: { label: 'Streaming', description: 'Hide private content while sharing your screen.', group: 'Personal' },
  privacy: { label: 'Privacy', description: 'Control what Sharp reveals about you.', group: 'Account' },
  accounts: { label: 'Connected accounts', description: 'Manage calendar connections and external accounts.', group: 'Account' },
  security: { label: 'Security', description: 'Protect your account with passkeys.', group: 'Account' },
  encryption: { label: 'Encryption', description: 'Manage trusted devices and encrypted backups.', group: 'Account' },
  workspace: { label: 'Workspace', description: 'Shared GIF and automation controls.', group: 'Workspace' },
  about: { label: 'About Sharp', description: 'Version details, updates, and product information.', group: 'Sharp' },
}

/** Sidebar order on desktop, sheet order on mobile — one list, so both teach the same map. */
const SETTINGS_GROUPS = ['Personal', 'Account', 'Workspace', 'Sharp']

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
  const [navOpen, setNavOpen] = useState(false)
  const activeRowRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
    document.getElementById('settings-content')?.scrollTo({ top: 0 })
  }, [activeTab])

  function pickTab(next: Tab) {
    setNavOpen(false)
    onSelect(next)
  }

  return (
    <div className="settings-page flex min-h-0 flex-1 overflow-hidden bg-[var(--color-ink)] text-[var(--color-text)]">
      <aside className="hidden w-[18rem] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)] md:flex">
        <div className="border-b border-[var(--color-border)] px-6 pb-5 pt-[max(1.5rem,calc(var(--safe-top)+1rem))]">
          <div className="flex items-center gap-3">
            <Avatar id={userId} name={name} size={46} nicknameCard={false} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{name}</div>
              <div className="truncate text-xs text-[var(--color-text-faint)]">
                <MaskedEmail email={email} />
              </div>
            </div>
          </div>
        </div>
        <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
          {SETTINGS_GROUPS.map((group) => (
            <div key={group} className="mb-5 last:mb-0">
              <SectionLabel size="3xs" className="mb-1.5 px-3">
                {group}
              </SectionLabel>
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
            className="flex min-h-11 w-full cursor-pointer items-center rounded-xl px-3 text-sm font-medium text-danger-fg outline-none transition-colors hover:bg-danger-soft focus-visible:ring-2 focus-visible:ring-danger-fg"
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
          <div className="pb-3 pt-1">
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={navOpen}
              className="flex min-h-13 w-full cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 text-left outline-none transition-colors hover:bg-[var(--color-panel)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
                <SettingsIcon tab={activeTab} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-3xs font-bold uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
                  {SETTINGS_META[activeTab].group}
                </span>
                <span className="block truncate text-sm font-semibold">
                  {SETTINGS_META[activeTab].label}
                </span>
              </span>
              <ChevronDownIcon />
            </button>
          </div>
        </header>

        {navOpen && (
          <Sheet
            title="Go to section"
            onClose={() => setNavOpen(false)}
            initialFocusRef={activeRowRef}
            footer={
              <button
                type="button"
                onClick={logout}
                className="flex min-h-11 w-full cursor-pointer items-center justify-center rounded-xl px-3 text-sm font-medium text-danger-fg outline-none transition-colors hover:bg-danger-soft focus-visible:ring-2 focus-visible:ring-danger-fg"
              >
                Sign out
              </button>
            }
          >
            <nav aria-label="Settings sections" className="pt-1">
              {SETTINGS_GROUPS.map((group) => (
                <div key={group} className="mb-4 last:mb-1">
                  <SectionLabel size="3xs" className="mb-1 px-3">
                    {group}
                  </SectionLabel>
                  {SETTINGS_TABS.filter((item) => SETTINGS_META[item].group === group).map((item) => (
                    <SettingsNavButton
                      key={item}
                      active={activeTab === item}
                      buttonRef={activeTab === item ? activeRowRef : undefined}
                      label={SETTINGS_META[item].label}
                      tab={item}
                      trailing={activeTab === item ? <CheckIcon /> : undefined}
                      onClick={() => pickTab(item)}
                    />
                  ))}
                </div>
              ))}
            </nav>
          </Sheet>
        )}

        <main
          id="settings-content"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--color-ink)] px-[max(1rem,var(--safe-left))] pb-[max(2rem,var(--safe-bottom))] pr-[max(1rem,var(--safe-right))] md:px-10 md:pb-12 lg:px-16"
        >
          <div className="mx-auto w-full max-w-[48rem] pb-10 pt-5 md:pt-12">
            {/* On mobile the section switcher above *is* the title, so the group and the
                heading only show from md up — the h1 stays in the tree for screen readers
                and for the focus move on every section change. */}
            <div className="mb-6 flex items-start justify-between gap-6 md:mb-8">
              <div>
                <p className="mb-2 hidden text-3xs font-bold uppercase tracking-[0.18em] text-[var(--color-accent-hover)] md:block">
                  {SETTINGS_META[activeTab].group}
                </p>
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  className="text-2xl font-bold tracking-tight outline-none max-md:sr-only md:text-3xl"
                >
                  {SETTINGS_META[activeTab].label}
                </h1>
                <p className="max-w-xl text-sm leading-6 text-[var(--color-text-dim)] md:mt-2">
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

/** One row shape for both navigations: the desktop sidebar and the mobile sheet. */
function SettingsNavButton({
  active,
  buttonRef,
  label,
  onClick,
  tab,
  trailing,
}: {
  active: boolean
  buttonRef?: React.Ref<HTMLButtonElement>
  label: string
  onClick: () => void
  tab: Tab
  trailing?: React.ReactNode
}) {
  return (
    <button
      ref={buttonRef}
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
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing != null && (
        <span className="shrink-0 text-[var(--color-accent-hover)]">{trailing}</span>
      )}
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
    streaming: <><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></>,
    privacy: <><path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6l-8-3Z" /><circle cx="12" cy="11" r="2" /><path d="M12 13v3" /></>,
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

/** The signed-in email never reaches a shared screen — masked whenever the shield is on. */
function MaskedEmail({ email }: { email: string }) {
  const shielded = useStore(streamShieldOn)
  if (shielded) return <span aria-label="Email hidden while streaming">•••••• hidden while streaming</span>
  return <>{email}</>
}

function CloseIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="m6 6 12 12M18 6 6 18" /></svg>
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
