use crate::config::LiveKitConfig;
use livekit_api::access_token::{AccessToken, VideoGrants};
use livekit_api::services::room::{RoomClient, UpdateParticipantOptions};
use livekit_protocol::{ParticipantPermission, RoomConfiguration, TrackSource};
use serde::Serialize;
use std::time::Duration;
use uuid::Uuid;

pub const MAX_PARTICIPANTS: usize = 25;
pub const MAX_CAMERAS: usize = 16;

#[derive(Clone, Serialize)]
pub struct MediaCredentials {
    pub provider: &'static str,
    pub server_url: String,
    pub participant_token: String,
    pub participant_identity: String,
}

pub fn room_name(room_id: Uuid) -> String {
    format!("sharp:{}", room_id)
}

pub fn join_credentials(
    config: &LiveKitConfig,
    room_id: Uuid,
    conn_id: Uuid,
    user_id: Uuid,
    display_name: &str,
    guest: bool,
) -> Result<MediaCredentials, livekit_api::access_token::AccessTokenError> {
    let room = room_name(room_id);
    let identity = conn_id.to_string();
    let metadata = serde_json::json!({
        "user_id": user_id,
        "guest": guest,
    })
    .to_string();
    let token = AccessToken::with_api_key(&config.api_key, &config.api_secret)
        .with_ttl(Duration::from_secs(60))
        .with_identity(&identity)
        .with_name(display_name)
        .with_metadata(&metadata)
        .with_grants(VideoGrants {
            room_join: true,
            room: room.clone(),
            can_publish: true,
            can_subscribe: true,
            can_publish_data: false,
            can_publish_sources: vec!["microphone".to_string()],
            ..Default::default()
        })
        .with_room_config(RoomConfiguration {
            name: room,
            empty_timeout: 60,
            departure_timeout: 20,
            max_participants: MAX_PARTICIPANTS as u32,
            ..Default::default()
        })
        .to_jwt()?;

    Ok(MediaCredentials {
        provider: "livekit",
        server_url: config.url.clone(),
        participant_token: token,
        participant_identity: identity,
    })
}

fn room_client(config: &LiveKitConfig) -> RoomClient {
    RoomClient::with_api_key(&config.internal_url, &config.api_key, &config.api_secret)
        .with_failover(false)
        .with_request_timeout(Duration::from_secs(4))
}

pub async fn set_publish_permissions(
    config: &LiveKitConfig,
    room_id: Uuid,
    conn_id: Uuid,
    camera: bool,
    screen: bool,
) -> Result<(), livekit_api::services::ServiceError> {
    let mut sources = vec![TrackSource::Microphone as i32];
    if camera {
        sources.push(TrackSource::Camera as i32);
    }
    if screen {
        sources.push(TrackSource::ScreenShare as i32);
        sources.push(TrackSource::ScreenShareAudio as i32);
    }
    room_client(config)
        .update_participant(
            &room_name(room_id),
            &conn_id.to_string(),
            UpdateParticipantOptions {
                permission: Some(ParticipantPermission {
                    can_subscribe: true,
                    can_publish: true,
                    can_publish_data: false,
                    can_publish_sources: sources,
                    can_update_metadata: false,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await?;
    Ok(())
}

pub async fn remove_participant(config: &LiveKitConfig, room_id: Uuid, conn_id: Uuid) {
    if let Err(error) = room_client(config)
        .remove_participant(&room_name(room_id), &conn_id.to_string())
        .await
    {
        tracing::debug!(
            "LiveKit participant removal skipped for room {} conn {}: {}",
            room_id,
            conn_id,
            error
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use livekit_api::access_token::Claims;

    #[test]
    fn join_token_is_room_bound_and_microphone_only() {
        let config = LiveKitConfig {
            url: "wss://media.example.test".into(),
            internal_url: "http://livekit:7880".into(),
            api_key: "test-key".into(),
            api_secret: "test-secret-at-least-32-characters".into(),
        };
        let room_id = Uuid::new_v4();
        let conn_id = Uuid::new_v4();
        let credentials =
            join_credentials(&config, room_id, conn_id, Uuid::new_v4(), "Ada", false).unwrap();
        let claims = Claims::from_unverified(&credentials.participant_token).unwrap();
        assert_eq!(claims.sub, conn_id.to_string());
        assert_eq!(claims.video.room, room_name(room_id));
        assert_eq!(claims.video.can_publish_sources, vec!["microphone"]);
        assert!(!claims.video.can_publish_data);
        assert_eq!(claims.room_config.unwrap().max_participants, 25);
    }
}
