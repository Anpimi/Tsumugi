//! Ledger-owned storage for exact input frames. Wire bytes remain unchanged.
//! A frame references bounded immutable chunks; every read checks their actual
//! bytes and then restores the original complete frame and its digest.
use super::{
    ErrorCode, ExecutionError, FixedInput, MAX_FIXED_INPUT_BYTES, codec, error, sql_error,
};
use rusqlite::{
    Connection,
    functions::{Aggregate, Context, FunctionFlags},
    params,
};
use serde::{Deserialize, Serialize};

pub(super) const CHUNK_BYTES: usize = 64 * 1024;
pub(super) const MAX_STORED_INPUT_BYTES: usize = 1280 * 1024;
const MAX_CHUNKS: usize = MAX_FIXED_INPUT_BYTES.div_ceil(CHUNK_BYTES);
pub(super) const TABLE: &str = "CREATE TABLE execution_input_chunks (
    digest TEXT PRIMARY KEY NOT NULL CHECK(length(digest)=64),
    bytes BLOB NOT NULL CHECK(typeof(bytes)='blob' AND length(bytes) BETWEEN 1 AND 65536))";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredInput {
    format: u32,
    raw_bytes: usize,
    chunks: Vec<String>,
}
impl StoredInput {
    fn validate(&self) -> Result<(), ExecutionError> {
        if self.format != 1
            || self.raw_bytes == 0
            || self.raw_bytes > MAX_FIXED_INPUT_BYTES
            || self.chunks.len() != self.raw_bytes.div_ceil(CHUNK_BYTES)
            || self.chunks.len() > MAX_CHUNKS
            || self.chunks.iter().any(|s| {
                s.len() != 64
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(error(ErrorCode::CorruptLedger, "input-storage"));
        }
        Ok(())
    }
}

/// Hashing and reference encoding happen before the write transaction. Chunks
/// borrow the already frozen frame rather than allocating another full copy.
pub(super) struct PreparedInput<'a> {
    encoded: Vec<u8>,
    chunks: Vec<(String, &'a [u8])>,
}
impl<'a> PreparedInput<'a> {
    pub(super) fn capture(input: &'a FixedInput) -> Result<Self, ExecutionError> {
        let chunks: Vec<_> = input
            .bytes()
            .chunks(CHUNK_BYTES)
            .map(|bytes| (codec::digest(bytes), bytes))
            .collect();
        let stored = StoredInput {
            format: 1,
            raw_bytes: input.bytes().len(),
            chunks: chunks.iter().map(|(digest, _)| digest.clone()).collect(),
        };
        stored.validate()?;
        let encoded = codec::encode(&stored, MAX_STORED_INPUT_BYTES)?;
        Ok(Self { encoded, chunks })
    }
    /// The caller's original transaction owns chunks and the attempt together.
    /// An existing digest never justifies accepting altered stored bytes.
    pub(super) fn insert(&self, connection: &Connection) -> Result<&[u8], ExecutionError> {
        for (digest, bytes) in &self.chunks {
            let inserted = connection.execute(
                "INSERT INTO execution_input_chunks(digest,bytes) VALUES (?1,?2) ON CONFLICT(digest) DO NOTHING",
                params![digest, bytes],
            ).map_err(sql_error)?;
            if inserted == 0 {
                let same: bool = connection.query_row(
                    "SELECT typeof(bytes)='blob' AND bytes=?2 FROM execution_input_chunks WHERE digest=?1",
                    params![digest, bytes], |row| row.get(0),
                ).map_err(sql_error)?;
                if !same {
                    return Err(error(ErrorCode::CorruptLedger, "input-chunk"));
                }
            }
        }
        Ok(&self.encoded)
    }
}

// One correlated aggregate stays inside the caller's read snapshot and parent
// SELECT. It does not open connections or introduce per-frame SQL round trips.
// Input metadata and blobs are bounded before SQLite parses or copies them.
pub(super) fn reconstruct_sql() -> String {
    format!("(SELECT tsumugi_input_chunks(part.key,part.value,
        CASE WHEN typeof(c.bytes)='blob' AND length(c.bytes) BETWEEN 1 AND {CHUNK_BYTES} THEN c.bytes END)
        FROM json_each(CASE WHEN typeof(a.input)='blob' AND length(a.input) BETWEEN 1 AND {MAX_STORED_INPUT_BYTES}
            THEN CASE WHEN json_valid(CAST(a.input AS TEXT)) THEN CAST(a.input AS TEXT) END END,'$.chunks') part
        LEFT JOIN execution_input_chunks c ON c.digest=part.value)")
}
pub(super) fn metadata_sql() -> String {
    format!(
        "CASE WHEN typeof(a.input)='blob' AND length(a.input) BETWEEN 1 AND {MAX_STORED_INPUT_BYTES} THEN a.input END"
    )
}
pub(super) fn reconstructed_bytes(
    stored: Option<Vec<u8>>,
    bytes: Option<Vec<u8>>,
) -> Result<Vec<u8>, ExecutionError> {
    let stored = stored.as_deref().ok_or_else(|| error(ErrorCode::CorruptLedger, "input-storage"))?;
    let manifest = read_manifest(stored)?;
    let bytes = bytes.ok_or_else(|| error(ErrorCode::CorruptLedger, "input-chunks"))?;
    if bytes.len() != manifest.raw_bytes {
        return Err(error(ErrorCode::CorruptLedger, "input-storage"));
    }
    Ok(bytes)
}

fn read_manifest(stored: &[u8]) -> Result<StoredInput, ExecutionError> {
    if stored.len() > MAX_STORED_INPUT_BYTES {
        return Err(error(ErrorCode::CorruptLedger, "input-storage"));
    }
    let manifest: StoredInput = serde_json::from_slice(stored)
        .map_err(|_| error(ErrorCode::CorruptLedger, "input-storage"))?;
    manifest.validate()?;
    if !codec::matches_encoding(&manifest, MAX_STORED_INPUT_BYTES, stored)? {
        return Err(error(ErrorCode::CorruptLedger, "input-storage"));
    }
    Ok(manifest)
}

/// Assemble one exact frame directly from bounded SQLite row slices. The
/// parent read pins the attempt manifest and its chunks to the same snapshot.
pub(super) fn read_frame(
    connection: &Connection,
    stored: &[u8],
) -> Result<(Vec<u8>, String), ExecutionError> {
    use aws_lc_rs::digest::{Context, SHA256};
    let manifest = read_manifest(stored)?;
    let mut bytes = vec![0; manifest.raw_bytes];
    let mut frame_digest = Some(Context::new(&SHA256));
    visit_chunks(connection, stored, &manifest, |index, count, start, chunk| {
        // json_each normally yields array order. Hash the assembled frame
        // instead if an SQLite plan changes the traversal order.
        if index != count {
            frame_digest = None;
        }
        if let Some(digest) = &mut frame_digest {
            digest.update(chunk);
        }
        bytes[start..start + chunk.len()].copy_from_slice(chunk);
        Ok(())
    })?;
    let digest = match frame_digest {
        Some(hash) => codec::digest_hex(hash.finish()),
        None => codec::digest(&bytes),
    };
    Ok((bytes, digest))
}

pub(super) fn check_frame(connection: &Connection, stored: &[u8], expected: &[u8]) -> Result<(), ExecutionError> {
    let manifest = read_manifest(stored)?;
    if manifest.raw_bytes != expected.len() {
        return Err(error(ErrorCode::CorruptLedger, "input-bytes"));
    }
    visit_chunks(connection, stored, &manifest, |_, _, start, chunk| {
        if expected.get(start..start + chunk.len()) != Some(chunk) {
            return Err(error(ErrorCode::CorruptLedger, "input-bytes"));
        }
        Ok(())
    })
}

fn visit_chunks(
    connection: &Connection,
    stored: &[u8],
    manifest: &StoredInput,
    mut visit: impl FnMut(usize, usize, usize, &[u8]) -> Result<(), ExecutionError>,
) -> Result<(), ExecutionError> {
    let mut statement = connection.prepare_cached(&format!(
        "SELECT part.key, CASE WHEN typeof(c.bytes)='blob' AND length(c.bytes) BETWEEN 1 AND {CHUNK_BYTES} THEN c.bytes END
         FROM json_each(CAST(?1 AS TEXT),'$.chunks') part
         LEFT JOIN execution_input_chunks c ON c.digest=part.value"
    )).map_err(sql_error)?;
    let mut rows = statement.query([stored]).map_err(sql_error)?;
    let invalid = || error(ErrorCode::CorruptLedger, "input-chunk");
    let mut count = 0;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let index = usize::try_from(row.get::<_, i64>(0).map_err(sql_error)?)
            .map_err(|_| invalid())?;
        let digest = manifest.chunks.get(index).ok_or_else(invalid)?;
        let start = index * CHUNK_BYTES;
        let end = (start + CHUNK_BYTES).min(manifest.raw_bytes);
        let chunk = row.get_ref(1).map_err(sql_error)?.as_blob().map_err(|_| invalid())?;
        if chunk.len() != end - start || !codec::matches_digest(chunk, digest) {
            return Err(invalid());
        }
        visit(index, count, start, chunk)?;
        count += 1;
    }
    // Each array index has at most one joined row because digest is the PK.
    if count != manifest.chunks.len() {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn restore(
    stored: Option<Vec<u8>>,
    bytes: Option<Vec<u8>>,
    digest: &str,
) -> Result<FixedInput, ExecutionError> {
    FixedInput::restore_owned(reconstructed_bytes(stored, bytes)?, digest)
}

pub(super) fn register(connection: &Connection) -> rusqlite::Result<()> {
    connection.create_aggregate_function(
        c"tsumugi_input_chunks",
        3,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        InputChunks,
    )
}
struct InputChunks;
struct Pieces {
    pieces: Vec<Option<Vec<u8>>>,
    bytes: usize,
    valid: bool,
}
impl Aggregate<Pieces, Option<Vec<u8>>> for InputChunks {
    fn init(&self, _: &mut Context<'_>) -> rusqlite::Result<Pieces> {
        Ok(Pieces {
            pieces: Vec::new(),
            bytes: 0,
            valid: true,
        })
    }
    fn step(&self, ctx: &mut Context<'_>, state: &mut Pieces) -> rusqlite::Result<()> {
        if !state.valid {
            return Ok(());
        }
        let parsed = (
            ctx.get_raw(0).as_i64(),
            ctx.get_raw(1).as_str(),
            ctx.get_raw(2).as_blob(),
        );
        let (Ok(index), Ok(digest), Ok(bytes)) = parsed else {
            state.valid = false;
            return Ok(());
        };
        if index < 0
            || index as usize >= MAX_CHUNKS
            || bytes.is_empty()
            || bytes.len() > CHUNK_BYTES
            || bytes.len() > MAX_FIXED_INPUT_BYTES.saturating_sub(state.bytes)
            || !codec::matches_digest(bytes, digest)
        {
            state.valid = false;
            return Ok(());
        }
        let index = index as usize;
        state
            .pieces
            .resize_with(state.pieces.len().max(index + 1), || None);
        if state.pieces[index].is_some() {
            state.valid = false;
            return Ok(());
        }
        state.bytes += bytes.len();
        state.pieces[index] = Some(bytes.to_vec());
        Ok(())
    }
    fn finalize(
        &self,
        _: &mut Context<'_>,
        state: Option<Pieces>,
    ) -> rusqlite::Result<Option<Vec<u8>>> {
        let Some(state) = state else {
            return Ok(None);
        };
        if !state.valid || state.pieces.is_empty() {
            return Ok(None);
        }
        let count = state.pieces.len();
        let mut bytes = Vec::with_capacity(state.bytes);
        for (index, piece) in state.pieces.into_iter().enumerate() {
            let Some(piece) = piece else {
                return Ok(None);
            };
            if index + 1 < count && piece.len() != CHUNK_BYTES {
                return Ok(None);
            }
            bytes.extend_from_slice(&piece);
        }
        // NULL carries a failed reconstruction, never an empty valid frame.
        // Every ledger consumer maps it to CorruptLedger before using a result.
        Ok(Some(bytes))
    }
}

pub(super) fn validate_chunks(connection: &Connection, unreferenced_only: bool) -> Result<(), ExecutionError> {
    // An open snapshot has already validated every manifest and its referenced
    // chunks. The index can exclude those digests without rereading their BLOBs.
    let (prefix, scan) = if unreferenced_only {
        ("WITH referenced(digest) AS MATERIALIZED (
             SELECT DISTINCT part.value FROM execution_attempts a, json_each(CAST(a.input AS TEXT),'$.chunks') part
         )",
         "execution_input_chunks c INDEXED BY sqlite_autoindex_execution_input_chunks_1
          WHERE NOT EXISTS (SELECT 1 FROM referenced r WHERE r.digest=c.digest)")
    } else {
        ("", "execution_input_chunks c")
    };
    let mut statement = connection.prepare(&format!(
        "{prefix}
         SELECT c.digest,CASE WHEN typeof(c.bytes)='blob' AND length(c.bytes) BETWEEN 1 AND {CHUNK_BYTES} THEN c.bytes END
         FROM {scan}"
    )).map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let digest = row.get_ref(0).map_err(sql_error)?.as_str()
            .map_err(|_| error(ErrorCode::CorruptLedger, "input-chunk"))?;
        let bytes = row.get_ref(1).map_err(sql_error)?.as_blob()
            .map_err(|_| error(ErrorCode::CorruptLedger, "input-chunk"))?;
        if !codec::matches_digest(bytes, digest) {
            return Err(error(ErrorCode::CorruptLedger, "input-chunk"));
        }
    }
    Ok(())
}
