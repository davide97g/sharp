import { fmtDayDivider } from '../lib/util'
import { Divider } from '../ui'

export function DayDivider({ iso }: { iso: string }) {
  return <Divider label={fmtDayDivider(iso)} className="my-2 px-4" />
}
