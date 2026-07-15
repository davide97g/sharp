import { useCallback, useEffect } from 'react'
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native'
import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { Composer } from '../../src/components/Composer'
import { MessageItem } from '../../src/components/MessageItem'
import { useStore } from '../../src/store'

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>(); const thread = useStore((s) => s.thread); const openThread = useStore((s) => s.openThread); const closeThread = useStore((s) => s.closeThread); const channel = useStore((s) => thread.parent ? s.channels.find((c) => c.id === thread.parent?.channel_id) : undefined); const me = useStore((s) => s.me); const online = useStore((s) => s.online)
  useFocusEffect(useCallback(() => { if (id) void openThread(id); return () => closeThread() }, [id, openThread, closeThread]))
  useEffect(() => () => closeThread(), [closeThread])
  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={88}><Stack.Screen options={{ headerShown: true, title: 'Thread' }}/>{thread.loading ? <ActivityIndicator style={{ marginTop: 30 }}/> : !thread.parent || !channel ? <View style={styles.center}><Text>Thread not found.</Text></View> : <><FlatList data={thread.replies} keyExtractor={(m) => m.id} ListHeaderComponent={<><View style={styles.parent}><MessageItem message={thread.parent} grouped={false} bubble={false} mine={thread.parent.user.id === me?.id} online={online.has(thread.parent.user.id)} showThread={false}/></View><Text style={styles.count}>{thread.replies.length} {thread.replies.length === 1 ? 'reply' : 'replies'}</Text></>} renderItem={({ item, index }) => <MessageItem message={item} grouped={index > 0 && thread.replies[index - 1].user.id === item.user.id} bubble={false} mine={item.user.id === me?.id} online={online.has(item.user.id)} showThread={false}/>} contentContainerStyle={{ paddingBottom: 10 }}/><Composer channel={channel} parentId={thread.parent.id} placeholder="Reply…"/></>}</KeyboardAvoidingView>
}
const styles = StyleSheet.create({ page: { flex: 1, backgroundColor: 'white' }, parent: { borderBottomWidth: 1, borderColor: '#d8dce3', paddingBottom: 9 }, count: { color: '#667085', fontWeight: '700', fontSize: 12, paddingHorizontal: 16, paddingTop: 12 }, center: { flex: 1, alignItems: 'center', justifyContent: 'center' } })
