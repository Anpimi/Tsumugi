//! A bounded caption profile with byte-preserving reconstruction.
use super::*;
use std::collections::BTreeSet;

pub const PLUGIN: &str = "webvtt";
pub const PROFILE: &str = "webvtt-captions";
pub const POLICY: &str = "webvtt-cue/1";
pub const EXTRACT: &str = "webvtt.extract";
pub const BUILD: &str = "webvtt.locale-build";
pub const BUILDER: &str = "webvtt-locale-build-1";
pub const CHECKER: &str = "webvtt-locale-artifact-1";
pub const PATH: &str = "source.vtt";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CueBasis {
    pub policy: String,
    pub timing: String,
    pub native_id: String,
    pub layout_digest: String,
}

struct Line<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}
fn lines(text: &str) -> Vec<Line<'_>> {
    let bytes = text.as_bytes();
    let mut result = Vec::new();
    let mut start = 0;
    let mut end = 0;
    while end < bytes.len() {
        if matches!(bytes[end], b'\r' | b'\n') {
            result.push(Line {
                text: &text[start..end],
                start,
                end,
            });
            if bytes[end] == b'\r' && bytes.get(end + 1) == Some(&b'\n') {
                end += 1;
            }
            end += 1;
            start = end;
        } else {
            end += 1;
        }
    }
    if start < bytes.len() {
        result.push(Line {
            text: &text[start..],
            start,
            end: text.len(),
        });
    }
    result
}
fn timestamp(text: &str) -> Result<u64, ExecutionError> {
    let parts: Vec<_> = text.split(':').collect();
    if !matches!(parts.len(), 2 | 3) {
        return Err(invalid("vtt-timing"));
    }
    let number = |part: &str, length: usize| -> Result<u64, ExecutionError> {
        if part.len() != length || !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid("vtt-timing"));
        }
        part.parse().map_err(|_| invalid("vtt-timing"))
    };
    let (hours, minutes, seconds) = if parts.len() == 3 {
        if parts[0].len() < 2 || parts[0].len() > 8 {
            return Err(invalid("vtt-timing"));
        }
        (
            number(parts[0], parts[0].len())?,
            number(parts[1], 2)?,
            parts[2],
        )
    } else {
        (0, number(parts[0], 2)?, parts[1])
    };
    let (sec, millis) = seconds
        .split_once('.')
        .ok_or_else(|| invalid("vtt-timing"))?;
    let sec = number(sec, 2)?;
    let millis = number(millis, 3)?;
    if sec > 59 || minutes > 59 {
        return Err(invalid("vtt-timing"));
    }
    Ok(((hours * 60 + minutes) * 60 + sec) * 1000 + millis)
}
fn percent(text: &str) -> bool {
    text.strip_suffix('%').is_some_and(|n| {
        !n.is_empty()
            && n.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            && n.parse::<f64>()
                .is_ok_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
    })
}
fn setting(text: &str, regions: &BTreeSet<String>) -> bool {
    let Some((key, value)) = text.split_once(':') else {
        return false;
    };
    let mut parts = value.split(',');
    let value = parts.next().unwrap_or("");
    let suffix = parts.next();
    if parts.next().is_some() {
        return false;
    }
    match key {
        "align" => {
            suffix.is_none() && matches!(value, "start" | "center" | "end" | "left" | "right")
        }
        "size" => suffix.is_none() && percent(value),
        "region" => suffix.is_none() && regions.contains(value),
        "position" => {
            percent(value)
                && suffix
                    .is_none_or(|v| matches!(v, "line-left" | "center" | "line-right" | "auto"))
        }
        "line" => {
            (value == "auto"
                || percent(value)
                || (!value.is_empty()
                    && value.parse::<i32>().is_ok()
                    && value
                        .trim_start_matches('-')
                        .bytes()
                        .all(|b| b.is_ascii_digit())))
                && suffix.is_none_or(|v| matches!(v, "start" | "center" | "end"))
        }
        _ => false,
    }
}
fn timing(text: &str, regions: &BTreeSet<String>) -> Result<u64, ExecutionError> {
    let tokens: Vec<_> = text.split_ascii_whitespace().collect();
    if tokens.len() < 3 || tokens[1] != "-->" {
        return Err(invalid("vtt-timing"));
    }
    let start = timestamp(tokens[0])?;
    if timestamp(tokens[2])? <= start {
        return Err(invalid("vtt-timing"));
    }
    let mut seen = BTreeSet::new();
    for token in &tokens[3..] {
        if !setting(token, regions) || !seen.insert(token.split(':').next()) {
            return Err(invalid("vtt-setting"));
        }
    }
    Ok(start)
}
pub fn valid_payload(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= MAX_TEXT_BYTES
        && !text.contains(['\0', '<', '&'])
        && !text.contains("-->")
        && lines(text).iter().all(|line| !line.text.is_empty())
        && !text.ends_with(['\r', '\n'])
}
fn region(block: &[Line<'_>], regions: &mut BTreeSet<String>) -> Result<(), ExecutionError> {
    let mut id = None;
    let mut keys = BTreeSet::new();
    for line in &block[1..] {
        let Some((key, value)) = line.text.split_once(':') else {
            return Err(invalid("vtt-region"));
        };
        if !keys.insert(key) {
            return Err(invalid("vtt-region"));
        }
        let valid = match key {
            "id" => {
                id = Some(value.to_owned());
                !value.is_empty() && !value.contains(char::is_whitespace)
            }
            "width" => percent(value),
            "lines" => {
                !value.is_empty()
                    && value.bytes().all(|b| b.is_ascii_digit())
                    && value.parse::<u32>().is_ok_and(|n| n > 0)
            }
            "regionanchor" | "viewportanchor" => value
                .split_once(',')
                .is_some_and(|(a, b)| percent(a) && percent(b)),
            "scroll" => value == "up",
            _ => false,
        };
        if !valid {
            return Err(invalid("vtt-region"));
        }
    }
    if !regions.insert(id.ok_or_else(|| invalid("vtt-region"))?) {
        return Err(invalid("vtt-region"));
    }
    Ok(())
}

pub fn extract(
    bundle: &SourceBundle,
    cancel: &Cancellation,
) -> Result<SourceOutput, ExecutionError> {
    bundle.validate()?;
    let source = &bundle.files[0];
    let raw = &source.utf8;
    let all = lines(raw);
    let Some(first) = all.first() else {
        return Err(invalid("vtt-header"));
    };
    let header = first.text.strip_prefix('\u{feff}').unwrap_or(first.text);
    if !(header == "WEBVTT" || header.starts_with("WEBVTT ") || header.starts_with("WEBVTT\t"))
        || header.contains("-->")
        || all.get(1).is_none_or(|l| !l.text.is_empty())
        || raw.contains('\0')
    {
        return Err(invalid("vtt-header"));
    }
    let mut index = 2;
    let mut blocks = Vec::new();
    while index < all.len() {
        if cancel.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "cancelled"));
        }
        if all[index].text.is_empty() {
            index += 1;
            continue;
        }
        let start = index;
        while index < all.len() && !all[index].text.is_empty() {
            index += 1;
        }
        blocks.push(&all[start..index]);
    }
    let mut layout = String::new();
    let mut regions = BTreeSet::new();
    let mut cues_started = false;
    for block in &blocks {
        match block[0].text {
            "STYLE" | "REGION" => {
                if cues_started || block.len() < 2 || block.iter().any(|l| l.text.contains("-->")) {
                    return Err(invalid("vtt-block"));
                }
                if block[0].text == "REGION" {
                    region(block, &mut regions)?;
                }
                for line in *block {
                    layout.push_str(line.text);
                    layout.push('\n');
                }
                layout.push('\n');
            }
            text if text == "NOTE" || text.starts_with("NOTE ") || text.starts_with("NOTE\t") => {
                if block.iter().any(|l| l.text.contains("-->")) {
                    return Err(invalid("vtt-block"));
                }
            }
            _ => cues_started = true,
        }
    }
    let mut occurrences = Vec::new();
    let mut ids = BTreeSet::new();
    let mut previous = 0;
    for block in blocks {
        if cancel.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "cancelled"));
        }
        let id = block[0].text;
        if matches!(id, "STYLE" | "REGION" | "NOTE")
            || id.starts_with("NOTE ")
            || id.starts_with("NOTE\t")
        {
            continue;
        }
        if block.len() < 3
            || !smapi::ascii(id, 1024)
            || id.contains("-->")
            || !ids.insert(id.to_ascii_lowercase())
        {
            return Err(invalid("vtt-cue-id"));
        }
        let start = timing(block[1].text, &regions)?;
        if start < previous {
            return Err(invalid("vtt-order"));
        }
        previous = start;
        let range = [block[2].start, block.last().unwrap().end];
        let text = &raw[range[0]..range[1]];
        if !valid_payload(text) {
            return Err(invalid("vtt-payload"));
        }
        if occurrences.len() >= MAX_OCCURRENCES {
            return Err(failure(ErrorCode::LimitExceeded, "limit-exceeded"));
        }
        occurrences.push(SourceOccurrence {
            ordinal: occurrences.len() as u32,
            artifact_id: source.artifact_id,
            namespace: "webvtt:source".into(),
            key: id.into(),
            text: text.replace("\r\n", "\n").replace('\r', "\n"),
            key_byte_range: [block[0].start as u32, block[0].end as u32],
            value_byte_range: range.map(|n| n as u32),
            identity_basis: serde_json::to_string(&CueBasis {
                policy: POLICY.into(),
                timing: block[1].text.into(),
                native_id: id.into(),
                layout_digest: codec::digest(layout.as_bytes()),
            })
            .map_err(|_| invalid("vtt-basis"))?,
        });
    }
    if occurrences.is_empty() {
        return Err(invalid("empty-source"));
    }
    let output = SourceOutput {
        version: 1,
        set_id: bundle.set_id,
        manifest_digest: bundle.manifest_digest.clone(),
        format_id: PROFILE.into(),
        format_version: 1,
        identity_policy: POLICY.into(),
        namespace: "webvtt:source".into(),
        source_language: bundle.source_language.clone(),
        coverage: vec![FileCoverage {
            artifact_id: source.artifact_id,
            logical_path: PATH.into(),
            role: "source".into(),
            sha256: source.sha256.clone(),
        }],
        occurrences,
        diagnostics: vec![],
    };
    codec::encode(&output, MAX_SOURCE_RESULT_BYTES)?;
    Ok(output)
}

pub fn file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".vtt") else {
        return false;
    };
    let lower = stem.to_ascii_lowercase();
    !stem.is_empty()
        && stem.len() <= 80
        && stem
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        && !matches!(lower.as_str(), "source" | "con" | "prn" | "aux" | "nul")
        && !(lower.len() == 4
            && (lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.as_bytes()[3].is_ascii_digit())
}
pub fn build(locale: &BuildLocale, cancel: &Cancellation) -> Result<BuildOutput, ExecutionError> {
    let template = locale
        .source_template
        .as_ref()
        .ok_or_else(|| invalid("vtt-template"))?;
    let bundle = SourceBundle::capture_webvtt(template.as_bytes(), "en-US")?;
    let source = extract(&bundle, cancel)?;
    if source.occurrences.len() != locale.entries.len() || !file_name(&locale.file_name) {
        return Err(invalid("vtt-build"));
    }
    let newline = if template.contains("\r\n") {
        "\r\n"
    } else if template.contains('\r') {
        "\r"
    } else {
        "\n"
    };
    let mut utf8 = String::new();
    let mut offset = 0;
    for (cue, entry) in source.occurrences.iter().zip(&locale.entries) {
        if cancel.is_requested() {
            return Err(failure(ErrorCode::Cancelled, "build-cancelled"));
        }
        if cue.key != entry.native_key
            || cue.text != entry.source_text
            || cue.ordinal != entry.ordinal
            || !valid_payload(&entry.value)
        {
            return Err(invalid("vtt-build-payload"));
        }
        let [start, end] = cue.value_byte_range.map(|n| n as usize);
        utf8.push_str(&template[offset..start]);
        utf8.push_str(
            &entry
                .value
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .replace('\n', newline),
        );
        offset = end;
    }
    utf8.push_str(&template[offset..]);
    if utf8.len() > super::MAX_SOURCE_BYTES {
        return Err(failure(ErrorCode::LimitExceeded, "build-artifact"));
    }
    Ok(BuildOutput {
        version: 1,
        locale: locale.locale.clone(),
        file_name: locale.file_name.clone(),
        sha256: codec::digest(utf8.as_bytes()),
        entry_count: locale.entries.len() as u32,
        utf8,
        builder_version: BUILDER.into(),
    })
}
pub fn check(locale: &BuildLocale, output: &BuildOutput) -> Result<(), ExecutionError> {
    if output.version != 1
        || output.locale != locale.locale
        || output.file_name != locale.file_name
        || output.builder_version != BUILDER
        || output.entry_count as usize != locale.entries.len()
        || codec::digest(output.utf8.as_bytes()) != output.sha256
    {
        return Err(invalid("vtt-build-output"));
    }
    let parsed = extract(
        &SourceBundle::capture_webvtt(output.utf8.as_bytes(), "en-US")?,
        &Cancellation::default(),
    )?;
    if parsed.occurrences.len() != locale.entries.len()
        || parsed
            .occurrences
            .iter()
            .zip(&locale.entries)
            .any(|(cue, entry)| {
                cue.key != entry.native_key
                    || cue.text != entry.value.replace("\r\n", "\n").replace('\r', "\n")
            })
        || output.utf8 != build(locale, &Cancellation::default())?.utf8
    {
        return Err(invalid("vtt-build-preservation"));
    }
    Ok(())
}
