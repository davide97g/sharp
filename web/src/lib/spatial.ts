// Geometry and the volume curve for the spatial call floor.
//
// Contract: docs/arch/04-voice.md ("Spatial view and positional audio").
//
// Lives apart from lib/voice.ts on purpose: the floor plan needs the same numbers the
// audio graph uses, and importing them must not drag the LiveKit engine into the main
// bundle. Everything here works in floor units — the normalized 0..1 square the server
// broadcasts — so the picture and the ears can never disagree.

/** Zone rings drawn around the listener. Purely a legend for the curve below: the
 *  volume falls off continuously, these are just where it has roughly halved, quartered
 *  and faded to a background murmur. */
export const SPATIAL_ZONE_RADII = [0.18, 0.34, 0.52] as const

/** Distance at which the curve has dropped to about half. */
const HALF_GAIN_DISTANCE = 0.2
/** Nobody ever becomes fully inaudible — across the room is a murmur, not a mute. */
const MIN_GAIN = 0.06

/**
 * Volume for a peer `distance` floor units away. Smooth and strictly decreasing —
 * there are no zone steps in the audio, only in the drawing.
 */
export function spatialGain(distance: number): number {
  const falloff = 1 / (1 + (Math.max(0, distance) / HALF_GAIN_DISTANCE) ** 2)
  return MIN_GAIN + (1 - MIN_GAIN) * falloff
}

/** Middle of the floor — where "reset" parks the listener. */
export const SPATIAL_FLOOR_CENTER = { x: 0.5, y: 0.5 } as const

/** Ring radius used when gathering everyone into zone 1, comfortably inside it. */
const ZONE_ONE_RING = 0.12

/**
 * Everyone gathered in zone 1: the listener in the middle of the floor and `count` peers
 * evenly spaced on a ring inside the innermost zone, starting straight ahead and going
 * clockwise. Every voice comes back to near-full volume while the left/right image stays
 * intact, which is what "reset" is for — a way out of an arrangement you can no longer hear.
 */
export function spatialZoneOneLayout(count: number): { x: number; y: number }[] {
  if (count <= 0) return []
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count
    return {
      x: SPATIAL_FLOOR_CENTER.x + Math.cos(angle) * ZONE_ONE_RING,
      y: SPATIAL_FLOOR_CENTER.y + Math.sin(angle) * ZONE_ONE_RING,
    }
  })
}

/**
 * Direction from the listener to a peer, as a unit vector in Web Audio's world axes
 * (x right, z forward-negative). Distance is deliberately NOT encoded here: panners sit
 * on a fixed-radius circle so the left/right image is equally strong up close and across
 * the room, and `spatialGain` alone carries distance. Peers standing on top of you
 * default to straight ahead.
 */
export function spatialDirection(dx: number, dy: number): { x: number; z: number } {
  const length = Math.hypot(dx, dy)
  if (length < 1e-4) return { x: 0, z: -1 }
  return { x: dx / length, z: dy / length }
}
