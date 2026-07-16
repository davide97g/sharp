/** Shared duck-streak timing — keep client trigger + progress bar in sync. */

/** Messages needed in a shared channel burst before the duck CTA unlocks. */
export const STREAK_TARGET = 3
/** Max gap between messages that still counts as one streak. */
export const STREAK_GAP_MS = 20_000

/** True when content is only a GIF token (roast GIFs shouldn't re-boost the bar). */
export function isStandaloneGif(content: string): boolean {
  const trimmed = content.trim()
  return (
    trimmed.startsWith('[[gif:') &&
    trimmed.endsWith(']]') &&
    trimmed.indexOf('[[gif:') === trimmed.lastIndexOf('[[gif:')
  )
}

/**
 * 0…1 progress toward the duck CTA.
 * Every member's messages boost the count; the bar drains when the streak cools off.
 */
export function duckStreakProgress(count: number, lastAt: number, now = Date.now()): number {
  if (count <= 0 || lastAt <= 0) return 0

  const age = now - lastAt
  if (age >= STREAK_GAP_MS) return 0

  // More messages = more boost; saturates at full once the CTA unlocks.
  const build = Math.min(1, count / STREAK_TARGET)

  // Hold strength early, then bleed off as the gap limit approaches.
  const decayStart = STREAK_GAP_MS * 0.35
  const freshness =
    age <= decayStart
      ? 1
      : Math.max(0, 1 - (age - decayStart) / (STREAK_GAP_MS - decayStart))

  return build * freshness
}

export function duckStreakArmed(count: number, lastAt: number, now = Date.now()): boolean {
  if (count < STREAK_TARGET) return false
  return duckStreakProgress(count, lastAt, now) >= 0.55
}
