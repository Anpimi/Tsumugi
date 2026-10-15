use super::*;
use crate::execution::ErrorCode;

fn document(body: &str) -> String {
    format!(
        "<tbx xmlns=\"{TBX_NS}\" type=\"TBX-Basic\" style=\"dca\" xml:lang=\"en-US\"><tbxHeader><fileDesc><titleStmt><title>  Example  </title></titleStmt><sourceDesc><p>Local source</p></sourceDesc></fileDesc></tbxHeader><text><body>{body}</body></text></tbx>"
    )
}
fn preview(xml: &str) -> Result<TbxExchangePreview, ExecutionError> {
    preview_tbx_exchange(xml.as_bytes(), "en-US", "fr-FR")
}
fn term(language: &str, text: &str) -> String {
    format!("<langSec xml:lang=\"{language}\"><termSec><term>{text}</term></termSec></langSec>")
}
fn pair() -> String {
    format!(
        "<conceptEntry id=\"c\">{}{}</conceptEntry>",
        term("en-US", "source"),
        term("fr-FR", "target")
    )
}
fn has_loss(report: &TbxExchangePreview, kind: TbxLossKind, field: &str) -> bool {
    report
        .losses
        .iter()
        .any(|loss| loss.kind == kind && loss.field == field)
}

#[test]
fn preserves_multiple_candidates_and_direct_source_without_choosing_preferred() {
    let body = concat!(
        "<conceptEntry id=\"c1\"><descrip type=\"definition\">fruit</descrip>",
        "<langSec xml:lang=\"en-US\"><termSec id=\"e1\"><term>Apple</term><termNote type=\"usageStatus\">preferred</termNote><admin type=\"source\">Direct</admin><descripGrp><admin type=\"source\">Nested</admin></descripGrp></termSec></langSec>",
        "<langSec xml:lang=\"fr-FR\"><termSec id=\"f1\"><term>Pomme</term></termSec><termSec id=\"f2\"><term>Fruit</term></termSec></langSec>",
        "<langSec xml:lang=\"de-DE\"><termSec><term><hi/>Extra</term></termSec></langSec></conceptEntry>"
    );
    let report = preview(&document(body)).unwrap();
    assert_eq!(report.profile, PROFILE);
    assert_eq!(report.license, TbxLicenseStatus::Unknown);
    assert_eq!(report.document_locale, "en-US");
    assert_eq!(report.titles, vec!["  Example  "]);
    assert_eq!(report.source_descriptions, vec!["Local source"]);
    let row = &report.rows[0];
    assert_eq!(row.status, TbxRowStatus::Excluded);
    assert!(row.reasons.contains(&TbxRowReason::AmbiguousTarget));
    assert_eq!(row.source_terms.len(), 1);
    assert_eq!(row.target_terms.len(), 2);
    assert_eq!(row.source_terms[0].language_ordinal, 1);
    assert_eq!(row.source_terms[0].ordinal, 1);
    assert_eq!(row.target_terms[0].ordinal, 2);
    assert_eq!(row.target_terms[1].ordinal, 3);
    assert_eq!(row.source_terms[0].term_sec_id.as_deref(), Some("e1"));
    assert_eq!(row.source_terms[0].text.as_deref(), Some("Apple"));
    assert_eq!(row.source_terms[0].usage_statuses, vec!["preferred"]);
    assert_eq!(row.source_terms[0].sources, vec!["Direct"]);
    assert!(has_loss(
        &report,
        TbxLossKind::UnmappedMetadata,
        "descripGrp"
    ));
    assert!(has_loss(
        &report,
        TbxLossKind::UnmappedMetadata,
        "definition"
    ));
    assert!(has_loss(&report, TbxLossKind::UnmappedMetadata, "source"));
    assert!(has_loss(&report, TbxLossKind::ExtraLanguage, "xml:lang"));
    assert!(has_loss(&report, TbxLossKind::InlineMarkup, "hi"));
    assert!(!row.reasons.contains(&TbxRowReason::InvalidSourceTerm));
}

#[test]
fn extra_language_damage_does_not_exclude_selected_pair() {
    let body = format!(
        "<conceptEntry>{}{}<langSec xml:lang=\"de-DE\"><termSec><term><hi/>bad</term></termSec><termSec/></langSec></conceptEntry>",
        term("en-US", "source"),
        term("fr-FR", "target")
    );
    let report = preview(&document(&body)).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::PossibleMapping);
    assert!(report.rows[0].reasons.is_empty());
    assert!(has_loss(&report, TbxLossKind::InlineMarkup, "hi"));
    assert!(has_loss(&report, TbxLossKind::MissingTerm, "term"));
    assert!(has_loss(&report, TbxLossKind::ExtraLanguage, "xml:lang"));
}

#[test]
fn duplicate_language_ids_and_text_keep_independent_ordinals() {
    let body = concat!(
        "<conceptEntry id=\"dup\"><langSec xml:lang=\"en-US\"><termSec id=\"term-id\"><term>same</term></termSec></langSec><langSec xml:lang=\"EN-us\"><termSec id=\"term-id\"><term>same</term></termSec></langSec><langSec xml:lang=\"fr-FR\"><termSec><term>cible</term></termSec></langSec></conceptEntry>",
        "<conceptEntry id=\"dup\"><langSec xml:lang=\"en-US\"><termSec><term>new</term></termSec></langSec><langSec xml:lang=\"fr-FR\"><termSec><term>nouveau</term></termSec></langSec></conceptEntry>"
    );
    let report = preview(&document(body)).unwrap();
    assert_eq!(report.rows.len(), 2);
    assert_eq!(report.rows[0].status, TbxRowStatus::Excluded);
    assert!(
        report.rows[0]
            .reasons
            .contains(&TbxRowReason::AmbiguousSource)
    );
    assert_eq!(
        report.rows[0]
            .source_terms
            .iter()
            .map(|term| term.ordinal)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(report.rows[1].ordinal, 2);
    assert_eq!(report.rows[1].status, TbxRowStatus::PossibleMapping);
    for kind in [
        TbxLossKind::DuplicateConceptId,
        TbxLossKind::DuplicateTermId,
        TbxLossKind::DuplicateLanguage,
        TbxLossKind::DuplicateTermText,
    ] {
        assert!(
            report.losses.iter().any(|loss| loss.kind == kind),
            "missing {kind:?}"
        );
    }
}

#[test]
fn usage_status_is_raw_metadata_and_unknown_categories_are_losses() {
    let body = format!(
        "<conceptEntry><langSec xml:lang=\"en-US\"><termSec><term>source</term><termNote type=\"usageStatus\">preferred</termNote><termNote type=\"usageStatus\">preferred</termNote><termNote type=\"usageStatus\">preferredTerm-admn-sts</termNote><termNote type=\"usageStatus\">experimental</termNote><termNote type=\"partOfSpeech\">noun</termNote><descrip type=\"vendorUnknown\">x</descrip></termSec></langSec>{}</conceptEntry>",
        term("fr-FR", "target")
    );
    let report = preview(&document(&body)).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::PossibleMapping);
    assert_eq!(
        report.rows[0].source_terms[0].usage_statuses,
        vec![
            "preferred",
            "preferred",
            "preferredTerm-admn-sts",
            "experimental"
        ]
    );
    assert!(has_loss(
        &report,
        TbxLossKind::DuplicateUsageStatus,
        "usageStatus"
    ));
    assert_eq!(
        report
            .losses
            .iter()
            .find(|loss| loss.kind == TbxLossKind::DuplicateUsageStatus
                && loss.field == "usageStatus")
            .unwrap()
            .count,
        3
    );
    assert!(has_loss(
        &report,
        TbxLossKind::UnknownUsageStatus,
        "usageStatus"
    ));
    assert_eq!(
        report.losses.iter().find(|loss| loss.kind == TbxLossKind::UnknownUsageStatus && loss.field == "usageStatus").unwrap().count,
        2
    );
    assert!(has_loss(
        &report,
        TbxLossKind::UnmappedMetadata,
        "partOfSpeech"
    ));
    assert!(!has_loss(
        &report,
        TbxLossKind::UnknownDataCategory,
        "partOfSpeech"
    ));
    assert!(has_loss(
        &report,
        TbxLossKind::UnknownDataCategory,
        "vendorUnknown"
    ));
}

#[test]
fn distinct_and_unreadable_usage_statuses_still_count_each_extra_field() {
    let body = format!(
        "<conceptEntry><langSec xml:lang=\"en-US\"><termSec><term>source</term><termNote type=\"usageStatus\">preferred</termNote><termNote type=\"usageStatus\">deprecated</termNote><termNote type=\"usageStatus\"><hi>unreadable</hi></termNote><termNote type=\"usageStatus\">experimental</termNote></termSec></langSec>{}</conceptEntry>",
        term("fr-FR", "target")
    );
    let report = preview(&document(&body)).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::Excluded);
    assert!(
        report.rows[0]
            .reasons
            .contains(&TbxRowReason::InvalidSourceTerm)
    );
    assert!(
        report.rows[0].source_terms[0]
            .reasons
            .contains(&TbxTermReason::InlineMarkup)
    );
    assert_eq!(
        report.rows[0].source_terms[0].usage_statuses,
        vec!["preferred", "deprecated", "experimental"]
    );
    let duplicates = report
        .losses
        .iter()
        .find(|loss| loss.kind == TbxLossKind::DuplicateUsageStatus)
        .unwrap();
    assert_eq!(duplicates.count, 3);
    assert!(has_loss(
        &report,
        TbxLossKind::UnknownUsageStatus,
        "usageStatus"
    ));
    assert!(has_loss(&report, TbxLossKind::InlineMarkup, "hi"));
}

#[test]
fn inline_direct_source_excludes_only_its_selected_term() {
    let body = format!(
        "<conceptEntry><langSec xml:lang=\"en-US\"><termSec><term>source</term><admin type=\"source\"><hi/>citation</admin></termSec></langSec>{}</conceptEntry>",
        term("fr-FR", "target")
    );
    let report = preview(&document(&body)).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::Excluded);
    assert_eq!(
        report.rows[0].source_terms[0].text.as_deref(),
        Some("source")
    );
    assert!(report.rows[0].source_terms[0].sources.is_empty());
    assert!(
        report.rows[0].source_terms[0]
            .reasons
            .contains(&TbxTermReason::InlineMarkup)
    );
    assert!(
        report.rows[0]
            .reasons
            .contains(&TbxRowReason::InvalidSourceTerm)
    );
    assert!(has_loss(&report, TbxLossKind::InlineMarkup, "hi"));
}

#[test]
fn nested_structural_metadata_excludes_affected_concept_or_term_only() {
    let concept_metadata = format!(
        "<conceptEntry><descripGrp><langSec xml:lang=\"de-DE\"><termSec><term>misplaced</term></termSec></langSec></descripGrp>{}{}</conceptEntry>",
        term("en-US", "source"),
        term("fr-FR", "target")
    );
    let term_metadata = format!(
        "<conceptEntry><langSec xml:lang=\"en-US\"><termSec><term>source</term><descripGrp><termSec><term>misplaced</term></termSec></descripGrp></termSec></langSec>{}</conceptEntry>",
        term("fr-FR", "target")
    );
    let extra_language_metadata = format!(
        "<conceptEntry>{}{}<langSec xml:lang=\"de-DE\"><termSec><term>extra</term><descripGrp><termSec><term>misplaced</term></termSec></descripGrp></termSec></langSec></conceptEntry>",
        term("en-US", "source"),
        term("fr-FR", "target")
    );
    let report = preview(&document(&format!(
        "{concept_metadata}{term_metadata}{extra_language_metadata}"
    )))
    .unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::Excluded);
    assert!(
        report.rows[0]
            .reasons
            .contains(&TbxRowReason::UnknownStructure)
    );
    assert_eq!(report.rows[1].status, TbxRowStatus::Excluded);
    assert!(
        report.rows[1].source_terms[0]
            .reasons
            .contains(&TbxTermReason::UnknownStructure)
    );
    assert!(
        report.rows[1]
            .reasons
            .contains(&TbxRowReason::InvalidSourceTerm)
    );
    assert_eq!(
        report.rows[1].source_terms[0].text.as_deref(),
        Some("source")
    );
    assert_eq!(report.rows[2].status, TbxRowStatus::PossibleMapping);
    assert!(has_loss(&report, TbxLossKind::UnknownStructure, "termSec"));
    assert!(has_loss(&report, TbxLossKind::UnknownElement, "termSec"));
}

#[test]
fn metadata_losses_distinguish_known_categories_and_unmapped_ids() {
    let body = format!(
        "<conceptEntry><descrip type=\"definition\" id=\"meta-1\">meaning</descrip><descrip type=\"context\">sentence</descrip><admin type=\"source\">concept source</admin>{}{}</conceptEntry>",
        term("en-US", "source"),
        term("fr-FR", "target")
    );
    let report = preview(&document(&body)).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::PossibleMapping);
    for field in ["definition", "context", "source", "id"] {
        assert!(
            has_loss(&report, TbxLossKind::UnmappedMetadata, field),
            "missing {field}"
        );
    }
    for field in ["descrip", "admin"] {
        assert!(
            !has_loss(&report, TbxLossKind::UnmappedMetadata, field),
            "double-counted {field}"
        );
    }
    assert!(
        !report
            .losses
            .iter()
            .any(|loss| loss.kind == TbxLossKind::UnknownDataCategory)
    );
}

#[test]
fn optional_back_after_concepts_is_metadata_only() {
    let concept = pair();
    let back = "<back><ref target=\"file:///unavailable/example\">reference only</ref></back>";
    let report = preview(&document(&format!("{concept}{back}"))).unwrap();
    assert_eq!(report.rows.len(), 1);
    assert_eq!(report.rows[0].status, TbxRowStatus::PossibleMapping);
    assert!(has_loss(&report, TbxLossKind::UnmappedMetadata, "back"));
    assert!(has_loss(&report, TbxLossKind::UnmappedMetadata, "ref"));
    assert!(has_loss(&report, TbxLossKind::UnknownAttribute, "target"));
    for body in [
        format!("{back}{concept}"),
        format!("{concept}{back}<back/>"),
        format!("{concept}<odd/>"),
    ] {
        assert_eq!(
            preview(&document(&body)).unwrap_err().stage,
            "tbx-structure"
        );
    }
}

#[test]
fn empty_text_remains_visible_nbsp_is_content_and_inline_is_not_flattened() {
    let body = format!(
        "<conceptEntry>{}{}</conceptEntry><conceptEntry>{}{}</conceptEntry><conceptEntry>{}{}</conceptEntry>",
        term("en-US", ""),
        term("fr-FR", " \t\n"),
        term("en-US", "\u{a0}"),
        term("fr-FR", "target"),
        term("en-US", "<hi/>source"),
        term("fr-FR", "target")
    );
    let report = preview(&document(&body)).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::Excluded);
    assert_eq!(report.rows[0].source_terms[0].text.as_deref(), Some(""));
    assert_eq!(
        report.rows[0].target_terms[0].text.as_deref(),
        Some(" \t\n")
    );
    assert!(
        report.rows[0].source_terms[0]
            .reasons
            .contains(&TbxTermReason::EmptyTerm)
    );
    assert_eq!(report.rows[1].status, TbxRowStatus::PossibleMapping);
    assert_eq!(
        report.rows[1].source_terms[0].text.as_deref(),
        Some("\u{a0}")
    );
    assert_eq!(report.rows[2].source_terms[0].text, None);
    assert!(
        report.rows[2].source_terms[0]
            .reasons
            .contains(&TbxTermReason::InlineMarkup)
    );
    assert_eq!(report.rows[2].status, TbxRowStatus::Excluded);
    assert!(has_loss(&report, TbxLossKind::InlineMarkup, "hi"));
    let structural_nbsp = document(&pair()).replacen("<body>", "<body>\u{a0}", 1);
    assert!(preview(&structural_nbsp).is_err());
}

#[test]
fn misordered_local_structure_and_invalid_language_exclude_but_preserve_terms() {
    let body = concat!(
        "<conceptEntry><langSec xml:lang=\"en-US\"><termSec><admin type=\"source\">note</admin><term>source</term></termSec></langSec><langSec xml:lang=\"fr-FR\"><termSec><term>target</term></termSec></langSec><descrip type=\"definition\">late</descrip></conceptEntry>",
        "<conceptEntry><langSec xml:lang=\"bad_locale\"><termSec><term>unknown</term></termSec></langSec><langSec xml:lang=\"en-US\"><termSec><term>source</term></termSec></langSec><langSec xml:lang=\"fr-FR\"><termSec><term>target</term></termSec></langSec></conceptEntry>"
    );
    let report = preview(&document(body)).unwrap();
    assert_eq!(
        report.rows[0].source_terms[0].text.as_deref(),
        Some("source")
    );
    assert!(
        report.rows[0].source_terms[0]
            .reasons
            .contains(&TbxTermReason::UnknownStructure)
    );
    assert!(
        report.rows[0]
            .reasons
            .contains(&TbxRowReason::UnknownStructure)
    );
    assert_eq!(report.rows[1].status, TbxRowStatus::Excluded);
    assert!(
        report.rows[1]
            .reasons
            .contains(&TbxRowReason::InvalidLanguage)
    );
}

#[test]
fn accepts_only_top_level_schema_hint_and_rejects_dtd_other_pi_or_wrong_namespace() {
    let base = document(&pair());
    let hinted = format!("<?xml-model href=\"literal<!DOCTYPE\"?>{base}");
    let report = preview(&hinted).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::PossibleMapping);
    let hint = report
        .losses
        .iter()
        .find(|loss| loss.kind == TbxLossKind::SchemaHint)
        .unwrap();
    assert_eq!(hint.count, 1);
    assert_eq!(hint.samples[0].byte_offset, 0);
    assert_eq!(
        hint.samples[0].path,
        "/processing-instruction('xml-model')[1]"
    );
    for xml in [
        format!("<!DOCTYPE tbx>{base}"),
        format!("<?other test?>{base}"),
        base.replacen("<body>", "<body><?xml-model href='x'?>", 1),
        base.replacen(TBX_NS, "urn:wrong", 1),
        base.replacen(
            "<text>",
            "<text xmlns:xi=\"http://www.w3.org/2001/XInclude\">",
            1,
        ),
        base.replacen("type=\"TBX-Basic\"", "type=\"Other\"", 1),
        base.replacen("style=\"dca\"", "style=\"dita\"", 1),
        base.replacen("xml:lang=\"en-US\"", "xml:lang=\"bad_locale\"", 1),
    ] {
        assert!(
            preview(&xml).is_err(),
            "accepted unsupported TBX document: {xml}"
        );
    }
}

#[test]
fn bom_offsets_and_global_loss_sample_count_are_exact() {
    let repeated = (0..30).map(|_| format!("<conceptEntry>{}{}<langSec xml:lang=\"de-DE\"><termSec><term>extra</term></termSec></langSec></conceptEntry>", term("en-US", "source"), term("fr-FR", "target"))).collect::<String>();
    let xml = document(&repeated);
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(xml.as_bytes());
    let report = preview_tbx_exchange(&bytes, "en-US", "fr-FR").unwrap();
    assert_eq!(report.byte_len as usize, bytes.len());
    assert_eq!(report.digest, codec::digest(&bytes));
    let extra = report
        .losses
        .iter()
        .find(|loss| loss.kind == TbxLossKind::ExtraLanguage)
        .unwrap();
    assert_eq!(extra.count, 30);
    assert_eq!(extra.unlisted, 30 - extra.samples.len() as u32);
    assert_eq!(
        report
            .losses
            .iter()
            .map(|loss| loss.samples.len())
            .sum::<usize>(),
        exchange_xml::MAX_LOSS_SAMPLES
    );
    assert!(extra.samples[0].byte_offset >= 3);
    assert_eq!(extra.samples[0].ordinal, Some(1));
    assert!(
        report
            .rows
            .iter()
            .all(|row| row.status == TbxRowStatus::PossibleMapping)
    );
}

#[test]
fn concept_language_and_term_budgets_accept_exact_limit_and_reject_plus_one() {
    let unit = format!(
        "<conceptEntry>{}{}</conceptEntry>",
        term("en-US", "s"),
        term("fr-FR", "t")
    );
    let at_concept = preview(&document(&unit.repeat(MAX_CONCEPTS))).unwrap();
    assert_eq!(at_concept.rows.len(), MAX_CONCEPTS);
    let err = preview(&document(&unit.repeat(MAX_CONCEPTS + 1))).unwrap_err();
    assert_eq!(err.code, ErrorCode::LimitExceeded);
    assert_eq!(err.stage, "tbx-concept");

    let extra_lang = "<langSec xml:lang=\"de-DE\"><termSec><term>x</term></termSec></langSec>";
    let body = format!(
        "<conceptEntry>{}{}{}</conceptEntry>",
        term("en-US", "s"),
        term("fr-FR", "t"),
        extra_lang.repeat(MAX_LANG_SECS - 2)
    );
    let at_both = preview(&document(&body)).unwrap();
    assert_eq!(at_both.rows[0].status, TbxRowStatus::PossibleMapping);
    let too_many_lang = body.replacen(
        "</conceptEntry>",
        &format!("{extra_lang}</conceptEntry>"),
        1,
    );
    assert_eq!(
        preview(&document(&too_many_lang)).unwrap_err().stage,
        "tbx-lang-sec"
    );
    let term_sec = "<termSec><term>x</term></termSec>";
    let terms = format!(
        "<conceptEntry><langSec xml:lang=\"en-US\">{}</langSec></conceptEntry>",
        term_sec.repeat(MAX_TERM_SECS)
    );
    assert_eq!(
        preview(&document(&terms)).unwrap().rows[0]
            .source_terms
            .len(),
        MAX_TERM_SECS
    );
    let too_many_terms = terms.replacen("</langSec>", &format!("{term_sec}</langSec>"), 1);
    assert_eq!(
        preview(&document(&too_many_terms)).unwrap_err().stage,
        "tbx-term-sec"
    );
}

#[test]
fn shared_xml_caps_and_long_names_preserve_real_loss_paths() {
    let basic = document("");
    let base_count = 9; // root, header, fileDesc, two description groups and leaves, text, body
    let notes = "<note/>".repeat(exchange_xml::MAX_ELEMENTS - base_count);
    let full = basic.replacen("</fileDesc>", &format!("</fileDesc>{notes}"), 1);
    assert!(preview(&full).is_ok());
    let too_many = basic.replacen("</fileDesc>", &format!("</fileDesc>{notes}<note/>"), 1);
    assert_eq!(preview(&too_many).unwrap_err().stage, "tbx-elements");
    // Nested notes under fileDesc reach depth 16 without a term budget.
    let deep = |count: usize| {
        basic.replacen(
            "</fileDesc>",
            &format!(
                "{}{}</fileDesc>",
                "<note>".repeat(count),
                "</note>".repeat(count)
            ),
            1,
        )
    };
    assert!(preview(&deep(exchange_xml::MAX_DEPTH - 3)).is_ok());
    assert_eq!(
        preview(&deep(exchange_xml::MAX_DEPTH - 2))
            .unwrap_err()
            .stage,
        "tbx-depth"
    );
    let attrs = |count: usize| {
        (0..count)
            .map(|i| format!(" a{i}=\"v\""))
            .collect::<String>()
    };
    let with_attrs = |count: usize| {
        basic.replacen(
            "style=\"dca\"",
            &format!("style=\"dca\"{}", attrs(count)),
            1,
        )
    };
    assert!(preview(&with_attrs(exchange_xml::MAX_ATTRIBUTES - 3)).is_ok());
    assert_eq!(
        preview(&with_attrs(exchange_xml::MAX_ATTRIBUTES - 2))
            .unwrap_err()
            .stage,
        "tbx-attributes"
    );

    let long = "n".repeat(560);
    let long_body = format!(
        "<conceptEntry {long}=\"v\" vendorValue=\"{}\"><{long}/>{}{}</conceptEntry>",
        "v".repeat(exchange_xml::MAX_SEGMENT_BYTES + 1),
        term("en-US", "s"),
        term("fr-FR", "t")
    );
    let report = preview(&document(&long_body)).unwrap();
    assert_eq!(report.rows[0].status, TbxRowStatus::Excluded);
    assert!(has_loss(&report, TbxLossKind::UnknownAttribute, &long));
    let element = report
        .losses
        .iter()
        .find(|loss| loss.kind == TbxLossKind::UnknownElement && loss.field == long)
        .unwrap();
    assert_eq!(element.samples[0].path, "/*[1]/*[2]/*[1]/*[1]/*[1]");
}

#[test]
fn input_and_term_limits_reject_without_partial_success() {
    let huge_input = vec![b' '; MAX_TBX_INPUT_BYTES + 1];
    assert_eq!(
        preview_tbx_exchange(&huge_input, "en-US", "fr-FR")
            .unwrap_err()
            .stage,
        "tbx-input"
    );
    let exact = "x".repeat(exchange_xml::MAX_SEGMENT_BYTES);
    let exact_body = format!(
        "<conceptEntry>{}{}</conceptEntry>",
        term("en-US", &exact),
        term("fr-FR", "target")
    );
    assert_eq!(
        preview(&document(&exact_body)).unwrap().rows[0].status,
        TbxRowStatus::PossibleMapping
    );
    let over = "x".repeat(exchange_xml::MAX_SEGMENT_BYTES + 1);
    let body = format!(
        "<conceptEntry>{}{}</conceptEntry>",
        term("en-US", &over),
        term("fr-FR", "target")
    );
    assert_eq!(preview(&document(&body)).unwrap_err().stage, "tbx-term");
    let invalid = vec![0xff, 0xfe];
    assert_eq!(
        preview_tbx_exchange(&invalid, "en-US", "fr-FR")
            .unwrap_err()
            .code,
        ErrorCode::InvalidInput
    );
}
