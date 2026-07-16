/** Shared duck-streak timing — keep client trigger + progress bar in sync. */

/** Messages needed in a fast burst before the duck can fire. */
export const STREAK_TARGET = 3
/** Max gap between messages that still counts as one streak. */
export const STREAK_GAP_MS = 20_000
/** Quiet pause after the target count before requesting a GIF. */
export const STREAK_QUIET_MS = 5_000

/**
 * 0…1 progress toward a duck suggestion.
 * Builds with each streak message, climbs through the quiet window at ≥target,
 * and eases down as the gap window runs out (streak "losing").
 */
export function duckStreakProgress(count: number, lastAt: number, now = Date.now()): number {
  if (count <= 0 || lastAt <= 0) return 0

  const age = now - lastAt
  if (age >= STREAK_GAP_MS) return 0

  if (count < STREAK_TARGET) {
    const build = (count / STREAK_TARGET) * 0.72
    // Hold strength early, then bleed off as the gap limit approaches.
    const decayStart = STREAK_GAP_MS * 0.3
    const freshness =
      age <= decayStart
        ? 1
        : Math.max(0, 1 - (age - decayStart) / (STREAK_GAP_MS - decayStart))
    return build * freshness
  }

  // Target reached: fill the last chunk over the quiet countdown.
  if (age <= STREAK_QUIET_MS) {
    return 0.72 + (age / STREAK_QUIET_MS) * 0.28
  }

  // Past quiet but still in the gap (e.g. cooldown blocked fire) — drain.
  const post = age - STREAK_QUIET_MS
  const drainWindow = STREAK_GAP_MS - STREAK_QUIET_MS
  return Math.max(0, 1 - post / drainWindow)
}
