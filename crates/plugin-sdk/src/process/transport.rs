//! Serial streaming transport. Chunk boundaries carry no domain semantics.
use super::ProcessFrame;
use crate::{MAX_PROCESS_CHUNK_BYTES, MAX_PROCESS_FRAME_BYTES};
use std::io::{self, BufReader, Read, Write};

fn limit() -> io::Error {
    io::Error::new(io::ErrorKind::FileTooLarge, "Process transport limit")
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid process message")
}

/// Read one complete message without first allocating its encoded JSON. The
/// same aggregate counter must be retained for the entire pipe direction.
pub fn read_process_frame(
    reader: &mut impl Read,
    total: &mut usize,
    message_limit: usize,
    session_limit: usize,
) -> io::Result<(ProcessFrame, usize)> {
    let mut message = MessageReader {
        reader,
        total,
        session_limit,
        message_limit: message_limit.min(MAX_PROCESS_FRAME_BYTES),
        bytes: 0,
        remaining: 0,
        ended: false,
    };
    let result = serde_json::from_reader::<_, ProcessFrame>(BufReader::with_capacity(
        MAX_PROCESS_CHUNK_BYTES,
        &mut message,
    ));
    let frame = result.map_err(|error| {
        error
            .io_error_kind()
            .map_or_else(invalid, |kind| io::Error::new(kind, "Process read failed"))
    })?;
    frame.validate().map_err(|_| invalid())?;
    Ok((frame, message.bytes))
}

struct MessageReader<'a, R> {
    reader: &'a mut R,
    total: &'a mut usize,
    session_limit: usize,
    message_limit: usize,
    bytes: usize,
    remaining: usize,
    ended: bool,
}
impl<R: Read> Read for MessageReader<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() || self.ended {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut prefix = [0; 4];
            self.reader.read_exact(&mut prefix)?;
            let length = u32::from_be_bytes(prefix) as usize;
            if length > MAX_PROCESS_CHUNK_BYTES {
                return Err(limit());
            }
            *self.total = self.total.checked_add(length + 4).ok_or_else(limit)?;
            if *self.total > self.session_limit {
                return Err(limit());
            }
            if length == 0 {
                if self.bytes == 0 {
                    return Err(invalid());
                }
                self.ended = true;
                return Ok(0);
            }
            self.bytes = self.bytes.checked_add(length).ok_or_else(limit)?;
            if self.bytes > self.message_limit {
                return Err(limit());
            }
            self.remaining = length;
        }
        let count = output.len().min(self.remaining);
        let count = self.reader.read(&mut output[..count])?;
        if count == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.remaining -= count;
        Ok(count)
    }
}

/// Serialize directly into bounded chunks. A failed write consumes this
/// channel: an incomplete message must never be followed by another message.
/// Returns the JSON byte count (excluding chunk framing).
pub fn write_process_frame(
    writer: &mut impl Write,
    frame: &ProcessFrame,
    total: &mut usize,
    message_limit: usize,
    session_limit: usize,
) -> io::Result<usize> {
    frame.validate().map_err(|_| invalid())?;
    let mut message = MessageWriter {
        writer,
        total,
        session_limit,
        message_limit: message_limit.min(MAX_PROCESS_FRAME_BYTES),
        bytes: 0,
        chunk: Vec::with_capacity(MAX_PROCESS_CHUNK_BYTES),
    };
    serde_json::to_writer(&mut message, frame).map_err(|error| {
        error
            .io_error_kind()
            .map_or_else(invalid, |kind| io::Error::new(kind, "Process write failed"))
    })?;
    message.flush_chunk()?;
    message.write_chunk(&[])?;
    message.writer.flush()?;
    Ok(message.bytes)
}
struct MessageWriter<'a, W> {
    writer: &'a mut W,
    total: &'a mut usize,
    session_limit: usize,
    message_limit: usize,
    bytes: usize,
    chunk: Vec<u8>,
}
impl<W: Write> MessageWriter<'_, W> {
    fn write_chunk(&mut self, bytes: &[u8]) -> io::Result<()> {
        let total = self.total.checked_add(bytes.len() + 4).ok_or_else(limit)?;
        if total > self.session_limit {
            return Err(limit());
        }
        self.writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
        self.writer.write_all(bytes)?;
        *self.total = total;
        Ok(())
    }
    fn flush_chunk(&mut self) -> io::Result<()> {
        if self.chunk.is_empty() {
            return Ok(());
        }
        let chunk = std::mem::replace(&mut self.chunk, Vec::with_capacity(MAX_PROCESS_CHUNK_BYTES));
        self.write_chunk(&chunk)
    }
}
impl<W: Write> Write for MessageWriter<'_, W> {
    fn write(&mut self, mut bytes: &[u8]) -> io::Result<usize> {
        let length = bytes.len();
        self.bytes = self.bytes.checked_add(length).ok_or_else(limit)?;
        if self.bytes > self.message_limit {
            return Err(limit());
        }
        while !bytes.is_empty() {
            let count = bytes.len().min(MAX_PROCESS_CHUNK_BYTES - self.chunk.len());
            self.chunk.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.chunk.len() == MAX_PROCESS_CHUNK_BYTES {
                self.flush_chunk()?;
            }
        }
        Ok(length)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.flush_chunk()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;

    fn large_frame() -> ProcessFrame {
        let document: ExchangeDocument =
            serde_json::from_str(include_str!("../../tests/fixtures/invocation.request.json"))
                .unwrap();
        let ExchangeBody::Request(mut request) = document.body else {
            panic!("request fixture")
        };
        request.input = EncodedPayload::capture(
            request.input.schema.clone(),
            "\u{0001}é星👩🏽‍💻\\\"".repeat(20000),
        )
        .unwrap();
        request.context.input_digest = request.input.sha256.clone();
        ProcessFrame::new(ProcessBody::Invoke(request))
    }
    struct BoundedWriter(Vec<u8>);
    impl Write for BoundedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            assert!(bytes.len() <= MAX_PROCESS_CHUNK_BYTES);
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn streams_large_escaped_unicode_and_preserves_serial_message_boundaries() {
        let frame = large_frame();
        let mut wire = BoundedWriter(Vec::new());
        let mut sent = 0;
        let encoded = write_process_frame(
            &mut wire,
            &frame,
            &mut sent,
            MAX_PROCESS_FRAME_BYTES,
            MAX_PROCESS_SESSION_BYTES,
        )
        .unwrap();
        assert!(encoded > MAX_PROCESS_CHUNK_BYTES);
        assert_eq!(sent, wire.0.len());
        write_process_frame(
            &mut wire,
            &frame,
            &mut sent,
            MAX_PROCESS_FRAME_BYTES,
            MAX_PROCESS_SESSION_BYTES,
        )
        .unwrap();
        let mut reader = wire.0.as_slice();
        let mut received = 0;
        for _ in 0..2 {
            let (actual, size) = read_process_frame(
                &mut reader,
                &mut received,
                MAX_PROCESS_FRAME_BYTES,
                MAX_PROCESS_SESSION_BYTES,
            )
            .unwrap();
            assert_eq!(actual, frame);
            assert_eq!(size, encoded);
        }
        assert!(reader.is_empty());
        assert_eq!(received, sent);
    }
    #[test]
    fn rejects_oversized_chunks_messages_sessions_and_missing_terminators() {
        let oversized = (MAX_PROCESS_CHUNK_BYTES as u32 + 1).to_be_bytes();
        assert_eq!(
            read_process_frame(
                &mut oversized.as_slice(),
                &mut 0,
                MAX_PROCESS_FRAME_BYTES,
                MAX_PROCESS_SESSION_BYTES
            )
            .unwrap_err()
            .kind(),
            io::ErrorKind::FileTooLarge
        );
        let frame = large_frame();
        let mut wire = Vec::new();
        write_process_frame(
            &mut wire,
            &frame,
            &mut 0,
            MAX_PROCESS_FRAME_BYTES,
            MAX_PROCESS_SESSION_BYTES,
        )
        .unwrap();
        for (message, session) in [
            (128, MAX_PROCESS_SESSION_BYTES),
            (MAX_PROCESS_FRAME_BYTES, 128),
        ] {
            assert_eq!(
                read_process_frame(&mut wire.as_slice(), &mut 0, message, session)
                    .unwrap_err()
                    .kind(),
                io::ErrorKind::FileTooLarge
            );
        }
        wire.truncate(wire.len() - 4);
        assert!(
            read_process_frame(
                &mut wire.as_slice(),
                &mut 0,
                MAX_PROCESS_FRAME_BYTES,
                MAX_PROCESS_SESSION_BYTES
            )
            .is_err()
        );
        let mut output = Vec::new();
        assert_eq!(
            write_process_frame(&mut output, &frame, &mut 0, 128, MAX_PROCESS_SESSION_BYTES)
                .unwrap_err()
                .kind(),
            io::ErrorKind::FileTooLarge
        );
        assert!(output.is_empty());
    }
}
