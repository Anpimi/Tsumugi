//! Local execution record encoding. The SDK process and IPC envelope stay JSON.

use std::{borrow::Cow, sync::Arc};

use tsumugi_plugin_sdk as sdk;

use super::{ErrorCode, ExecutionError, FixedInput, ResultEnvelope, codec, plugin};

// The NUL distinguishes material frames from any valid JSON envelope. The
// compact JSON header has no literal LF; everything after LF is the exact
// original payload, including whitespace and any escapes inside the JSON.
const MATERIAL_PREFIX: &[u8] = b"\x00TSR1";

#[derive(Clone, Debug)]
pub(super) enum Frame {
    Json(Arc<Vec<u8>>),
    Material(Arc<String>),
}

impl Frame {
    pub(super) fn bytes(&self) -> &[u8] {
        match self {
            Self::Json(bytes) => bytes,
            Self::Material(text) => text.as_bytes(),
        }
    }
}

fn malformed() -> ExecutionError {
    ExecutionError::new(ErrorCode::InvalidInput, "result-frame")
}

fn oversized() -> ExecutionError {
    ExecutionError::new(ErrorCode::LimitExceeded, "result-frame")
}

fn has_separate_payload(envelope: &ResultEnvelope, input: &FixedInput) -> bool {
    plugin::stores_output_reference(input)
        && envelope.plugin.as_ref().is_some_and(|evidence| {
            matches!(evidence.result.outcome, sdk::InvocationOutcome::Succeeded { .. })
        })
}

fn payload_mut(envelope: &mut ResultEnvelope) -> Option<&mut sdk::EncodedPayload> {
    match &mut envelope.plugin.as_mut()?.result.outcome {
        sdk::InvocationOutcome::Succeeded { output } => Some(output),
        _ => None,
    }
}

fn attach_payload(
    envelope: &mut ResultEnvelope,
    bytes: Vec<u8>,
    start: usize,
) -> Result<Frame, ExecutionError> {
    let output = payload_mut(envelope)
        .filter(|output| output.utf8.is_empty())
        .ok_or_else(malformed)?;
    let text = Arc::new(String::from_utf8(bytes).map_err(|_| malformed())?);
    output.utf8 = sdk::PayloadText::from_suffix(Arc::clone(&text), start).ok_or_else(malformed)?;
    Ok(Frame::Material(text))
}

pub(super) fn encode(
    envelope: &mut ResultEnvelope,
    input: &FixedInput,
) -> Result<Frame, ExecutionError> {
    let limit = input.envelope().limits.max_result_bytes as usize;
    if !has_separate_payload(envelope, input) {
        return Ok(Frame::Json(Arc::new(codec::encode(envelope, limit)?)));
    }
    let payload = std::mem::take(&mut payload_mut(envelope).ok_or_else(malformed)?.utf8);
    let header_limit = limit
        .checked_sub(MATERIAL_PREFIX.len() + 1)
        .and_then(|remaining| remaining.checked_sub(payload.len()))
        .ok_or_else(oversized)?;
    let mut frame = MATERIAL_PREFIX.to_vec();
    codec::encode_to(envelope, header_limit, &mut frame)?;
    frame.reserve_exact(1 + payload.len());
    frame.push(b'\n');
    let start = frame.len();
    frame.extend_from_slice(payload.as_bytes());
    drop(payload);
    attach_payload(envelope, frame, start)
}

pub(super) fn decode(
    bytes: Cow<'_, [u8]>,
    input: &FixedInput,
) -> Result<(ResultEnvelope, Frame), ExecutionError> {
    let limit = input.envelope().limits.max_result_bytes as usize;
    if bytes.len() > limit {
        return Err(oversized());
    }
    let Some(material) = bytes.strip_prefix(MATERIAL_PREFIX) else {
        let envelope = codec::decode_frame(&bytes, limit)?;
        if has_separate_payload(&envelope, input) {
            return Err(malformed());
        }
        return Ok((envelope, Frame::Json(Arc::new(bytes.into_owned()))));
    };
    if !plugin::stores_output_reference(input) {
        return Err(malformed());
    }
    let end = material
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or_else(malformed)?;
    let mut envelope = codec::decode_frame(&material[..end], limit)?;
    let frame = attach_payload(&mut envelope, bytes.into_owned(), MATERIAL_PREFIX.len() + end + 1)?;
    // The caller validates the complete envelope, including the raw SDK
    // digest, strict JSON, operation binding, and the original wire limits.
    Ok((envelope, frame))
}
