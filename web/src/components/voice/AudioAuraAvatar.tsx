import { useEffect, useRef, type CSSProperties } from 'react'
import { type AudioAuraStyle, useAudioAuraStyle } from '../../lib/meetingEffects'
import { useStore } from '../../store'
import { Avatar } from '../Avatar'

type AuraStyle = CSSProperties & Record<`--voice-${string}`, string | number>

const RESTING_STYLE: AuraStyle = {
  '--voice-level': 0,
  '--voice-scale': 1,
  '--voice-lift': '0px',
  '--voice-tilt': '0deg',
  '--voice-glow': '8px',
  '--voice-ring-scale': 0.96,
  '--voice-orbit-radius': '4px',
  '--voice-orbit-duration': '1200ms',
  '--voice-aura-opacity': 0,
}

export function AudioAuraAvatar({
  userId,
  name,
  size,
  connIds,
  speaking,
  enabled,
}: {
  userId: string
  name: string
  size: number
  connIds: string[]
  speaking: boolean
  enabled: boolean
}) {
  const client = useStore((state) => state.voice.client)
  const me = useStore((state) => state.me)
  const auraStyle = useAudioAuraStyle(me?.id)
  const rootRef = useRef<HTMLDivElement>(null)
  const envelopeRef = useRef(0)
  const connKey = connIds.join('\u0000')

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!enabled) {
      envelopeRef.current = 0
      applyLevel(root, 0, 0, size)
      return
    }

    if (reducedMotion || !client) {
      envelopeRef.current = speaking ? 0.32 : 0
      applyLevel(root, envelopeRef.current, 0, size)
      return
    }

    let frame = 0
    const update = (now: number) => {
      const rawLevel = speaking ? client.getVoiceLevel(connIds) : 0
      const previous = envelopeRef.current
      // Fast attack gives instant acknowledgement. Slow release bridges syllables
      // and avoids a distracting on/off flicker around speaking detection thresholds.
      const response = rawLevel > previous ? 0.72 : 0.055
      const next = previous + (rawLevel - previous) * response
      envelopeRef.current = next < 0.004 ? 0 : next
      applyLevel(root, envelopeRef.current, now, size)

      if (speaking || envelopeRef.current > 0) {
        frame = requestAnimationFrame(update)
      }
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
    // connKey gives this effect a stable primitive dependency for merged users.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, connKey, enabled, size, speaking])

  const radius = Math.max(6, Math.round(size * 0.28))
  return (
    <div
      ref={rootRef}
      className={`voice-aura-avatar aura-${auraStyle} ${enabled ? 'is-enabled' : ''} ${speaking ? 'is-speaking' : ''}`}
      style={{ ...RESTING_STYLE, width: size, height: size, borderRadius: radius }}
    >
      <AuraLayers style={auraStyle} />
      <div className="voice-aura-avatar-body">
        <Avatar id={userId} name={name} size={size} />
      </div>
    </div>
  )
}

export function AudioAuraPreview({
  size = 54,
  variant = 'helios',
  level = 0.78,
}: {
  size?: number
  variant?: AudioAuraStyle
  level?: number
}) {
  const radius = Math.max(6, Math.round(size * 0.28))
  const energy = Math.min(1, Math.max(0, level))
  return (
    <div
      aria-hidden="true"
      className={`voice-aura-avatar aura-${variant} is-enabled is-speaking is-preview`}
      style={
        {
          ...RESTING_STYLE,
          '--voice-level': energy,
          '--voice-scale': 1 + energy * 0.12,
          '--voice-lift': `${-energy * 3}px`,
          '--voice-tilt': `${-energy * 1.4}deg`,
          '--voice-glow': `${Math.round(8 + energy * 28)}px`,
          '--voice-ring-scale': 0.98 + energy * 0.18,
          '--voice-orbit-radius': `${Math.round(size * (0.08 + energy * 0.12))}px`,
          '--voice-orbit-duration': `${Math.round(1250 - energy * 660)}ms`,
          '--voice-aura-opacity': Math.min(1, 0.2 + energy),
          width: size,
          height: size,
          borderRadius: radius,
        } as AuraStyle
      }
    >
      <AuraLayers style={variant} />
      <div className="voice-aura-avatar-body">
        <div
          className="flex h-full w-full items-center justify-center bg-[#6d5dfc] font-semibold text-white"
          style={{ borderRadius: radius, fontSize: size * 0.31 }}
        >
          YOU
        </div>
      </div>
    </div>
  )
}

function AuraLayers({ style }: { style: AudioAuraStyle }) {
  if (style === 'kinetic-type') {
    return (
      <span className="voice-aura-type" aria-hidden="true">
        <i>OH</i><i>YEAH</i><i>LOUD</i><i>!</i>
      </span>
    )
  }

  if (style === 'voiceprint') {
    return (
      <span className="voice-aura-wave" aria-hidden="true">
        {Array.from({ length: 11 }, (_, index) => <i key={index} />)}
      </span>
    )
  }

  return (
    <>
      <span className="voice-aura-halo" aria-hidden="true" />
      <span className="voice-aura-echo" aria-hidden="true" />
      {style === 'helios' && <span className="voice-aura-flare" aria-hidden="true" />}
    </>
  )
}

function applyLevel(root: HTMLDivElement, level: number, now: number, size: number) {
  const energy = Math.min(1, Math.max(0, level))
  const bounce = energy * (2.4 + Math.sin(now / 82) * 2.2)
  root.style.setProperty('--voice-level', energy.toFixed(3))
  root.style.setProperty('--voice-scale', (1 + energy * 0.17).toFixed(3))
  root.style.setProperty('--voice-lift', `${-bounce.toFixed(2)}px`)
  root.style.setProperty('--voice-tilt', `${(Math.sin(now / 137) * energy * 2.8).toFixed(2)}deg`)
  root.style.setProperty('--voice-glow', `${Math.round(8 + energy * 30)}px`)
  root.style.setProperty('--voice-ring-scale', (0.98 + energy * 0.2).toFixed(3))
  root.style.setProperty('--voice-orbit-radius', `${Math.round(size * (0.07 + energy * 0.13))}px`)
  root.style.setProperty('--voice-orbit-duration', `${Math.round(1250 - energy * 680)}ms`)
  root.style.setProperty('--voice-aura-opacity', Math.min(1, 0.2 + energy * 0.92).toFixed(3))
}
