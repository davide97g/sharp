import { useRef, useState } from 'react'
import { useStore } from '../store'
import { toastError } from '../lib/toast'
import { Modal } from './Modal'
import { Avatar } from './Avatar'
import { AvatarCropper } from './AvatarCropper'
import { ChatLayoutPicker } from './ChatLayoutChooser'

type Tab = 'profile' | 'chat'

export function UserSettingsModal({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)
  const chatLayout = useStore((s) => s.chatLayout)
  const updateProfile = useStore((s) => s.updateProfile)
  const uploadAvatar = useStore((s) => s.uploadAvatar)
  const removeAvatar = useStore((s) => s.removeAvatar)
  const setChatLayout = useStore((s) => s.setChatLayout)

  const [tab, setTab] = useState<Tab>('profile')
  const [name, setName] = useState(me?.display_name ?? '')
  const [savingName, setSavingName] = useState(false)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [savingAvatar, setSavingAvatar] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

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

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="mb-4 flex gap-1 border-b border-[var(--color-border)]">
        <TabBtn active={tab === 'profile'} onClick={() => setTab('profile')}>
          Profile
        </TabBtn>
        <TabBtn active={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat
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

          <div className="text-[11px] text-[var(--color-text-faint)]">
            Signed in as {me.email}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            Direct message layout
          </div>
          <ChatLayoutPicker value={chatLayout} onChange={(l) => void setChatLayout(l)} />
          <p className="text-[11px] text-[var(--color-text-faint)]">
            Applies to 1:1 conversations. Channels always use the classic layout.
          </p>
        </div>
      )}
    </Modal>
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
