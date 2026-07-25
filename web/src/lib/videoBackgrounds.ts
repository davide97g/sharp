export type VideoBackgroundId =
  | 'none'
  | 'blur'
  | 'aurora'
  | 'studio'
  | 'horizon'
  | 'custom'

export type VideoBackground = {
  id: VideoBackgroundId
  customUrl?: string
}

export type VideoBackgroundOption = {
  id: Exclude<VideoBackgroundId, 'custom'>
  label: string
  imageUrl?: string
}

import {
  KEYS,
  KEY_PREFIXES,
  readLocalBool,
  readLocalJson,
  scopedKey,
  writeLocalBool,
  writeLocalJson,
} from './localPrefs'

export const VIDEO_BACKGROUND_OPTIONS: VideoBackgroundOption[] = [
  { id: 'none', label: 'None' },
  { id: 'blur', label: 'Blur' },
  { id: 'aurora', label: 'Aurora', imageUrl: '/wallpapers/aurora.svg' },
  { id: 'studio', label: 'Studio', imageUrl: '/wallpapers/studio.svg' },
  { id: 'horizon', label: 'Horizon', imageUrl: '/wallpapers/horizon.svg' },
]

const BUILT_IN_IDS = new Set<VideoBackgroundId>([
  'none',
  'blur',
  'aurora',
  'studio',
  'horizon',
])

function storageKey(userId: string): string {
  return scopedKey(KEY_PREFIXES.videoBackground, encodeURIComponent(userId))
}

export function loadVideoBackground(userId?: string | null): VideoBackground {
  if (userId) {
    const parsed = readLocalJson<Partial<VideoBackground>>(storageKey(userId), {})
    // A custom background is an inline data: URL. Re-check the prefix on read: this
    // value ends up in a CSS background, so anything else must be discarded.
    if (parsed.id === 'custom' && parsed.customUrl?.startsWith('data:image/')) {
      return { id: 'custom', customUrl: parsed.customUrl }
    }
    if (parsed.id && BUILT_IN_IDS.has(parsed.id)) return { id: parsed.id }
  }
  // Keep the old blur-only preference as a one-way migration fallback.
  if (readLocalBool(KEYS.videoBlurLegacy, false)) return { id: 'blur' }
  return { id: 'none' }
}

/**
 * Returns false when the browser refused to persist — a custom background is an inline
 * data: URL and can exceed the quota, and the caller tells the user so the choice does
 * not silently vanish on reload.
 */
export function saveVideoBackground(userId: string, background: VideoBackground): boolean {
  const saved = writeLocalJson(storageKey(userId), background)
  // Keep the legacy flag in step so an older build (or the pre-migration read path)
  // still sees blur.
  writeLocalBool(KEYS.videoBlurLegacy, background.id === 'blur')
  return saved
}

export function videoBackgroundImageUrl(background: VideoBackground): string | null {
  if (background.id === 'custom') return background.customUrl ?? null
  return (
    VIDEO_BACKGROUND_OPTIONS.find((option) => option.id === background.id)?.imageUrl ?? null
  )
}

// Custom images stay local to this browser. Rasterizing also strips image metadata,
// neutralizes SVG scripts, and keeps the localStorage payload comfortably bounded.
export async function prepareCustomVideoBackground(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.')
  if (file.size > 15 * 1024 * 1024) throw new Error('Image must be smaller than 15 MB.')

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  image.src = objectUrl
  try {
    await image.decode()
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image could not be read.')

    const maxPixels = 1_600 * 900
    const scale = Math.min(1, Math.sqrt(maxPixels / (image.naturalWidth * image.naturalHeight)))
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image processing is unavailable.')
    context.fillStyle = '#17171d'
    context.fillRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.84)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
