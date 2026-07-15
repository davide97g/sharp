import * as SplashScreen from 'expo-splash-screen'
import { Stack, useRouter } from 'expo-router'
import * as Notifications from 'expo-notifications'
import { AppState } from 'react-native'
import { useEffect, useRef } from 'react'

import { api, setUnauthorizedHandler } from '../src/lib/api'
import { clearPushCache, notificationChannelId, registerForPush } from '../src/lib/push'
import { clearToken, getTokenSync, loadSession } from '../src/lib/session'
import { useStore } from '../src/store'

void SplashScreen.preventAutoHideAsync()

export default function RootLayout() {
  const router = useRouter()
  const setSession = useStore((state) => state.setSession)
  const clearSession = useStore((state) => state.clearSession)
  const setTokenReady = useStore((state) => state.setTokenReady)
  const init = useStore((state) => state.init)
  const notifUnread = useStore((state) => state.notifUnread)
  const tokenReady = useStore((state) => state.tokenReady)
  const token = useStore((state) => state.token)
  const handledColdStartNotification = useRef(false)

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void clearPushCache()
      clearSession()
      router.replace('/login')
    })
    return () => setUnauthorizedHandler(() => {})
  }, [clearSession, router])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await loadSession()
        const token = getTokenSync()
        if (!token) {
          if (active) router.replace('/login')
          return
        }
        const me = await api.me()
        if (active) {
          setSession(token, me)
          await init()
          router.replace('/(tabs)')
          void registerForPush()
        }
      } catch {
        await clearToken()
        if (active) {
          clearSession()
          router.replace('/login')
        }
      } finally {
        if (active) setTokenReady(true)
        await SplashScreen.hideAsync()
      }
    })()
    return () => { active = false }
  }, [clearSession, init, router, setSession, setTokenReady])

  useEffect(() => {
    void Notifications.setBadgeCountAsync(notifUnread).catch(() => {})
  }, [notifUnread])

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const { token, tokenReady } = useStore.getState()
      if (!token || !tokenReady) return
      const channelId = notificationChannelId(response)
      if (channelId) router.push(`/channel/${channelId}`)
    })
    return () => subscription.remove()
  }, [router])

  useEffect(() => {
    if (!tokenReady || !token) return
    const subscription = Notifications.addPushTokenListener(() => { void registerForPush() })
    return () => subscription.remove()
  }, [token, tokenReady])

  useEffect(() => {
    if (!tokenReady || !token || handledColdStartNotification.current) return
    handledColdStartNotification.current = true
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      const channelId = notificationChannelId(response)
      if (channelId) router.push(`/channel/${channelId}`)
    }).catch(() => {})
  }, [router, token, tokenReady])

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const ws = useStore.getState().ws
      if (next === 'active') {
        ws?.connect()
        void useStore.getState().refetchDirectory()
      } else {
        ws?.close()
      }
    })
    return () => sub.remove()
  }, [])

  return <Stack screenOptions={{ headerShown: false }} />
}
