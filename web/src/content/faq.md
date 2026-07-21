## What is sharp?

sharp is a self-hosted workspace for chat, collaborative docs and canvases, meetings, voice/video calls, and calendars. Your organization runs the server and owns its data.

## Who can see a channel?

Public channels are visible to everyone in the workspace. Private channels and direct messages are limited to their members. Owners manage membership and roles; editors can contribute; viewers have read-only access where supported.

## Are documents and canvases private?

They follow their channel's access by default. Owners can also set document-specific access. Live access changes take effect immediately, including for an open editor.

## How do notifications work?

Direct messages, mentions, and replies appear in the inbox. Depending on your device and permissions, sharp can also show browser, desktop, or web-push notifications. Muted channels suppress notifications; Do Not Disturb keeps inbox items but silences push alerts.

## Are calls recorded?

Calls are not recorded by default. Media is transport-encrypted and relayed through your self-hosted LiveKit SFU; it is not end-to-end encrypted from that SFU. Meeting notes use optional speech transcription. Each participant is asked before their microphone transcript is shared, and declining does not prevent joining the call.

## Can guests join calls?

Channel owners and editors can create guest call links. Guests receive limited access to that call only. Regenerating the link revokes the previous one.

## Does Google Calendar access allow sharp to edit my calendar?

No. Google Calendar sync is read-only. Meetings created in sharp stay in sharp.

## Where is my data stored?

Workspace data lives in the self-hosted Postgres database. Attachments use the configured S3-compatible storage. Optional Redis supports real-time fanout across multiple server replicas.

## Which platforms are supported?

Use sharp in a modern browser or through the Tauri desktop app on macOS, Windows, and Linux.
