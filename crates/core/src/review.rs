//! Deterministic review rules. No database, desktop runtime, or external calls.
use crate::execution::{ExecutionError, ExecutionId, MAX_INPUT_BYTES, codec};
use crate::{CheckFinding, CheckRuleResult, TermResolution};
use serde::Serialize;
use std::collections::BTreeMap;

pub(crate) const CHECK_VERSION: &str = "smapi-prebuild-2";
pub(crate) const REQUIRED_RULES: [&str; 4] = [
    "required-translation",
    "placeholders",
    "format",
    "terminology",
];

pub(crate) fn complete_rules(rules: &[CheckRuleResult]) -> bool {
    rules.len() == REQUIRED_RULES.len()
        && rules
            .iter()
            .zip(REQUIRED_RULES)
            .all(|(rule, required)| rule.rule == required)
}

#[derive(Clone, Debug)]
pub(crate) struct CheckInput {
    pub unit_id: ExecutionId,
    pub locale: String,
    pub source_text: String,
    pub translation_text: Option<String>,
}

fn digest<T: Serialize>(value: &T) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(value, MAX_INPUT_BYTES)?))
}

fn finding(
    target: &CheckInput,
    rule: &str,
    code: &str,
    detail: &str,
    severity: &str,
    waivable: bool,
) -> Result<CheckFinding, ExecutionError> {
    finding_for(
        &CHECK_VERSION,
        target,
        rule,
        code,
        detail,
        severity,
        waivable,
    )
}

fn finding_for<V: Serialize>(
    validator: &V,
    target: &CheckInput,
    rule: &str,
    code: &str,
    detail: &str,
    severity: &str,
    waivable: bool,
) -> Result<CheckFinding, ExecutionError> {
    Ok(CheckFinding {
        issue_id: digest(&(
            validator,
            target.unit_id,
            &target.locale,
            rule,
            code,
            detail,
        ))?,
        rule: rule.to_owned(),
        code: code.to_owned(),
        detail: detail.to_owned(),
        severity: severity.to_owned(),
        waivable,
    })
}
fn result(rule: &str, findings: Vec<CheckFinding>, reason: Option<&str>) -> CheckRuleResult {
    CheckRuleResult {
        rule: rule.to_owned(),
        status: if reason.is_some() {
            "not-applicable"
        } else if findings.is_empty() {
            "passed"
        } else {
            "findings"
        }
        .to_owned(),
        reason: reason.map(str::to_owned),
        findings,
    }
}

pub(crate) fn interrupted_rules(status: &str, reason: &str) -> Vec<CheckRuleResult> {
    REQUIRED_RULES
        .into_iter()
        .map(|rule| CheckRuleResult {
            rule: rule.to_owned(),
            status: status.to_owned(),
            reason: Some(reason.to_owned()),
            findings: Vec::new(),
        })
        .collect()
}

/// The first bundled format uses named `{{token}}` markers. A malformed marker
/// is a format finding; a valid marker inventory is compared including counts.
fn markers(value: &str) -> Result<BTreeMap<String, u32>, ()> {
    let mut found = BTreeMap::new();
    let mut rest = value;
    while !rest.is_empty() {
        let open = rest.find("{{");
        let close = rest.find("}}");
        if close.is_some_and(|position| open.is_none_or(|start| position < start)) {
            return Err(());
        }
        let Some(start) = open else {
            break;
        };
        rest = &rest[start + 2..];
        let Some(end) = rest.find("}}") else {
            return Err(());
        };
        if rest[..end].contains("{{") {
            return Err(());
        }
        let name = &rest[..end];
        if name.is_empty()
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        {
            return Err(());
        }
        *found.entry(name.to_owned()).or_default() += 1;
        rest = &rest[end + 2..];
    }
    Ok(found)
}

/// Core policy is shared by the captured union and the existing review path.
/// Domain marker and format interpretation belongs to the adopted checker.
pub(crate) fn check_core_rules<V: Serialize>(
    target: &CheckInput,
    terms: &TermResolution,
    validator: &V,
) -> Result<(CheckRuleResult, CheckRuleResult), ExecutionError> {
    let Some(text) = target.translation_text.as_deref() else {
        return Ok((
            result(
                "required-translation",
                vec![finding_for(
                    validator,
                    target,
                    "required-translation",
                    "missing",
                    "No selected translation",
                    "error",
                    false,
                )?],
                None,
            ),
            result("terminology", Vec::new(), Some("No selected translation")),
        ));
    };
    let mut required = Vec::new();
    if text.is_empty() {
        required.push(finding_for(
            validator,
            target,
            "required-translation",
            "empty",
            "Selected translation is empty",
            "error",
            false,
        )?);
    }
    let mut terminology = Vec::new();
    for entry in &terms.entries {
        if !entry.conflicting.is_empty() {
            terminology.push(finding_for(
                validator,
                target,
                "terminology",
                "conflict",
                &entry.source,
                "error",
                false,
            )?);
        } else if let Some(term) = &entry.selected {
            if term.protected
                && (target.source_text.contains(&entry.source)
                    || term
                        .aliases
                        .iter()
                        .any(|alias| target.source_text.contains(alias)))
                && !text.contains(&term.target)
            {
                terminology.push(finding_for(
                    validator,
                    target,
                    "terminology",
                    "protected-form",
                    &entry.source,
                    "warning",
                    true,
                )?);
            }
        }
    }
    Ok((
        result("required-translation", required, None),
        result("terminology", terminology, None),
    ))
}

pub(crate) fn check_rules(
    target: &CheckInput,
    terms: &TermResolution,
) -> Result<Vec<CheckRuleResult>, ExecutionError> {
    let (required, terminology) = check_core_rules(target, terms, &CHECK_VERSION)?;
    let source_markers = markers(&target.source_text);
    let mut format = Vec::new();
    if source_markers.is_err() {
        format.push(finding(
            target,
            "format",
            "source-marker",
            "Source marker syntax is unsupported",
            "error",
            false,
        )?);
    }
    if target
        .source_text
        .chars()
        .any(|ch| ch == '\0' || (ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t'))
    {
        format.push(finding(
            target,
            "format",
            "source-control-character",
            "Source contains a control character",
            "error",
            false,
        )?);
    }
    let Some(text) = target.translation_text.as_deref() else {
        return Ok(vec![
            required,
            result("placeholders", Vec::new(), Some("No selected translation")),
            result("format", format, None),
            terminology,
        ]);
    };
    let target_markers = markers(text);
    if target_markers.is_err() {
        format.push(finding(
            target,
            "format",
            "translation-marker",
            "Translation marker syntax is malformed",
            "error",
            false,
        )?);
    }
    if text
        .chars()
        .any(|ch| ch == '\0' || (ch.is_control() && ch != '\n' && ch != '\r' && ch != '\t'))
    {
        format.push(finding(
            target,
            "format",
            "control-character",
            "Translation contains a control character",
            "error",
            false,
        )?);
    }
    let mut placeholders = Vec::new();
    if let (Ok(source), Ok(translation)) = (&source_markers, &target_markers) {
        if source != translation {
            placeholders.push(finding(
                target,
                "placeholders",
                "marker-mismatch",
                "Named marker names or counts differ from source",
                "error",
                false,
            )?);
        }
    }
    let placeholder_result = if source_markers.is_err() || target_markers.is_err() {
        CheckRuleResult {
            rule: "placeholders".into(),
            status: "unavailable".into(),
            reason: Some("Marker syntax is unsupported or malformed".into()),
            findings: placeholders,
        }
    } else {
        result("placeholders", placeholders, None)
    };
    Ok(vec![
        required,
        placeholder_result,
        result("format", format, None),
        terminology,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(text: Option<&str>) -> CheckInput {
        CheckInput {
            unit_id: ExecutionId::new(),
            locale: "zh-CN".into(),
            source_text: "Hello {{name}}".into(),
            translation_text: text.map(str::to_owned),
        }
    }
    #[test]
    fn deterministic_rules_cover_missing_empty_markers_and_control_characters() {
        for (text, expected) in [
            (None, "missing"),
            (Some(""), "empty"),
            (Some("你好"), "marker-mismatch"),
            (Some("你好 {{other}}"), "marker-mismatch"),
            (Some("你好 {{name"), "translation-marker"),
            (Some("你好 {{name}}\u{0007}"), "control-character"),
        ] {
            let input = input(text);
            let terms = TermResolution {
                unit_id: input.unit_id,
                locale: input.locale.clone(),
                source_revision_id: ExecutionId::new(),
                entries: vec![],
            };
            let rules = check_rules(&input, &terms).unwrap();
            assert_eq!(rules, check_rules(&input, &terms).unwrap());
            assert_eq!(rules.len(), 4);
            assert!(
                rules
                    .iter()
                    .flat_map(|r| &r.findings)
                    .any(|f| f.code == expected)
            );
        }
        let input = input(Some("你好 {{name}}"));
        let terms = TermResolution {
            unit_id: input.unit_id,
            locale: input.locale.clone(),
            source_revision_id: ExecutionId::new(),
            entries: vec![],
        };
        assert!(
            check_rules(&input, &terms)
                .unwrap()
                .iter()
                .all(|r| r.status == "passed")
        );
    }
    #[test]
    fn issue_identity_keeps_distinct_causes_with_the_same_display_text() {
        let target = input(Some("你好 {{name}}"));
        let a = finding(
            &target,
            "format",
            "unsupported",
            "Same message",
            "error",
            false,
        )
        .unwrap();
        let repeated = finding(
            &target,
            "format",
            "unsupported",
            "Same message",
            "error",
            false,
        )
        .unwrap();
        let other_rule = finding(
            &target,
            "placeholders",
            "unsupported",
            "Same message",
            "error",
            false,
        )
        .unwrap();
        let other_code =
            finding(&target, "format", "invalid", "Same message", "error", false).unwrap();
        assert_eq!(a.issue_id, repeated.issue_id);
        assert_ne!(a.issue_id, other_rule.issue_id);
        assert_ne!(a.issue_id, other_code.issue_id);
        assert_ne!(
            a.issue_id,
            finding(
                &CheckInput {
                    locale: "fr-FR".into(),
                    ..target.clone()
                },
                "format",
                "unsupported",
                "Same message",
                "error",
                false,
            )
            .unwrap()
            .issue_id
        );
    }
}
