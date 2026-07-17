export function supportsDocumentPip() {
  return Boolean(window.documentPictureInPicture?.requestWindow)
}

export function supportsElementPip() {
  const video = document.createElement('video')
  return Boolean(
    (document.pictureInPictureEnabled && video.requestPictureInPicture) ||
      video.webkitSetPresentationMode,
  )
}

export function copyDocumentStyles(target: Window) {
  const sourceRoot = document.documentElement
  const targetRoot = target.document.documentElement

  for (const attribute of [...sourceRoot.attributes]) {
    targetRoot.setAttribute(attribute.name, attribute.value)
  }

  for (const sheet of [...document.styleSheets]) {
    try {
      const style = target.document.createElement('style')
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n')
      target.document.head.appendChild(style)
    } catch {
      if (sheet.ownerNode instanceof HTMLLinkElement) {
        target.document.head.appendChild(sheet.ownerNode.cloneNode(true))
      } else if (sheet.href) {
        const link = target.document.createElement('link')
        link.rel = 'stylesheet'
        link.href = sheet.href
        target.document.head.appendChild(link)
      }
    }
  }

  target.document.body.className = document.body.className
  target.document.body.style.margin = '0'
  target.document.body.style.width = '100vw'
  target.document.body.style.height = '100vh'
  target.document.body.style.overflow = 'hidden'
  target.document.body.style.background = 'var(--color-ink)'
}

// Screen share first (that's what you want to keep watching), then local
// camera, then any remote camera.
export function bestVoiceVideo() {
  return (
    document.querySelector<HTMLVideoElement>('video[data-voice-screen]') ??
    document.querySelector<HTMLVideoElement>('video[data-voice-video-local="true"]') ??
    document.querySelector<HTMLVideoElement>('video[data-voice-video]')
  )
}

let activeElementPipVideo: HTMLVideoElement | null = null

export async function openElementPip() {
  const video = bestVoiceVideo()
  if (!video) return
  activeElementPipVideo = video

  if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
    try {
      await video.requestPictureInPicture()
    } catch (error) {
      activeElementPipVideo = null
      throw error
    }
    return
  }

  video.webkitSetPresentationMode?.('picture-in-picture')
}

export function closeElementPip() {
  if (document.pictureInPictureElement && document.exitPictureInPicture) {
    void document.exitPictureInPicture().catch(() => {})
  } else {
    activeElementPipVideo?.webkitSetPresentationMode?.('inline')
  }
  activeElementPipVideo = null
}
