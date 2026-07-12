//! S3-compatible object storage for file uploads.
//!
//! Backed by `object_store`, so the same code targets AWS S3, MinIO, Cloudflare R2,
//! Backblaze B2, etc. Uploads and downloads are both proxied through the server
//! (never presigned to the browser) so channel-membership auth is always enforced.

use crate::config::S3Config;
use bytes::Bytes;
use object_store::aws::AmazonS3Builder;
use object_store::{path::Path as ObjPath, GetResult, ObjectStore};
use std::sync::Arc;

#[derive(Clone)]
pub struct Storage {
    store: Arc<dyn ObjectStore>,
}

impl Storage {
    pub fn from_config(c: &S3Config) -> Result<Self, String> {
        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(&c.bucket)
            .with_region(&c.region)
            .with_access_key_id(&c.access_key)
            .with_secret_access_key(&c.secret_key);
        if let Some(endpoint) = &c.endpoint {
            builder = builder.with_endpoint(endpoint);
        }
        if c.allow_http {
            builder = builder.with_allow_http(true);
        }
        let store = builder.build().map_err(|e| format!("s3 init: {e}"))?;
        Ok(Storage {
            store: Arc::new(store),
        })
    }

    pub async fn put(&self, key: &str, bytes: Bytes) -> object_store::Result<()> {
        self.store.put(&ObjPath::from(key), bytes.into()).await?;
        Ok(())
    }

    pub async fn get(&self, key: &str) -> object_store::Result<GetResult> {
        self.store.get(&ObjPath::from(key)).await
    }

    // Reserved for future cleanup of orphaned / deleted-message uploads.
    #[allow(dead_code)]
    pub async fn delete(&self, key: &str) -> object_store::Result<()> {
        self.store.delete(&ObjPath::from(key)).await
    }
}
