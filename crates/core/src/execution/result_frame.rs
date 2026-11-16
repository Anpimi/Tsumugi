//! Local execution record encoding. The SDK process and IPC envelope stay JSON.

use tsumugi_plugin_sdk as sdk;

use super::{ErrorCode, ExecutionError, FixedInput, ResultEnvelope, codec, plugin};

// The NUL distinguishes material frames from any valid JSON envelope. The
// compact JSON header has no literal LF; everything after LF is the exact
// original payload, including whitespace and any escapes inside the JSON.
const MATERIAL_PREFIX: &[u8] = b"\x00TSR1";

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

pub(super) fn encode(envelope: &ResultEnvelope, input: &FixedInput) -> Result<Vec<u8>, ExecutionError> {
    let limit = input.envelope().limits.max_result_bytes as usize;
    if !has_separate_payload(envelope, input) {
        return codec::encode(envelope, limit);
    }
    let mut header = envelope.clone();
    let payload = std::mem::replace(
        &mut payload_mut(&mut header).ok_or_else(malformed)?.utf8,
        "".into(),
    );
    let header_limit = limit
        .checked_sub(MATERIAL_PREFIX.len() + 1)
        .and_then(|remaining| remaining.checked_sub(payload.len()))
        .ok_or_else(oversized)?;
    let mut frame = MATERIAL_PREFIX.to_vec();
    codec::encode_to(&header, header_limit, &mut frame)?;
    frame.reserve_exact(1 + payload.len());
    frame.push(b'\n');
    frame.extend_from_slice(payload.as_bytes());
    Ok(frame)
}

pub(super) fn decode(bytes: &[u8], input: &FixedInput) -> Result<ResultEnvelope, ExecutionError> {
    let limit = input.envelope().limits.max_result_bytes as usize;
    if bytes.len() > limit {
        return Err(oversized());
    }
    let Some(material) = bytes.strip_prefix(MATERIAL_PREFIX) else {
        let envelope = codec::decode_frame(bytes, limit)?;
        if has_separate_payload(&envelope, input) {
            return Err(malformed());
        }
        return Ok(envelope);
    };
    if !plugin::stores_output_reference(input) {
        return Err(malformed());
    }
    let end = material
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or_else(malformed)?;
    let (header, payload) = material.split_at(end);
    let mut envelope = codec::decode_frame(header, limit)?;
    let output = payload_mut(&mut envelope).filter(|raw| raw.utf8.is_empty()).ok_or_else(malformed)?;
    output.utf8 = std::str::from_utf8(&payload[1..]).map_err(|_| malformed())?.into();
    // The caller validates the complete envelope, including the raw SDK
    // digest, strict JSON, operation binding, and the original wire limits.
    Ok(envelope)
}
