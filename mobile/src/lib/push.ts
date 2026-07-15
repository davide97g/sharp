import AsyncStorage from '@react-native-async-storage/async-storage'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { AppState, Platform } from 'react-native'

import { api } from './api'
import { useStore } from '../store'
import type { Notification } from './types'

const EXPO_PUSH_TOKEN_KEY = 'sharp.expoPushToken'
let registeredToken: string | null = null

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const channelId = notification.request.content.data?.channel_id
    const viewingChannel = typeof channelId === 'string' && channelId === useStore.getState().currentChannelId && AppState.currentState === 'active'
    return {
    shouldShowBanner: !viewingChannel,
    shouldShowList: !viewingChannel,
    shouldPlaySound: !viewingChannel,
    shouldSetBadge: true,
    }
  },
})

export async function registerForPush() {
  if (!Device.isDevice) return

  try {
    const current = await Notifications.getPermissionsAsync()
    const permission = current.granted ? current : await Notifications.requestPermissionsAsync()
    if (!permission.granted) return

    const projectId = Constants.expoConfig?.extra?.eas?.projectId
    if (!projectId) {
      console.warn('Push registration skipped: EAS projectId is not configured.')
      return
    }

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data
    await api.registerExpoToken(token, Platform.OS)
    registeredToken = token
    await AsyncStorage.setItem(EXPO_PUSH_TOKEN_KEY, token)
  } catch (error) {
    console.warn('Push registration failed.', error)
  }
}

export async function clearPushCache() {
  registeredToken = null
  await AsyncStorage.removeItem(EXPO_PUSH_TOKEN_KEY)
}

export async function presentLocalNotification(notification: Notification) {
  const title = notification.kind === 'dm'
    ? notification.actor.display_name
    : `${notification.actor.display_name} in #${notification.channel_name}`
  await Notifications.scheduleNotificationAsync({
    content: { title, body: notification.preview, sound: 'default', data: { channel_id: notification.channel_id, kind: notification.kind } },
    trigger: null,
  })
}

export async function unregisterPush() {
  const token = registeredToken ?? await AsyncStorage.getItem(EXPO_PUSH_TOKEN_KEY)
  if (!token) return

  try {
    await api.unregisterExpoToken(token)
  } catch (error) {
    console.warn('Push unregistration failed.', error)
  } finally {
    registeredToken = null
    await AsyncStorage.removeItem(EXPO_PUSH_TOKEN_KEY)
  }
}

export function notificationChannelId(response: Notifications.NotificationResponse | null | undefined) {
  const channelId = response?.notification.request.content.data?.channel_id
  return typeof channelId === 'string' ? channelId : null
}
