import { Image } from 'expo-image'
import { StyleSheet, Text, View } from 'react-native'
import { attachmentAbsoluteUrl } from '../lib/api'
import { getTokenSync } from '../lib/session'
import { avatarColor, initials } from '../lib/util'

export function Avatar({ id, name, url, size = 36, online }: { id: string; name: string; url?: string | null; size?: number; online?: boolean }) {
  const source = url ? { uri: attachmentAbsoluteUrl(url), headers: getTokenSync() ? { Authorization: `Bearer ${getTokenSync()}` } : undefined } : null
  return <View style={[styles.wrap, { width: size, height: size }]}>{source ? <Image source={source} style={[styles.image, { borderRadius: Math.max(7, size * .28) }]} contentFit="cover" accessibilityLabel={name} /> : <View style={[styles.fallback, { backgroundColor: avatarColor(id), borderRadius: Math.max(7, size * .28) }]}><Text style={[styles.initials, { fontSize: size * .38 }]}>{initials(name)}</Text></View>}{online !== undefined && <View style={[styles.dot, { backgroundColor: online ? '#31a06a' : '#9ca3af' }]} />}</View>
}
const styles = StyleSheet.create({ wrap: { position: 'relative' }, image: { width: '100%', height: '100%' }, fallback: { flex: 1, alignItems: 'center', justifyContent: 'center' }, initials: { color: 'white', fontWeight: '700' }, dot: { position: 'absolute', right: -2, bottom: -2, width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: 'white' } })
