import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ApiRequestError, api, setSessionToken } from '../lib/api'
import { useStore } from '../store'
import { toastError } from '../lib/toast'
import { VideoStage } from './voice/VideoStage'

const GUEST_NAME_KEY = 'sharp.guestName'

type Phase = 'loading' | 'invalid' | 'form' | 'connecting' | 'incall' | 'left'

// Public guest entry point (route `/call/:token`). Anonymous visitors — and
// logged-in members who follow the link — see the same voice-only flow: resolve
// the link, enter a name, join the channel's voice room as a guest.
export function GuestCall() {
  const { token } = useParams<{ token: string }>()
  const initGuestCall = useStore((s) => s.initGuestCall)
  const rejoinGuestCall = useStore((s) => s.rejoinGuestCall)
  const setVoiceStageMode = useStore((s) => s.setVoiceStageMode)
  const voiceChannelId = useStore((s) => s.voice.channelId)
  const guestRevoked = useStore((s) => s.guestRevoked)

  const [phase, setPhase] = useState<Phase>('loading')
  const [channelName, setChannelName] = useState('')
  const [name, setName] = useState(() => localStorage.getItem(GUEST_NAME_KEY) ?? '')
  const [busy, setBusy] = useState(false)

  const boundChannelRef = useRef<string | null>(null)
  const wasInCallRef = useRef(false)
  const forcedFullRef = useRef(false)

  // Resolve the link → channel name, or mark it invalid.
  useEffect(() => {
    if (!token) {
      setPhase('invalid')
      return
    }
    let cancelled = false
    api.callLink
      .info(token)
      .then((res) => {
        if (cancelled) return
        setChannelName(res.channel_name)
        setPhase((prev) => (prev === 'loading' ? 'form' : prev))
      })
      .catch(() => {
        if (!cancelled) setPhase('invalid')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // Drive the call phases off the shared voice state. Once the bound room is
  // joined we're in-call; when it clears after having been in-call, we've left.
  useEffect(() => {
    if (guestRevoked) {
      wasInCallRef.current = false
      setPhase('invalid')
      return
    }
    const bound = boundChannelRef.current
    if (!bound) return
    if (voiceChannelId === bound) {
      wasInCallRef.current = true
      setPhase('incall')
    } else if (wasInCallRef.current) {
      setPhase('left')
    }
  }, [voiceChannelId, guestRevoked])

  // Guests default to the full-screen stage the first time they land in a call.
  useEffect(() => {
    if (phase === 'incall' && !forcedFullRef.current) {
      forcedFullRef.current = true
      setVoiceStageMode('full')
    }
  }, [phase, setVoiceStageMode])

  // Tear the guest session down when the page unmounts (e.g. navigating away).
  useEffect(() => {
    return () => {
      useStore.getState().leaveVoice()
      setSessionToken(null)
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !token) return
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 80) {
      toastError('Enter a name between 1 and 80 characters.')
      return
    }
    setBusy(true)
    try {
      const res = await api.callLink.join(token, trimmed)
      localStorage.setItem(GUEST_NAME_KEY, trimmed)
      boundChannelRef.current = res.channel_id
      wasInCallRef.current = false
      setPhase('connecting')
      initGuestCall(res.token, { id: res.user_id, name: res.name }, res.channel_id)
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 404) setPhase('invalid')
      else toastError(err instanceof Error ? err.message : 'Could not join the call.')
    } finally {
      setBusy(false)
    }
  }

  function rejoin() {
    forcedFullRef.current = false
    wasInCallRef.current = false
    setPhase('connecting')
    rejoinGuestCall()
  }

  if (phase === 'incall') {
    return (
      <div className="min-h-full bg-[var(--color-ink)]">
        <VideoStage />
      </div>
    )
  }

  return (
    <Shell>
      {phase === 'loading' && (
        <p className="text-sm text-[var(--color-text-dim)]">Loading call…</p>
      )}

      {phase === 'invalid' && (
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-lg font-semibold">Call link unavailable</h1>
          <p className="text-sm text-[var(--color-text-dim)]">
            This call link is invalid or has been revoked.
          </p>
        </div>
      )}

      {phase === 'form' && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="mb-2 flex flex-col items-center gap-1 text-center">
            <h1 className="text-xl font-bold tracking-tight">Join the call</h1>
            <p className="text-sm text-[var(--color-text-dim)]">
              You&rsquo;re joining «{channelName}»
            </p>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-[var(--color-text-dim)]">Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
              maxLength={80}
              autoFocus
              required
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] disabled:opacity-60"
          >
            {busy ? 'Please wait…' : 'Join call'}
          </button>
        </form>
      )}

      {phase === 'connecting' && (
        <p className="text-sm text-[var(--color-text-dim)]">Joining «{channelName}»…</p>
      )}

      {phase === 'left' && (
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold">You left the call</h1>
            <p className="text-sm text-[var(--color-text-dim)]">«{channelName}»</p>
          </div>
          <button
            type="button"
            onClick={rejoin}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)]"
          >
            Rejoin call
          </button>
        </div>
      )}
    </Shell>
  )
}

// Centered card matching the Login lockup (`#` logo + sharp wordmark).
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--color-ink)] p-6">
      <div className="w-full max-w-sm animate-in">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--color-panel)] text-3xl font-extrabold text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
            #
          </div>
          <h1 className="text-2xl font-bold tracking-tight">sharp</h1>
        </div>
        {children}
      </div>
    </div>
  )
}
