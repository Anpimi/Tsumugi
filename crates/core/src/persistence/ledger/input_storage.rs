//! Ledger-owned storage for exact input frames. Wire bytes remain unchanged.
//! A frame references bounded immutable chunks; every read checks their actual
//! bytes and then restores the original complete frame and its digest.
use super::{ErrorCode, ExecutionError, FixedInput, MAX_INPUT_BYTES, codec, error, sql_error};
use rusqlite::{
    Connection,
    functions::{Aggregate, Context, FunctionFlags},
    params,
};
use serde::{Deserialize, Serialize};

pub(super) const CHUNK_BYTES: usize = 16 * 1024;
pub(super) const MAX_STORED_INPUT_BYTES: usize = 18 * 1024;
const MAX_CHUNKS: usize = MAX_INPUT_BYTES.div_ceil(CHUNK_BYTES);
pub(super) const TABLE: &str = "CREATE TABLE execution_input_chunks (
    digest TEXT PRIMARY KEY NOT NULL CHECK(length(digest)=64),
    bytes BLOB NOT NULL CHECK(typeof(bytes)='blob' AND length(bytes) BETWEEN 1 AND 16384))";

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
            || self.raw_bytes > MAX_INPUT_BYTES
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
    let stored = stored.ok_or_else(|| error(ErrorCode::CorruptLedger, "input-storage"))?;
    let manifest: StoredInput = codec::decode(&stored, MAX_STORED_INPUT_BYTES)
        .map_err(|_| error(ErrorCode::CorruptLedger, "input-storage"))?;
    manifest.validate()?;
    if codec::encode(&manifest, MAX_STORED_INPUT_BYTES)? != stored {
        return Err(error(ErrorCode::CorruptLedger, "input-storage"));
    }
    let bytes = bytes.ok_or_else(|| error(ErrorCode::CorruptLedger, "input-chunks"))?;
    if bytes.len() != manifest.raw_bytes {
        return Err(error(ErrorCode::CorruptLedger, "input-storage"));
    }
    Ok(bytes)
}
pub(super) fn restore(
    stored: Option<Vec<u8>>,
    bytes: Option<Vec<u8>>,
    digest: &str,
) -> Result<FixedInput, ExecutionError> {
    FixedInput::restore(&reconstructed_bytes(stored, bytes)?, digest)
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
            || bytes.len() > MAX_INPUT_BYTES.saturating_sub(state.bytes)
            || codec::digest(bytes) != digest
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

pub(super) fn validate_chunks(connection: &Connection) -> Result<(), ExecutionError> {
    let mut statement = connection.prepare(&format!(
        "SELECT digest,CASE WHEN typeof(bytes)='blob' AND length(bytes) BETWEEN 1 AND {CHUNK_BYTES} THEN bytes END FROM execution_input_chunks"
    )).map_err(sql_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?))
        })
        .map_err(sql_error)?;
    for row in rows {
        let (digest, bytes) = row.map_err(sql_error)?;
        let bytes = bytes.ok_or_else(|| error(ErrorCode::CorruptLedger, "input-chunk"))?;
        if codec::digest(&bytes) != digest {
            return Err(error(ErrorCode::CorruptLedger, "input-chunk"));
        }
    }
    Ok(())
}
