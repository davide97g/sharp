import { useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { ThreadPanel } from './ThreadPanel'
import { QuickSwitcher } from './QuickSwitcher'
import { useStore } from '../store'

export function AppShell() {
  const setQuickSwitcher = useStore((s) => s.setQuickSwitcher)
  const channels = useStore((s) => s.channels)

  // total unread -> document title
  const totalUnread = channels.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) sharp` : 'sharp'
  }, [totalUnread])

  // ⌘K / Ctrl+K quick switcher
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setQuickSwitcher(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setQuickSwitcher])

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Sidebar />
      <Outlet />
      <ThreadPanel />
      <QuickSwitcher />
    </div>
  )
}
