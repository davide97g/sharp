import { Tabs } from 'expo-router'
import { useStore } from '../../src/store'

export default function TabsLayout() {
  const unread = useStore((state) => state.totalUnread())
  const notifications = useStore((state) => state.notifUnread)
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: 'Chats', tabBarBadge: unread || undefined }} />
      <Tabs.Screen name="activity" options={{ title: 'Activity', tabBarBadge: notifications || undefined }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  )
}
