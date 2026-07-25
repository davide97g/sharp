// Calendar reducers shared by the store actions and the WS event handler.
//
// Contract: docs/arch/07-calendar.md.
//
// Google-synced events and sharp-native scheduled meetings live in one `CalendarItem`
// list, distinguished by `source`. A native meeting that Google also returns must not
// appear twice, which is what `upsertMeetingItem` is for.

import type { CalendarItem, ScheduledMeeting } from '../types'

export function nativeItemFromMeeting(meeting: ScheduledMeeting): CalendarItem {
  return {
    source: 'native',
    id: meeting.id,
    title: meeting.title,
    start_at: meeting.start_at,
    end_at: meeting.end_at,
    all_day: meeting.all_day,
    join_path: meeting.join_path,
    meeting,
  }
}

export function inCalendarRange(
  range: { from: string; to: string } | null,
  iso: string,
): boolean {
  if (!range) return false
  return iso >= range.from && iso < range.to
}

/** Insert/replace a native meeting in the item list, honoring the loaded range. */
export function upsertMeetingItem(
  items: CalendarItem[],
  range: { from: string; to: string } | null,
  meeting: ScheduledMeeting,
): CalendarItem[] {
  const filtered = items.filter(
    (i) => !(i.source === 'native' && i.meeting.id === meeting.id),
  )
  if (meeting.status === 'cancelled') return filtered
  if (!inCalendarRange(range, meeting.start_at)) return filtered
  return [...filtered, nativeItemFromMeeting(meeting)]
}

export function applyMyRsvp(
  meeting: ScheduledMeeting,
  myUserId: string | null,
  response: string,
): ScheduledMeeting {
  return {
    ...meeting,
    my_response: response,
    attendees: meeting.attendees.map((a) =>
      a.user_id === myUserId ? { ...a, response } : a,
    ),
  }
}
