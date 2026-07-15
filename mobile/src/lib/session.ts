import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

const TOKEN_KEY = 'sharp.token'
const SERVER_URL_KEY = 'sharp.serverUrl'

let token: string | null = null
let serverUrl: string | null = null
let loadPromise: Promise<void> | null = null

/** Load durable session values once before API or WebSocket use. */
export function loadSession(): Promise<void> {
  if (!loadPromise) {
    loadPromise = Promise.all([
      SecureStore.getItemAsync(TOKEN_KEY),
      AsyncStorage.getItem(SERVER_URL_KEY),
    ]).then(([storedToken, storedServerUrl]) => {
      token = storedToken
      serverUrl = storedServerUrl
    })
  }
  return loadPromise
}

export function getTokenSync(): string | null { return token }
export async function getToken(): Promise<string | null> { await loadSession(); return token }
export async function setToken(value: string) { token = value; await SecureStore.setItemAsync(TOKEN_KEY, value) }
export async function clearToken() { token = null; await SecureStore.deleteItemAsync(TOKEN_KEY) }
export function getServerUrlSync(): string | null { return serverUrl }
export async function getServerUrl(): Promise<string | null> { await loadSession(); return serverUrl }
export async function setServerUrl(value: string) { serverUrl = value.replace(/\/+$/, ''); await AsyncStorage.setItem(SERVER_URL_KEY, serverUrl) }
export function resolveBaseUrl(): string { return (serverUrl ?? '').replace(/\/+$/, '') }
