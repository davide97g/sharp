import { Image } from 'expo-image'
import { StyleSheet, Text, View } from 'react-native'
import type { Attachment as AttachmentType } from '../lib/types'
import { attachmentAbsoluteUrl } from '../lib/api'
import { getTokenSync } from '../lib/session'
import { fmtBytes } from '../lib/util'
export function Attachment({ attachment }: { attachment: AttachmentType }) { const source = { uri: attachmentAbsoluteUrl(attachment.url), headers: getTokenSync() ? { Authorization: `Bearer ${getTokenSync()}` } : undefined }; if (attachment.content_type.startsWith('image/') && attachment.content_type !== 'image/svg+xml') return <Image source={source} style={styles.image} contentFit="contain" accessibilityLabel={attachment.filename} />; return <View style={styles.file}><Text style={styles.fileName} numberOfLines={1}>📎 {attachment.filename}</Text><Text style={styles.size}>{fmtBytes(attachment.size)}</Text></View> }
const styles = StyleSheet.create({ image: { width: 250, height: 190, borderRadius: 10, backgroundColor: '#f2f4f7', marginTop: 6 }, file: { marginTop: 6, borderWidth: 1, borderColor: '#d8dce3', borderRadius: 9, padding: 9, maxWidth: 260 }, fileName: { color: '#344054', fontSize: 14 }, size: { color: '#667085', fontSize: 12, marginTop: 2 } })
