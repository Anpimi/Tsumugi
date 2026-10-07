//! Core choice and terminology policy over owned values; domain syntax is plugin-owned.
use crate::execution::{ExecutionError, ExecutionId, MAX_INPUT_BYTES, codec};
use crate::{CheckFinding, CheckRuleResult, TermResolution};
use serde::Serialize;

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
pub(crate) fn core_check_key(rule: &str) -> tsumugi_plugin_sdk::CheckKey {
    tsumugi_plugin_sdk::CheckKey {
        rule: tsumugi_plugin_sdk::ContractRef {
            id: rule.into(),
            schema_version: 1,
            behavior_version: 1,
        },
        implementation: tsumugi_plugin_sdk::CheckImplementation::Core {
            validator: tsumugi_plugin_sdk::ContractRef {
                id: "tsumugi.core-review".into(),
                schema_version: 1,
                behavior_version: 1,
            },
        },
    }
}
fn result(rule: &str, findings: Vec<CheckFinding>, reason: Option<&str>) -> CheckRuleResult {
    CheckRuleResult {
        rule: rule.to_owned(),
        key: core_check_key(rule),
        mandatory: true,
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

#[cfg(any(test, feature = "execution-test-host"))]
mod fixture;
#[cfg(any(test, feature = "execution-test-host"))]
pub(crate) use fixture::{CHECK_VERSION, check_rules, complete_rules, interrupted_rules};
