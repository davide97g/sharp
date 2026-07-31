// Garden character roster.
//
// One list, three consumers: the Phaser preloader, the avatar picker, and — by
// hand — `GARDEN_AVATARS` in `server/src/routes/garden.rs`, which validates the
// id before it is stored (the `AURA_STYLES` precedent in
// `server/src/ws/voice/mod.rs`). Keep the two lists in lockstep.
//
// Adding a character is deliberately a drop-in:
//   1. Put `avatar_<id>.png` in `web/public/assets/garden/ninja-adventure/`.
//      It MUST be 64x112 — 4 columns (facing) x 7 rows (animation) of 16px
//      frames — or `DIRECTION_COLUMN` and the `row * 4 + column` frame math in
//      GardenGame break.
//   2. Put its 38x38 portrait in `.../ninja-adventure/faceset/avatar_<id>.png`.
//   3. Add the id here and to `GARDEN_AVATARS` in Rust.
//   4. Append its provenance row to the assets README.
// Nothing else changes: no migration, no schema, no wire change.
//
// Ids are stable slugs and are persisted in `user_prefs.garden_avatar`, so
// never rename one — an existing user's stored choice would stop resolving and
// silently fall back.

export const AVATAR_IDS = [
  'samurai',
  'scout',
  'ninja',
  'monk',
  'knight',
  'hunter',
  'royal',
  'noble',
  'explorer',
  'villager',
  'florist',
  'mage',
] as const

export type GardenAvatarId = (typeof AVATAR_IDS)[number]

// Shown in the picker. Descriptive of the sprite, not of the person choosing it.
export const AVATAR_LABELS: Record<GardenAvatarId, string> = {
  samurai: 'Samurai',
  scout: 'Scout',
  ninja: 'Ninja',
  monk: 'Monk',
  knight: 'Knight',
  hunter: 'Hunter',
  royal: 'Royal',
  noble: 'Noble',
  explorer: 'Explorer',
  villager: 'Villager',
  florist: 'Florist',
  mage: 'Mage',
}

export const AVATAR_ASSET_ROOT = '/assets/garden/ninja-adventure'

/** Phaser texture key for a roster id. */
export function avatarTextureKey(id: string): string {
  return `garden-avatar-${id}`
}

/** Full-sheet URL — 64x112, used by the Phaser preloader. */
export function avatarSheetUrl(id: string): string {
  return `${AVATAR_ASSET_ROOT}/avatar_${id}.png`
}

/** 38x38 portrait URL — used by the picker, no Phaser involved. */
export function avatarFacesetUrl(id: string): string {
  return `${AVATAR_ASSET_ROOT}/faceset/avatar_${id}.png`
}

export function isAvatarId(value: string | null | undefined): value is GardenAvatarId {
  return !!value && (AVATAR_IDS as readonly string[]).includes(value)
}

/**
 * Appearance for someone who has never picked one.
 *
 * Keyed on the immutable user id, NOT the display name: a rename must not change
 * your character.
 */
export function fallbackAvatarId(userId: string): GardenAvatarId {
  let value = 0
  for (let index = 0; index < userId.length; index += 1) {
    value = (value * 31 + userId.charCodeAt(index)) >>> 0
  }
  return AVATAR_IDS[value % AVATAR_IDS.length]
}

/** Roster id to render for a peer, honouring their choice then falling back. */
export function resolveAvatarId(
  chosen: string | null | undefined,
  userId: string,
): GardenAvatarId {
  return isAvatarId(chosen) ? chosen : fallbackAvatarId(userId)
}
