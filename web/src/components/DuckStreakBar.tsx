import { useEffect, useRef, useState } from 'react'
import {
  duckStreakArmed,
  duckStreakProgress,
  STREAK_GAP_MS,
} from '../lib/duckStreak'
import { useStore } from '../store'

const VISIBLE_FLOOR = 0.02

export function DuckStreakBar({ channelId }: { channelId: string }) {
  const duck = useStore((state) => state.gifConfig?.duck)
  const activity = useStore((state) => state.duckActivity[channelId])
  const resetDuckActivity = useStore((state) => state.resetDuckActivity)
  const [progress, setProgress] = useState(0)
  const [visible, setVisible] = useState(false)
  const [armed, setArmed] = useState(false)
  const hideTimer = useRef<number | null>(null)

  useEffect(() => {
    if (!duck) {
      setProgress(0)
      setVisible(false)
      setArmed(false)
      return
    }

    let frame = 0
    const tick = () => {
      const count = activity?.count ?? 0
      const lastAt = activity?.lastAt ?? 0
      const next = duckStreakProgress(count, lastAt)

      if (count > 0 && lastAt > 0 && Date.now() - lastAt >= STREAK_GAP_MS) {
        resetDuckActivity(channelId)
      }

      setProgress(next)
      setArmed(duckStreakArmed(count, lastAt))
      if (next > VISIBLE_FLOOR) {
        setVisible(true)
        if (hideTimer.current != null) {
          window.clearTimeout(hideTimer.current)
          hideTimer.current = null
        }
      } else if (hideTimer.current == null) {
        hideTimer.current = window.setTimeout(() => {
          setVisible(false)
          hideTimer.current = null
        }, 280)
      }

      frame = window.requestAnimationFrame(tick)
    }

    frame = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(frame)
      if (hideTimer.current != null) window.clearTimeout(hideTimer.current)
    }
  }, [activity?.count, activity?.lastAt, channelId, duck, resetDuckActivity])

  if (!duck) return null

  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10

  return (
    <div
      className="duck-streak-bar"
      data-visible={visible ? 'true' : undefined}
      data-armed={armed ? 'true' : undefined}
      aria-hidden={!visible}
    >
      <div className="duck-streak-track">
        <div className="duck-streak-fill" style={{ width: `${pct}%` }}>
          <span className="duck-streak-sheen" />
          <span className="duck-streak-tip" aria-hidden>
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </div>
  )
}
