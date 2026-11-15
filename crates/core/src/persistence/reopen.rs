//! Process-local evidence for a cleanly closed project.

use std::fs::{self, File, Metadata};
use std::path::{Path, PathBuf};

#[cfg(unix)]
use aws_lc_rs::digest::{Context, SHA256};
use rusqlite::Connection;
#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::unix::fs::FileExt;

use super::release::ReleaseReadCache;

/// Opaque evidence retained by the session owner. It cannot restore a session,
/// grant authority, or authorize opening a different project.
#[derive(Debug)]
pub struct ProjectReopenProof {
    pub(super) directory: PathBuf,
    pub(super) digest: [u8; 32],
    pub(super) releases: ReleaseReadCache,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FileStamp {
    length: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    unix_identity: (u64, u64, i64, i64),
}

impl FileStamp {
    pub(super) fn read(path: &Path) -> Option<Self> {
        Self::from_metadata(&fs::symlink_metadata(path).ok()?)
    }

    fn from_metadata(metadata: &Metadata) -> Option<Self> {
        if !metadata.is_file() {
            return None;
        }
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(Self {
            length: metadata.len(),
            modified: metadata.modified().ok()?,
            #[cfg(unix)]
            unix_identity: (
                metadata.dev(),
                metadata.ino(),
                metadata.ctime(),
                metadata.ctime_nsec(),
            ),
        })
    }

    pub(super) fn same_file(&self, other: &Self) -> bool {
        #[cfg(unix)]
        return self.unix_identity.0 == other.unix_identity.0
            && self.unix_identity.1 == other.unix_identity.1;
        #[cfg(not(unix))]
        {
            let _ = other;
            false
        }
    }
}

#[derive(Debug)]
pub(super) struct OpenBasis {
    file: FileStamp,
    data_version: i64,
    schema_version: i64,
    total_changes: u64,
}

impl OpenBasis {
    pub(super) fn read(connection: &Connection, file: FileStamp) -> Option<Self> {
        Some(Self {
            file,
            data_version: connection
                .pragma_query_value(None, "data_version", |row| row.get(0))
                .ok()?,
            schema_version: connection
                .pragma_query_value(None, "schema_version", |row| row.get(0))
                .ok()?,
            total_changes: connection.total_changes(),
        })
    }

    pub(super) fn permits_close(&self, current: &Self) -> bool {
        self.data_version == current.data_version
            && self.schema_version == current.schema_version
            && self.file.same_file(&current.file)
            && (self.total_changes != current.total_changes || self.file == current.file)
    }
}

#[cfg(unix)]
pub(super) fn database_digest(path: &Path, file: &File, expected: &FileStamp) -> Option<[u8; 32]> {
    // The caller pins a rollback-journal snapshot and keeps this descriptor
    // open until SQLite releases its POSIX file locks.
    if FileStamp::read(path).as_ref() != Some(expected)
        || FileStamp::from_metadata(&file.metadata().ok()?).as_ref() != Some(expected)
    {
        return None;
    }
    let lanes = if expected.length >= 512 * 1024 * 1024 {
        8
    } else if expected.length >= 64 * 1024 * 1024 {
        4
    } else {
        1
    };
    let buffer_bytes = if lanes == 8 { 1024 * 1024 } else { 256 * 1024 };
    let span = expected.length.div_ceil(lanes);
    let mut combined = Context::new(&SHA256);
    combined.update(&expected.length.to_le_bytes());
    std::thread::scope(|scope| {
        let jobs: Vec<_> = (0..lanes)
            .map(|lane| {
                scope.spawn(move || {
                    let offset = lane * span;
                    digest_range(file, offset, span.min(expected.length - offset), buffer_bytes)
                })
            })
            .collect();
        for job in jobs {
            combined.update(job.join().ok()??.as_ref());
        }
        Some(())
    })?;
    if FileStamp::read(path).as_ref() != Some(expected)
        || FileStamp::from_metadata(&file.metadata().ok()?).as_ref() != Some(expected)
    {
        return None;
    }
    combined.finish().as_ref().try_into().ok()
}

#[cfg(not(unix))]
pub(super) fn database_digest(_: &Path, _: &File, _: &FileStamp) -> Option<[u8; 32]> {
    None
}

#[cfg(unix)]
fn digest_range(
    file: &File,
    mut offset: u64,
    length: u64,
    buffer_bytes: usize,
) -> Option<aws_lc_rs::digest::Digest> {
    let mut digest = Context::new(&SHA256);
    let mut buffer = vec![0; buffer_bytes];
    let mut remaining = length;
    while remaining != 0 {
        let count = remaining.min(buffer.len() as u64) as usize;
        match file.read_at(&mut buffer[..count], offset) {
            Ok(0) => return None,
            Ok(read) => {
                digest.update(&buffer[..read]);
                remaining -= read as u64;
                offset += read as u64;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
    Some(digest.finish())
}
