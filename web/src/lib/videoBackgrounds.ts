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

export const VIDEO_BACKGROUND_OPTIONS: VideoBackgroundOption[] = [
  { id: 'none', label: 'None' },
  { id: 'blur', label: 'Blur' },
  { id: 'aurora', label: 'Aurora', imageUrl: '/wallpapers/aurora.svg' },
  { id: 'studio', label: 'Studio', imageUrl: '/wallpapers/studio.svg' },
  { id: 'horizon', label: 'Horizon', imageUrl: '/wallpapers/horizon.svg' },
]

const LEGACY_BLUR_KEY = 'sharp.videoBlur'
const STORAGE_PREFIX = 'sharp.videoBackground.v1.'
const BUILT_IN_IDS = new Set<VideoBackgroundId>([
  'none',
  'blur',
  'aurora',
  'studio',
  'horizon',
])

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`
}

export function loadVideoBackground(userId?: string | null): VideoBackground {
  try {
    if (userId) {
      const raw = window.localStorage.getItem(storageKey(userId))
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<VideoBackground>
        if (parsed.id === 'custom' && parsed.customUrl?.startsWith('data:image/')) {
          return { id: 'custom', customUrl: parsed.customUrl }
        }
        if (parsed.id && BUILT_IN_IDS.has(parsed.id)) return { id: parsed.id }
      }
    }
    // Keep the old blur preference as a one-way migration fallback.
    if (window.localStorage.getItem(LEGACY_BLUR_KEY) === '1') return { id: 'blur' }
  } catch {
    // Storage may be blocked in private/restricted contexts.
  }
  return { id: 'none' }
}

export function saveVideoBackground(userId: string, background: VideoBackground): boolean {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(background))
    window.localStorage.setItem(LEGACY_BLUR_KEY, background.id === 'blur' ? '1' : '0')
    return true
  } catch {
    return false
  }
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
