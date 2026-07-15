import * as Linking from 'expo-linking'
import { useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { api, ApiRequestError } from '../src/lib/api'
import { registerForPush } from '../src/lib/push'
import { getServerUrl, setServerUrl, setToken } from '../src/lib/session'
import type { AuthResponse } from '../src/lib/types'
import { useStore } from '../src/store'

function randomState() {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeServerUrl(value: string) {
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`
  return withScheme.replace(/\/+$/, '')
}

function errorMessage(error: unknown) {
  if (error instanceof ApiRequestError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : 'Something went wrong.'
}

export default function LoginScreen() {
  const router = useRouter()
  const setSession = useStore((state) => state.setSession)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [server, setServer] = useState('')
  const [serverLoaded, setServerLoaded] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disabled = busy || !serverLoaded

  useEffect(() => {
    void getServerUrl().then((url) => {
      setServer(url ?? '')
      setServerLoaded(true)
    })
  }, [])

  async function saveServer() {
    const url = normalizeServerUrl(server)
    if (!url || url === 'https:') throw new Error('Enter your Server URL first.')
    await setServerUrl(url)
    setServer(url)
    return url
  }

  async function completeAuth(response: AuthResponse) {
    await setToken(response.token)
    setSession(response.token, response.user)
    router.replace('/(tabs)')
    void registerForPush()
  }

  async function submit() {
    if (busy) return
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      await saveServer()
      const response = mode === 'login'
        ? await api.login(email.trim().toLowerCase(), password)
        : await api.register(email.trim().toLowerCase(), password, displayName.trim())
      await completeAuth(response)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  async function browserLogin() {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const serverUrl = await saveServer()
      const state = randomState()
      const authUrl = `${serverUrl}/desktop-auth?state=${encodeURIComponent(state)}&scheme=sharp`
      const result = await WebBrowser.openAuthSessionAsync(authUrl, 'sharp://auth')
      if (result.type !== 'success') return

      const callback = Linking.parse(result.url)
      const code = typeof callback.queryParams?.code === 'string' ? callback.queryParams.code : null
      const returnedState = typeof callback.queryParams?.state === 'string' ? callback.queryParams.state : null
      if (callback.hostname !== 'auth' || !code || returnedState !== state) {
        throw new Error('The browser login response could not be verified.')
      }
      await completeAuth(await api.desktopExchange(code))
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.title}>sharp</Text>
          <Text style={styles.subtitle}>{mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}</Text>
          <Field label="Server URL" value={server} onChangeText={setServer} placeholder="https://chat.example.com" autoCapitalize="none" keyboardType="url" />
          {mode === 'register' && <Field label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="Ada Lovelace" />}
          <Field label="Email" value={email} onChangeText={setEmail} placeholder="you@example.com" autoCapitalize="none" keyboardType="email-address" />
          <Field label="Password" value={password} onChangeText={setPassword} placeholder="••••••••" secureTextEntry autoCapitalize="none" />
          {error && <Text style={styles.error}>{error}</Text>}
          <Pressable style={[styles.primaryButton, disabled && styles.disabled]} disabled={disabled} onPress={() => void submit()}>
            <Text style={styles.primaryButtonText}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</Text>
          </Pressable>
          <Pressable style={[styles.secondaryButton, disabled && styles.disabled]} disabled={disabled} onPress={() => void browserLogin()}>
            <Text style={styles.secondaryButtonText}>Log in with browser</Text>
          </Pressable>
          <Pressable disabled={disabled} onPress={() => setMode(mode === 'login' ? 'register' : 'login')}>
            <Text style={styles.toggle}>{mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Log in'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Field(props: React.ComponentProps<typeof TextInput> & { label: string }) {
  const { label, ...inputProps } = props
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput style={styles.input} placeholderTextColor="#777" {...inputProps} /></View>
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#101114' }, content: { flexGrow: 1, justifyContent: 'center', padding: 24 }, card: { gap: 14, width: '100%', maxWidth: 420, alignSelf: 'center' }, title: { color: '#fff', fontSize: 30, fontWeight: '700', textAlign: 'center' }, subtitle: { color: '#a8a8ad', fontSize: 16, textAlign: 'center', marginBottom: 14 }, field: { gap: 6 }, label: { color: '#d8d8dc', fontSize: 13, fontWeight: '600' }, input: { borderColor: '#34343a', borderWidth: 1, borderRadius: 8, color: '#fff', backgroundColor: '#1b1c20', fontSize: 16, paddingHorizontal: 12, paddingVertical: 11 }, error: { color: '#ff9b9b', fontSize: 14 }, primaryButton: { alignItems: 'center', backgroundColor: '#258cf4', borderRadius: 8, marginTop: 4, padding: 13 }, primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' }, secondaryButton: { alignItems: 'center', borderColor: '#4b4b52', borderRadius: 8, borderWidth: 1, padding: 13 }, secondaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' }, toggle: { color: '#9bc8ff', fontSize: 14, paddingVertical: 10, textAlign: 'center' }, disabled: { opacity: 0.6 },
})
