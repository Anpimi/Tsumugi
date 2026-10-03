//! Bounded current views. Reads share one SQLite snapshot and fetch current
//! evidence in batches; revision history is available through its separate API.

use super::*;
use serde::de::DeserializeOwned;

pub(super) fn read_snapshot<T>(
    connection: &Connection,
    read: impl FnOnce(&Connection) -> Result<T, ExecutionError>,
) -> Result<T, ExecutionError> {
    // Application mutations already own a transaction. Do not nest one or end it.
    if !connection.is_autocommit() {
        return read(connection);
    }
    let transaction = connection.unchecked_transaction().map_err(sql)?;
    let value = read(&transaction)?;
    transaction.commit().map_err(sql)?;
    Ok(value)
}

fn json_rows<T: DeserializeOwned>(
    connection: &Connection,
    query: &str,
    arguments: &[&dyn rusqlite::ToSql],
) -> Result<Vec<T>, ExecutionError> {
    let mut statement = connection.prepare(query).map_err(sql)?;
    let rows = statement
        .query_map(arguments, |row| row.get::<_, String>(0))
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    rows.into_iter()
        .map(|json| {
            serde_json::from_str(&json)
                .map_err(|_| failure(ErrorCode::CorruptLedger, "review-evidence"))
        })
        .collect()
}

const WANTED: &str = "WITH wanted AS MATERIALIZED (
    SELECT json_extract(value,'$[0]') AS unit_id,
           json_extract(value,'$[1]') AS basis FROM json_each(?3))";

/// A constant number of statements for any bounded number of current units.
pub(super) fn targets_in(
    connection: &Connection,
    project_id: ExecutionId,
    units: &[ExecutionId],
    locale: &str,
) -> Result<Vec<ReviewTarget>, ExecutionError> {
    check_project(connection, project_id, locale)?;
    if units.len() > MAX_SCOPE || units.iter().collect::<BTreeSet<_>>().len() != units.len() {
        return Err(failure(ErrorCode::InvalidInput, "review-units"));
    }
    if units.is_empty() {
        return Ok(Vec::new());
    }
    let project = project_id.to_string();
    let unit_json = serde_json::to_string(units)
        .map_err(|_| failure(ErrorCode::InvalidInput, "review-units"))?;
    let terms = resources::current_terms_in(connection, project_id, locale)?;
    let mut statement = connection
        .prepare(
            "WITH wanted AS MATERIALIZED (SELECT value AS unit_id FROM json_each(?2))
         SELECT o.unit_id,o.snapshot_id,o.revision_id,o.native_key,r.text,
                s.event_id,s.revision_id,tr.text,cc.revision_id
         FROM wanted
         JOIN source_occurrences o ON o.unit_id=wanted.unit_id
         JOIN source_units u ON u.unit_id=o.unit_id AND u.project_id=?1
         JOIN source_revisions r ON r.revision_id=o.revision_id
         JOIN content_scope c ON c.current_snapshot=o.snapshot_id
         LEFT JOIN translation_selections s ON s.unit_id=o.unit_id AND s.locale=?3
           AND s.sequence=(SELECT MAX(t.sequence) FROM translation_selections t
                           WHERE t.unit_id=o.unit_id AND t.locale=?3)
         LEFT JOIN translation_revisions tr ON tr.revision_id=s.revision_id
         LEFT JOIN context_current cc ON cc.unit_id=o.unit_id AND cc.locale=?3",
        )
        .map_err(sql)?;
    let raw = statement
        .query_map(params![project, unit_json, locale], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(sql)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql)?;
    let mut targets = BTreeMap::new();
    for (unit, snapshot, source_revision, key, source, selection, revision, text, context) in raw {
        let unit_id = parse_id(unit)?;
        let source_revision_id = parse_id(source_revision)?;
        let source_snapshot_id = parse_id(snapshot)?;
        let selection_id = selection.map(parse_id).transpose()?;
        let revision_id = revision.map(parse_id).transpose()?;
        if selection_id.is_some() != revision_id.is_some()
            || revision_id.is_some() != text.is_some()
        {
            return Err(failure(ErrorCode::CorruptLedger, "review-selection"));
        }
        let resolved =
            resources::resolve_terms_from(unit_id, locale, source_revision_id, &source, &terms);
        let term_conflict = resolved
            .entries
            .iter()
            .any(|entry| !entry.conflicting.is_empty());
        let mut term_revision_ids: Vec<_> = resolved
            .entries
            .iter()
            .flat_map(|entry| {
                entry
                    .selected
                    .iter()
                    .chain(entry.conflicting.iter())
                    .map(|term| term.revision_id)
            })
            .collect();
        term_revision_ids.sort();
        term_revision_ids.dedup();
        let basis_evidence = ReviewBasis {
            source_snapshot_id,
            source_revision_id,
            selection_id,
            revision_id,
            context_revision_id: context.map(parse_id).transpose()?,
            term_revision_ids,
        };
        targets.insert(
            unit_id,
            ReviewTarget {
                unit_id,
                locale: locale.to_owned(),
                native_key: key,
                source_snapshot_id,
                source_revision_id,
                source_text: source,
                selection_id,
                revision_id,
                translation_text: text,
                basis: basis_digest(&basis_evidence)?,
                basis_evidence,
                term_conflict,
                current_decision: None,
                current_check: None,
                current_fallback: None,
                current_waivers: Vec::new(),
            },
        );
    }
    if targets.len() != units.len() {
        return Err(failure(ErrorCode::DependencyConflict, "review-unit"));
    }
    let bases = serde_json::to_string(
        &units
            .iter()
            .map(|unit| (*unit, &targets[unit].basis))
            .collect::<Vec<_>>(),
    )
    .map_err(|_| failure(ErrorCode::InvalidInput, "review-units"))?;
    let arguments: &[&dyn rusqlite::ToSql] = &[&project, &locale, &bases];

    let decisions: Vec<ReviewDecision> = json_rows(connection, &format!(
        "{WANTED}, latest AS (
         SELECT r.*,ROW_NUMBER() OVER(PARTITION BY r.unit_id ORDER BY r.rowid DESC) position
         FROM review_decisions r JOIN wanted w ON w.unit_id=r.unit_id AND w.basis=r.basis
         WHERE r.project_id=?1 AND r.locale=?2)
         SELECT json_object('decisionId',decision_id,'actionId',action_id,'unitId',unit_id,
            'locale',locale,'basis',basis,'basisEvidence',json(basis_json),'selectionId',selection_id,
            'revisionId',revision_id,'sourceRevisionId',source_revision_id,'actor',actor,
            'kind',kind,'reason',reason,'createdAt',created_at) FROM latest WHERE position=1"
    ), arguments)?;
    for decision in decisions {
        if basis_digest(&decision.basis_evidence)? != decision.basis {
            return Err(failure(ErrorCode::CorruptLedger, "review-basis"));
        }
        let target = targets
            .get_mut(&decision.unit_id)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-unit"))?;
        target.current_decision = Some(decision);
    }
    let checks: Vec<CheckRun> = json_rows(
        connection,
        &format!(
            "{WANTED}, latest AS (
         SELECT r.*,ROW_NUMBER() OVER(PARTITION BY r.unit_id ORDER BY r.rowid DESC) position
         FROM review_checks r JOIN wanted w ON w.unit_id=r.unit_id AND w.basis=r.basis
         WHERE r.project_id=?1 AND r.locale=?2 AND r.validator_version=?4)
         SELECT json_object('runId',run_id,'actionId',action_id,'unitId',unit_id,
            'locale',locale,'basis',basis,'basisEvidence',json(basis_json),
            'validatorVersion',validator_version,'outcome','completed','rules',json(rules_json),
            'createdAt',created_at) FROM latest WHERE position=1"
        ),
        &[&project, &locale, &bases, &CHECK_VERSION],
    )?;
    for mut check in checks {
        if basis_digest(&check.basis_evidence)? != check.basis {
            return Err(failure(ErrorCode::CorruptLedger, "review-basis"));
        }
        check.outcome = check_outcome(&check.rules).to_owned();
        let target = targets
            .get_mut(&check.unit_id)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-unit"))?;
        target.current_check = Some(check);
    }
    let fallbacks: Vec<FallbackDecision> = json_rows(connection,
        "WITH wanted AS MATERIALIZED (SELECT value unit_id FROM json_each(?3)),
         latest AS (SELECT r.*,ROW_NUMBER() OVER(PARTITION BY r.unit_id ORDER BY r.rowid DESC) position
         FROM review_fallbacks r JOIN wanted w ON w.unit_id=r.unit_id
         JOIN source_occurrences o ON o.unit_id=r.unit_id AND o.revision_id=r.source_revision_id
         JOIN content_scope c ON c.current_snapshot=o.snapshot_id
         WHERE r.project_id=?1 AND r.locale=?2 AND r.policy_version=?4)
         SELECT json_object('fallbackId',fallback_id,'actionId',action_id,'unitId',unit_id,
            'locale',locale,'sourceRevisionId',source_revision_id,'allow',json('true'),
            'previousFallbackId',previous_fallback_id,'policyVersion',policy_version,
            'actor',actor,'reason',reason,'createdAt',created_at)
         FROM latest WHERE position=1 AND kind='allow'",
        &[&project, &locale, &unit_json, &POLICY_VERSION])?;
    for fallback in fallbacks {
        let target = targets
            .get_mut(&fallback.unit_id)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-unit"))?;
        if target.selection_id.is_none() {
            target.current_fallback = Some(fallback);
        }
    }
    let waivers: Vec<Waiver> = json_rows(connection, &format!(
        "{WANTED}, latest AS (
         SELECT r.*,ROW_NUMBER() OVER(PARTITION BY r.unit_id,r.issue_id ORDER BY r.rowid DESC) position
         FROM review_waivers r JOIN wanted w ON w.unit_id=r.unit_id AND w.basis=r.basis
         WHERE r.project_id=?1 AND r.locale=?2 AND r.policy_version=?4)
         SELECT json_object('waiverId',waiver_id,'actionId',action_id,'unitId',unit_id,
            'locale',locale,'basis',basis,'issueId',issue_id,'grant',json('true'),
            'previousWaiverId',previous_waiver_id,'policyVersion',policy_version,
            'actor',actor,'reason',reason,'createdAt',created_at)
         FROM latest WHERE position=1 AND kind='grant' ORDER BY issue_id"
    ), &[&project, &locale, &bases, &POLICY_VERSION])?;
    for waiver in waivers {
        let target = targets
            .get_mut(&waiver.unit_id)
            .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-unit"))?;
        if target.current_check.as_ref().is_some_and(|check| {
            check
                .rules
                .iter()
                .flat_map(|rule| &rule.findings)
                .any(|finding| finding.waivable && finding.issue_id == waiver.issue_id)
        }) {
            target.current_waivers.push(waiver);
        }
    }
    units
        .iter()
        .map(|unit| {
            targets
                .remove(unit)
                .ok_or_else(|| failure(ErrorCode::CorruptLedger, "review-unit"))
        })
        .collect()
}
