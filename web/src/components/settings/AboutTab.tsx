// Settings → About: version, changelog link, and viewport diagnostics.
//
// The diagnostics exist for the iOS standalone-PWA viewport bugs worked around in
// lib/iosViewport.ts — they are how you tell whether a report is that bug.

import { useEffect, useState } from 'react'
import { SectionLabel } from '../../ui'


export function readSafeInset(side: 'top' | 'right' | 'bottom' | 'left'): string {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;top:0;left:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-${side},0px)`
  document.body.appendChild(el)
  const value = getComputedStyle(el).height
  el.remove()
  return value
}

export function viewportDiagnostics() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return {
    window: `${window.innerWidth} × ${window.innerHeight}`,
    screen: `${screen.width} × ${screen.height}`,
    insets: `${readSafeInset('top')} / ${readSafeInset('right')} / ${readSafeInset('bottom')} / ${readSafeInset('left')}`,
    mode: standalone ? 'standalone (installed)' : 'browser tab',
  }
}

export function AboutTab() {
  const [diag, setDiag] = useState(viewportDiagnostics)
  useEffect(() => {
    const update = () => setDiag(viewportDiagnostics())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent)] text-lg font-extrabold text-white">
            #
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold">sharp</div>
            <div className="text-2xs text-[var(--color-text-faint)]">
              Self-hosted team chat, docs, canvas, and calls.
            </div>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-[var(--color-text-faint)]">Version</dt>
          <dd className="font-mono text-[13px] tabular-nums">{__APP_VERSION__}</dd>
          <dt className="text-[var(--color-text-faint)]">Build</dt>
          <dd className="break-all font-mono text-[13px]">{__BUILD_ID__}</dd>
        </dl>
      </div>
      <p className="text-2xs leading-5 text-[var(--color-text-faint)]">
        The build id changes on every deploy. If it matches your latest deploy, this
        device is running the newest version — updates are picked up automatically
        within moments of reopening the app.
      </p>
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4">
        <SectionLabel size="xs" className="mb-2 block">Display diagnostics</SectionLabel>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-[var(--color-text-faint)]">Window</dt>
          <dd className="font-mono text-[13px] tabular-nums">{diag.window}</dd>
          <dt className="text-[var(--color-text-faint)]">Screen</dt>
          <dd className="font-mono text-[13px] tabular-nums">{diag.screen}</dd>
          <dt className="text-[var(--color-text-faint)]">Safe insets</dt>
          <dd className="font-mono text-[13px] tabular-nums">{diag.insets}</dd>
          <dt className="text-[var(--color-text-faint)]">Mode</dt>
          <dd className="font-mono text-[13px]">{diag.mode}</dd>
        </dl>
        <p className="mt-3 text-2xs leading-5 text-[var(--color-text-faint)]">
          When installed on iOS, window height should match screen height and the
          top/bottom safe insets should be non-zero. A shorter window means iOS
          launched the app with a stale viewport — the app self-corrects; rotating
          the device once also forces it.
        </p>
      </div>
    </div>
  )
}
