import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAttachmentBlob } from '../lib/api'
import { decryptAttachmentBlob } from '../lib/e2ee/attachments'
import { toastError } from '../lib/toast'
import type { Attachment } from '../lib/types'

export function isAudio(contentType: string): boolean {
  return contentType.startsWith('audio/')
}

// Voice messages recorded in the composer carry this filename; other audio
// files keep their own name and show it.
function isVoiceMessage(filename: string): boolean {
  return filename.startsWith('voice-message')
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Compact play/pause + seek + time player over a ready object URL. `src` may be
// null while the caller lazily fetches the blob; pressing play then calls
// `onRequestSrc` and the player auto-plays once `src` arrives.
function AudioPlayerControls({
  src,
  loading,
  label,
  isVoice,
  onRequestSrc,
}: {
  src: string | null
  loading?: boolean
  label: string
  isVoice: boolean
  onRequestSrc?: () => void
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const wantPlay = useRef(false)
  const fixingDuration = useRef(false)

  // When the lazily-fetched src arrives and the user meant to play, start.
  useEffect(() => {
    if (src && wantPlay.current) {
      wantPlay.current = false
      audioRef.current?.play().catch(() => {})
    }
  }, [src])

  const onLoadedMetadata = () => {
    const audio = audioRef.current
    if (!audio) return
    // Chrome webm blobs report Infinity duration; nudge currentTime to force the
    // real duration to surface, then reset.
    if (audio.duration === Infinity) {
      fixingDuration.current = true
      audio.currentTime = 1e7
    } else {
      setDuration(audio.duration)
    }
  }

  const onDurationChange = () => {
    const audio = audioRef.current
    if (!audio) return
    if (fixingDuration.current && Number.isFinite(audio.duration)) {
      fixingDuration.current = false
      setDuration(audio.duration)
      audio.currentTime = 0
      setCurrent(0)
    } else if (Number.isFinite(audio.duration)) {
      setDuration(audio.duration)
    }
  }

  const togglePlay = () => {
    const audio = audioRef.current
    if (!src) {
      if (onRequestSrc) {
        wantPlay.current = true
        onRequestSrc()
      }
      return
    }
    if (!audio) return
    if (audio.paused) audio.play().catch(() => {})
    else audio.pause()
  }

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    const next = (Number(e.target.value) / 1000) * duration
    audio.currentTime = next
    setCurrent(next)
  }

  const progress = duration > 0 ? Math.min(1000, (current / duration) * 1000) : 0

  return (
    <div className="flex min-w-0 max-w-xs items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={onDurationChange}
          onTimeUpdate={() => setCurrent(audioRef.current?.currentTime ?? 0)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false)
            setCurrent(0)
          }}
        />
      )}
      <button
        type="button"
        onClick={togglePlay}
        disabled={loading}
        title={playing ? 'Pause' : 'Play'}
        aria-label={playing ? 'Pause' : 'Play'}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-white transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
      >
        {loading ? <SpinnerGlyph /> : playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-dim)]">
          {isVoice && <MicGlyph />}
          <span className="min-w-0 truncate">{label}</span>
        </div>
        <input
          type="range"
          min={0}
          max={1000}
          value={progress}
          onChange={onSeek}
          disabled={!src || !duration}
          aria-label="Seek"
          className="voice-seek h-1 w-full cursor-pointer accent-[var(--color-accent)]"
        />
        <div className="flex justify-between text-[10px] tabular-nums text-[var(--color-text-faint)]">
          <span>{fmtTime(current)}</span>
          <span>{duration ? fmtTime(duration) : '--:--'}</span>
        </div>
      </div>
    </div>
  )
}

async function loadAudioBlob(att: Attachment): Promise<Blob> {
  const ciphertext = await fetchAttachmentBlob(att.url)
  return att.encrypted ? decryptAttachmentBlob(ciphertext, att) : ciphertext
}

// Message-list voice/audio player. Renders the shell immediately and fetches
// (and decrypts, for E2EE) the bytes only when the user first presses play.
export function VoiceMessagePlayer({ att }: { att: Attachment }) {
  const [src, setSrc] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const voice = isVoiceMessage(att.filename)

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src)
    }
  }, [src])

  const requestSrc = useCallback(() => {
    if (src || loading) return
    setLoading(true)
    loadAudioBlob(att)
      .then((blob) => setSrc(URL.createObjectURL(blob)))
      .catch((e) => e instanceof Error && toastError(e.message))
      .finally(() => setLoading(false))
  }, [att, src, loading])

  return (
    <AudioPlayerControls
      src={src}
      loading={loading}
      label={voice ? 'Voice message' : att.filename}
      isVoice={voice}
      onRequestSrc={requestSrc}
    />
  )
}

// Composer preview over a locally recorded File — src is ready immediately.
export function VoicePreviewPlayer({ file }: { file: File }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    const url = URL.createObjectURL(file)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  return <AudioPlayerControls src={src} label="Voice message" isVoice />
}

function PlayGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PauseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  )
}

function SpinnerGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" strokeLinecap="round" />
    </svg>
  )
}

function MicGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
    </svg>
  )
}
