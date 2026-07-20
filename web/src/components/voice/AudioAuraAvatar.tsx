import { useEffect, useRef, type CSSProperties } from 'react'
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
  const rootRef = useRef<HTMLDivElement>(null)
  const connKey = connIds.join('\u0000')

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!enabled || !speaking || !client || reducedMotion) {
      applyLevel(root, enabled && speaking ? 0.32 : 0, 0, size)
      return
    }

    let frame = 0
    const update = (now: number) => {
      const level = client.getVoiceLevel(connIds)
      applyLevel(root, level, now, size)
      frame = requestAnimationFrame(update)
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
      className={`voice-aura-avatar ${enabled ? 'is-enabled' : ''} ${speaking ? 'is-speaking' : ''}`}
      style={{ ...RESTING_STYLE, width: size, height: size, borderRadius: radius }}
    >
      <AuraLayers />
      <div className="voice-aura-avatar-body">
        <Avatar id={userId} name={name} size={size} />
      </div>
    </div>
  )
}

export function AudioAuraPreview({ size = 54 }: { size?: number }) {
  const radius = Math.max(6, Math.round(size * 0.28))
  return (
    <div
      aria-hidden="true"
      className="voice-aura-avatar is-enabled is-speaking is-preview"
      style={
        {
          ...RESTING_STYLE,
          '--voice-level': 0.78,
          '--voice-scale': 1.1,
          '--voice-lift': '-3px',
          '--voice-tilt': '-1.5deg',
          '--voice-glow': '27px',
          '--voice-ring-scale': 1.11,
          '--voice-orbit-radius': `${Math.round(size * 0.17)}px`,
          '--voice-orbit-duration': '720ms',
          '--voice-aura-opacity': 0.92,
          width: size,
          height: size,
          borderRadius: radius,
        } as AuraStyle
      }
    >
      <AuraLayers />
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

function AuraLayers() {
  return (
    <>
      <span className="voice-aura-halo" aria-hidden="true" />
      <span className="voice-aura-echo" aria-hidden="true" />
      <span className="voice-aura-orbit" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
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
