import { StyleSheet, Text, View } from 'react-native'
import { fmtDayDivider } from '../lib/util'
export function DayDivider({ iso }: { iso: string }) { return <View style={styles.row}><View style={styles.line}/><Text style={styles.label}>{fmtDayDivider(iso)}</Text><View style={styles.line}/></View> }
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 10, paddingHorizontal: 16 }, line: { height: StyleSheet.hairlineWidth, backgroundColor: '#d8dce3', flex: 1 }, label: { fontSize: 12, color: '#667085', fontWeight: '600' } })
