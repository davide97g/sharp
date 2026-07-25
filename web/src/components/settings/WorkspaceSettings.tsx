// Settings → Workspace: GIF provider, the duck roast, and personal voice triggers.
//
// Contract: docs/arch/06-gifs.md.
//
// A key saved here takes precedence over the env fallback. The GIPHY usage bar reflects a
// self-enforced 100 searches/hour budget the server tracks per replica.

import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import type {
  GiphyUsage,
  VoiceTrigger,
} from '../../lib/types'
import { toastError } from '../../lib/toast'
import { SectionLabel } from '../../ui'
import { VoiceTriggerEditor } from '../VoiceTriggerEditor'


export function PersonalVoiceTriggers() {
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

export function formatResetRemaining(resetsAt: string | null, nowMs: number): string {
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

export function GiphyUsageBar({ usage }: { usage: GiphyUsage }) {
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
        <SectionLabel as="span" size="xs">GIPHY usage</SectionLabel>
        <span
          className={`text-xs tabular-nums ${
            atLimit ? 'text-warning-fg' : 'text-[var(--color-text-dim)]'
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
              ? 'bg-warning'
              : pct >= 80
                ? 'bg-[var(--color-accent-hover)]'
                : 'bg-[var(--color-accent)]'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-2xs text-[var(--color-text-faint)]">
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
