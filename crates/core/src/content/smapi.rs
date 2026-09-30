use super::*;
use jsonc_parser::{
    CollectOptions, ParseOptions, Scanner, ScannerOptions,
    ast::{Object, Value},
    tokens::Token,
};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

fn check(cancel: &Cancellation, deadline: Instant) -> Result<(), ExecutionError> {
    if cancel.is_requested() {
        return Err(failure(ErrorCode::Cancelled, "cancelled"));
    }
    if Instant::now() > deadline {
        return Err(failure(ErrorCode::OutcomeUnknown, "extract-timeout"));
    }
    Ok(())
}
pub(super) fn parse<'a>(
    raw: &'a str,
    cancel: &Cancellation,
    deadline: Instant,
) -> Result<(Value<'a>, u32), ExecutionError> {
    let offset = if raw.starts_with('\u{feff}') { 3 } else { 0 };
    let text = &raw[offset..];
    let mut scanner = Scanner::new(
        text,
        &ScannerOptions {
            allow_single_quoted_strings: false,
            allow_hexadecimal_numbers: false,
            allow_unary_plus_numbers: false,
        },
    );
    let mut depth = 0usize;
    while let Some(token) = scanner.scan().map_err(|_| invalid("invalid-structure"))? {
        check(cancel, deadline)?;
        match token {
            Token::OpenBrace | Token::OpenBracket => {
                depth += 1;
                if depth > 16 {
                    return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
                }
            }
            Token::CloseBrace | Token::CloseBracket => {
                depth = depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid("invalid-structure"))?;
            }
            _ => {}
        }
    }
    let parsed = jsonc_parser::parse_to_ast(
        text,
        &CollectOptions::default(),
        &ParseOptions {
            allow_comments: true,
            allow_trailing_commas: true,
            allow_loose_object_property_names: false,
            allow_missing_commas: false,
            allow_single_quoted_strings: false,
            allow_hexadecimal_numbers: false,
            allow_unary_plus_numbers: false,
        },
    )
    .map_err(|_| invalid("invalid-structure"))?;
    let value = parsed.value.ok_or_else(|| invalid("invalid-structure"))?;
    duplicates(&value)?;
    Ok((value, offset as u32))
}
fn duplicates(value: &Value<'_>) -> Result<(), ExecutionError> {
    match value {
        Value::Object(o) => {
            let mut keys = BTreeSet::new();
            for p in &o.properties {
                if !keys.insert(p.name.as_str().to_ascii_lowercase()) {
                    return Err(invalid("duplicate-native-key"));
                }
                duplicates(&p.value)?;
            }
        }
        Value::Array(a) => {
            for v in &a.elements {
                duplicates(v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn prop<'a, 'b>(o: &'b Object<'a>, key: &str) -> Option<&'b Value<'a>> {
    o.properties
        .iter()
        .find(|p| p.name.as_str() == key)
        .map(|p| &p.value)
}
fn string<'a>(o: &'a Object<'a>, key: &str) -> Result<&'a str, ExecutionError> {
    prop(o, key)
        .and_then(|v| v.as_string_lit())
        .map(|s| s.value.as_ref())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("invalid-structure"))
}
pub(super) fn ascii(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| (32..=126).contains(&b))
}

pub fn extract(
    bundle: &SourceBundle,
    cancel: &Cancellation,
) -> Result<SourceOutput, ExecutionError> {
    bundle.validate()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    check(cancel, deadline)?;
    let (manifest, _) = parse(&bundle.files[0].utf8, cancel, deadline)?;
    let manifest = manifest
        .as_object()
        .ok_or_else(|| invalid("invalid-structure"))?;
    let namespace = string(manifest, "UniqueID")?;
    if !ascii(namespace, 256) {
        return Err(invalid("unsupported-format"));
    }
    string(manifest, "Name")?;
    let version = string(manifest, "Version")?;
    let entry = prop(manifest, "EntryDll")
        .and_then(|v| v.as_string_lit())
        .is_some_and(|s| !s.value.is_empty());
    let content_pack = prop(manifest, "ContentPackFor")
        .and_then(|v| v.as_object())
        .and_then(|o| string(o, "UniqueID").ok())
        .is_some();
    if entry == content_pack {
        return Err(invalid("invalid-structure"));
    }
    let source = &bundle.files[1];
    let (root, offset) = parse(&source.utf8, cancel, deadline)?;
    let root = root
        .as_object()
        .ok_or_else(|| invalid("invalid-structure"))?;
    let mut occurrences = Vec::new();
    for p in &root.properties {
        check(cancel, deadline)?;
        let key = p.name.as_str();
        if !ascii(key, 1024) {
            return Err(invalid("unsupported-format"));
        }
        let text = p
            .value
            .as_string_lit()
            .ok_or_else(|| invalid("source-value-not-string"))?;
        if text.value.len() > MAX_TEXT_BYTES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        if key == "$schema" {
            continue;
        }
        if occurrences.len() >= MAX_OCCURRENCES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        let key_range = match &p.name {
            jsonc_parser::ast::ObjectPropName::String(s) => s.range,
            _ => return Err(invalid("invalid-structure")),
        };
        occurrences.push(SourceOccurrence {
            ordinal: occurrences.len() as u32,
            artifact_id: source.artifact_id,
            namespace: namespace.into(),
            key: key.into(),
            text: text.value.to_string(),
            key_byte_range: [
                offset + key_range.start as u32,
                offset + key_range.end as u32,
            ],
            value_byte_range: [
                offset + text.range.start as u32,
                offset + text.range.end as u32,
            ],
            identity_basis: IDENTITY_POLICY.into(),
        });
    }
    if occurrences.is_empty() {
        return Err(invalid("empty-source"));
    }
    let output = SourceOutput {
        version: 1,
        set_id: bundle.set_id,
        manifest_digest: bundle.manifest_digest.clone(),
        format_id: FORMAT.into(),
        format_version: 1,
        identity_policy: IDENTITY_POLICY.into(),
        namespace: namespace.into(),
        source_language: bundle.source_language.clone(),
        coverage: bundle
            .files
            .iter()
            .map(|f| FileCoverage {
                artifact_id: f.artifact_id,
                logical_path: f.logical_path.clone(),
                role: f.role.clone(),
                sha256: f.sha256.clone(),
            })
            .collect(),
        occurrences,
        diagnostics: if version.contains('%') {
            vec!["source-template".into()]
        } else {
            vec![]
        },
    };
    codec::encode(&output, MAX_SOURCE_RESULT_BYTES)?;
    Ok(output)
}

pub struct SourceRunner;
pub struct WebvttSourceRunner;
impl Runner for WebvttSourceRunner {
    fn capability_id(&self) -> &str {
        webvtt::EXTRACT
    }
    fn capability_version(&self) -> &str {
        CAPABILITY_VERSION
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        run_source(request, cancellation, sender)
    }
}
impl Runner for SourceRunner {
    fn capability_id(&self) -> &str {
        CAPABILITY
    }
    fn capability_version(&self) -> &str {
        CAPABILITY_VERSION
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        sender: ResultSender,
    ) -> Result<(), ExecutionError> {
        run_source(request, cancellation, sender)
    }
}
fn run_source(
    request: DispatchRequest,
    cancellation: Cancellation,
    sender: ResultSender,
) -> Result<(), ExecutionError> {
    let input = &request.input;
    let outcome = SourceBundle::from_input(input)
        .and_then(|b| super::extract(&b, &cancellation))
        .and_then(|o| value(&o));
    let mut envelope = ResultEnvelope {
        project_id: input.envelope().project_id,
        attempt_id: input.envelope().attempt_id,
        item_id: request.item_id,
        result_id: ExecutionId::new(),
        supersedes: None,
        dispatch_token: request.dispatch_token,
        capability_id: input.envelope().capability_id.clone(),
        capability_version: CAPABILITY_VERSION.into(),
        outcome: ExecutionState::Succeeded,
        output: None,
        diagnostic: None,
    };
    match outcome {
        Ok(output) => envelope.output = Some(output),
        Err(error) => {
            envelope.outcome =
                if matches!(error.code, ErrorCode::Cancelled | ErrorCode::OutcomeUnknown) {
                    ExecutionState::Unknown
                } else {
                    ExecutionState::Failed
                };
            envelope.diagnostic = Some(Diagnostic {
                code: error.stage,
                retry_safe: false,
            });
        }
    }
    let result = match FixedResult::capture(envelope.clone(), input, request.dispatch_token) {
        Ok(r) => r,
        Err(error) if error.code == ErrorCode::LimitExceeded => {
            envelope.outcome = ExecutionState::Failed;
            envelope.output = None;
            envelope.diagnostic = Some(Diagnostic {
                code: "limit-exceeded".into(),
                retry_safe: false,
            });
            FixedResult::capture(envelope, input, request.dispatch_token)?
        }
        Err(error) => return Err(error),
    };
    sender.send(result)
}
