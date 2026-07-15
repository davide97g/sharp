import { useMemo } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import MarkdownDisplay, { type RenderRules } from 'react-native-markdown-display'
import { stripResourceTokens } from '../lib/util'

const wordMention = /^[\w][\w-]*/

function mentionText(value: string, names: string[]) {
  const out: React.ReactNode[] = []; let at = 0; let key = 0
  while (at < value.length) { const i = value.indexOf('@', at); if (i < 0) { out.push(value.slice(at)); break }; const boundary = i === 0 || !/[A-Za-z0-9]/.test(value[i - 1]); const after = value.slice(i + 1); const name = boundary ? names.find((n) => after.startsWith(n)) : undefined; const fallback = !name && boundary ? wordMention.exec(after)?.[0] : undefined; const hit = name ?? fallback
    if (!hit) { out.push(value.slice(at, i + 1)); at = i + 1; continue }
    if (i > at) out.push(value.slice(at, i)); out.push(<Text key={`mention-${key++}`} style={styles.mention}>@{hit}</Text>); at = i + 1 + hit.length
  }
  return out
}

export function Markdown({ content, names = [], compact = false }: { content: string; names?: string[]; compact?: boolean }) {
  const sorted = useMemo(() => [...names].filter(Boolean).sort((a, b) => b.length - a.length), [names])
  const rules = useMemo<RenderRules>(() => ({ text: (node) => <Text key={node.key}>{mentionText(node.content, sorted)}</Text>, link: (node, children) => <Text key={node.key} style={styles.link} onPress={() => node.attributes.href && void Linking.openURL(node.attributes.href)}>{children}</Text> }), [sorted])
  return <MarkdownDisplay rules={rules} style={compact ? compactStyles : markdownStyles}>{stripResourceTokens(content)}</MarkdownDisplay>
}

const base = { color: '#344054', fontSize: 15, lineHeight: 21 }
const markdownStyles = StyleSheet.create({ body: base, paragraph: { ...base, marginTop: 2, marginBottom: 3 }, strong: { fontWeight: '700' }, em: { fontStyle: 'italic' }, s: { textDecorationLine: 'line-through' }, code_inline: { backgroundColor: '#eaecf0', fontFamily: 'Menlo', fontSize: 13, paddingHorizontal: 3 }, fence: { backgroundColor: '#f2f4f7', color: '#1d2939', fontFamily: 'Menlo', fontSize: 12, padding: 9, borderRadius: 6 }, blockquote: { borderLeftWidth: 3, borderColor: '#98a2b3', paddingLeft: 9, color: '#667085' }, bullet_list: { marginVertical: 3 }, ordered_list: { marginVertical: 3 }, list_item: { flexDirection: 'row' }, heading1: { fontSize: 21, fontWeight: '700' }, heading2: { fontSize: 18, fontWeight: '700' }, heading3: { fontSize: 16, fontWeight: '700' } })
const compactStyles = StyleSheet.create({ ...markdownStyles, body: { color: '#475467', fontSize: 13, lineHeight: 18 }, paragraph: { color: '#475467', fontSize: 13, lineHeight: 18, marginVertical: 0 }, fence: { fontSize: 11, padding: 6 } })
const styles = StyleSheet.create({ mention: { color: '#444ce7', fontWeight: '700', backgroundColor: '#eef4ff' }, link: { color: '#444ce7', textDecorationLine: 'underline' } })
