import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

// The composer stamps the clip length into the filename (`voice-message-33s.webm`)
// so we can show the duration before the audio bytes are ever fetched.
function durationFromFilename(filename: string): number {
  const m = filename.match(/voice-message-(\d+)s/)
  return m ? Number(m[1]) : 0
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const s = Math.floor(seconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const BAR_COUNT = 40

// A stable pseudo-waveform derived from the attachment identity, so every clip
// gets its own silhouette but it never changes between renders. We don't decode
// real amplitudes (bytes are lazy/encrypted) — this is an honest placeholder.
function useWaveform(seed: string): number[] {
  return useMemo(() => {
    let h = 2166136261
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    const bars: number[] = []
    for (let i = 0; i < BAR_COUNT; i++) {
      h += 0x6d2b79f5
      let t = Math.imul(h ^ (h >>> 15), 1 | h)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      const rnd = ((t ^ (t >>> 14)) >>> 0) / 4294967296
      // Bias toward a lively mid-height profile rather than uniform noise.
      bars.push(0.2 + 0.8 * Math.min(1, rnd * 0.7 + 0.3 * Math.sin((i / BAR_COUNT) * Math.PI)))
    }
    return bars
  }, [seed])
}

// Play/pause + waveform-scrubber + duration player over a ready object URL.
// `src` may be null while the caller lazily fetches the blob; pressing play then
// calls `onRequestSrc` and the player auto-plays once `src` arrives.
function AudioPlayerControls({
  src,
  loading,
  filename,
  isVoice,
  seed,
  onRequestSrc,
}: {
  src: string | null
  loading?: boolean
  filename: string
  isVoice: boolean
  seed: string
  onRequestSrc?: () => void
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const wantPlay = useRef(false)
  const fixingDuration = useRef(false)
  const bars = useWaveform(seed)

  // Known before any bytes load (from the filename); the real value replaces it
  // once metadata is available.
  const durationHint = isVoice ? durationFromFilename(filename) : 0
  const total = duration || durationHint

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

  const fraction = duration > 0 ? Math.min(1, current / duration) : 0
  const progress = fraction * 1000
  const playedBars = Math.round(fraction * BAR_COUNT)
  // Elapsed while active, otherwise the total length.
  const shownTime = playing || current > 0 ? current : total

  return (
    <div className="flex min-w-0 max-w-xs items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-2">
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
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-white transition hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
      >
        {loading ? <SpinnerGlyph /> : playing ? <PauseGlyph /> : <PlayGlyph />}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {!isVoice && (
          <span className="min-w-0 truncate text-xs text-[var(--color-text-dim)]">{filename}</span>
        )}
        <div className="flex items-center gap-2.5">
          <div className="relative flex min-w-0 flex-1 items-center">
            <div className="flex h-7 min-w-0 flex-1 items-center gap-[2px]" aria-hidden>
              {bars.map((h, i) => (
                <span
                  key={i}
                  className="min-w-0 flex-1 rounded-full transition-colors"
                  style={{
                    height: `${Math.round(h * 100)}%`,
                    backgroundColor:
                      i < playedBars ? 'var(--color-accent)' : 'var(--color-text-faint)',
                    opacity: i < playedBars ? 1 : 0.5,
                  }}
                />
              ))}
            </div>
            <input
              type="range"
              min={0}
              max={1000}
              value={progress}
              onChange={onSeek}
              disabled={!src || !duration}
              aria-label="Seek"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default"
            />
          </div>
          <span className="shrink-0 text-2xs tabular-nums text-[var(--color-text-dim)]">
            {total ? fmtTime(shownTime) : '--:--'}
          </span>
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
      filename={att.filename}
      isVoice={voice}
      seed={att.id}
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
  return (
    <AudioPlayerControls
      src={src}
      filename={file.name}
      isVoice
      seed={`${file.name}:${file.size}`}
    />
  )
}

function PlayGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function PauseGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  )
}

function SpinnerGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin" aria-hidden>
      <path d="M21 12a9 9 0 1 1-6.2-8.6" strokeLinecap="round" />
    </svg>
  )
}
