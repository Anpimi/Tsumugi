use super::*;

fn document(srclang: &str, body: &str) -> String {
    format!(
        "<tmx version=\"1.4\"><header creationtool=\"fixture\" creationtoolversion=\"1\" segtype=\"sentence\" o-tmf=\"TMX\" adminlang=\"en-US\" srclang=\"{srclang}\" datatype=\"PlainText\"/><body>{body}</body></tmx>"
    )
}

fn preview(xml: &str) -> Result<TmxExchangePreview, ExecutionError> {
    preview_tmx_exchange(xml.as_bytes(), "en-US", "fr-FR")
}

fn kinds(report: &TmxExchangePreview) -> Vec<TmxLossKind> {
    report.losses.iter().map(|loss| loss.kind).collect()
}

#[test]
fn maps_exact_plain_text_without_trimming_or_persisting() {
    let xml = document(
        "en-US",
        "<tu tuid=\"a\" creationid=\"alice\"><tuv xml:lang=\"en-US\"><seg>  Hi &amp; bye\r\nworld  </seg></tuv><tuv xml:lang=\"fr-FR\"><seg><![CDATA[ Salut ]]></seg></tuv></tu>",
    );
    let report = preview(&xml).unwrap();
    assert_eq!(report.profile, PROFILE);
    assert_eq!(report.digest, codec::digest(xml.as_bytes()));
    assert_eq!(report.byte_len as usize, xml.len());
    assert_eq!(report.license, TmxLicenseStatus::Unknown);
    assert_eq!(report.rows.len(), 1);
    let row = &report.rows[0];
    assert_eq!(row.ordinal, 1);
    assert_eq!(row.tuid.as_deref(), Some("a"));
    assert_eq!(row.source_text.as_deref(), Some("  Hi & bye\nworld  "));
    assert_eq!(row.target_text.as_deref(), Some(" Salut "));
    assert_eq!(row.status, TmxRowStatus::Eligible);
    assert!(row.reasons.is_empty());
    assert_eq!(row.tu_provenance.creation_id.as_deref(), Some("alice"));
    let unmapped: Vec<_> = report
        .losses
        .iter()
        .filter(|loss| loss.kind == TmxLossKind::UnmappedMetadata)
        .collect();
    assert_eq!(unmapped.len(), 3);
    for field in ["adminlang", "datatype", "segtype"] {
        assert!(
            unmapped
                .iter()
                .any(|loss| loss.field == field && loss.count == 1)
        );
    }
}

#[test]
fn accepts_utf8_bom_and_five_entities_but_rejects_custom_or_invalid_references() {
    let xml = document(
        "en-US",
        "<tu><tuv xml:lang=\"en-US\"><seg>&lt;&gt;&quot;&apos;&#x41;&#65;</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>ok</seg></tuv></tu>",
    );
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(xml.as_bytes());
    let report = preview_tmx_exchange(&bytes, "en-US", "fr-FR").unwrap();
    assert_eq!(report.rows[0].source_text.as_deref(), Some("<>\"'AA"));
    assert_eq!(report.byte_len as usize, bytes.len());
    assert!(preview(&xml.replace("&#x41;", "&custom;")).is_err());
    assert!(preview(&xml.replace("&#x41;", "&#0;")).is_err());
}

#[test]
fn excludes_ambiguous_missing_and_empty_segments_but_keeps_clean_counterparts() {
    let xml = document(
        "en-US",
        concat!(
            "<tu tuid=\"duplicate\"><tuv xml:lang=\"en-US\"><seg>first</seg></tuv><tuv xml:lang=\"EN-us\"><seg>again</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>valid target</seg></tuv></tu>",
            "<tu tuid=\"duplicate\"><tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>   </seg></tuv></tu>",
            "<tu><tuv xml:lang=\"fr-FR\"><seg>target only</seg></tuv></tu>",
            "<tu><tuv xml:lang=\"en-US\"><seg>source only</seg></tuv></tu>"
        ),
    );
    let report = preview(&xml).unwrap();
    assert_eq!(report.rows.len(), 4);
    assert_eq!(report.rows[0].status, TmxRowStatus::Excluded);
    assert!(
        report.rows[0]
            .reasons
            .contains(&TmxRowReason::AmbiguousSource)
    );
    assert_eq!(report.rows[0].target_text.as_deref(), Some("valid target"));
    assert_eq!(report.rows[1].source_text.as_deref(), Some("source"));
    assert_eq!(report.rows[1].target_text.as_deref(), Some("   "));
    assert!(report.rows[1].reasons.contains(&TmxRowReason::EmptyTarget));
    assert!(
        report.rows[2]
            .reasons
            .contains(&TmxRowReason::MissingSource)
    );
    assert!(
        report.rows[3]
            .reasons
            .contains(&TmxRowReason::MissingTarget)
    );
    for field in ["source-tuv", "target-tuv"] {
        assert!(report.losses.iter().any(|loss| {
            loss.kind == TmxLossKind::MissingSegment && loss.field == field && loss.count == 1
        }));
    }
    for kind in [
        TmxLossKind::DuplicateLanguage,
        TmxLossKind::DuplicateTuid,
        TmxLossKind::EmptySegment,
    ] {
        assert!(kinds(&report).contains(&kind), "missing loss {kind:?}");
    }
}

#[test]
fn known_unmapped_administrative_fields_are_counted() {
    let xml = document(
        "en-US",
        "<tu usagecount=\"2\" datatype=\"PlainText\"><tuv xml:lang=\"en-US\" usagecount=\"1\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv></tu>",
    );
    let report = preview(&xml).unwrap();
    assert_eq!(report.rows[0].status, TmxRowStatus::Eligible);
    for (field, count) in [
        ("adminlang", 1),
        ("segtype", 1),
        ("datatype", 2),
        ("usagecount", 2),
    ] {
        assert!(
            report.losses.iter().any(|loss| {
                loss.kind == TmxLossKind::UnmappedMetadata
                    && loss.field == field
                    && loss.count == count
            }),
            "missing unmapped field {field}"
        );
    }
}

#[test]
fn direction_and_unmapped_material_are_explicit() {
    let xml = document(
        "*all*",
        concat!(
            "<tu srclang=\"fr-FR\"><note>context</note><tuv xml:lang=\"en-US\"><seg>one</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>un</seg></tuv><tuv xml:lang=\"de-DE\"><seg>eins</seg></tuv></tu>",
            "<tu><tuv xml:lang=\"en-US\"><seg>two</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>deux</seg></tuv></tu>"
        ),
    );
    let report = preview(&xml).unwrap();
    assert!(
        report.rows[0]
            .reasons
            .contains(&TmxRowReason::SourceDirectionMismatch)
    );
    assert!(
        report.rows[1]
            .reasons
            .contains(&TmxRowReason::WildcardSourceDirection)
    );
    assert_eq!(report.rows[1].effective_source_locale, None);
    let losses = kinds(&report);
    for kind in [
        TmxLossKind::DirectionMismatch,
        TmxLossKind::WildcardDirection,
        TmxLossKind::ExtraLanguage,
        TmxLossKind::UnmappedMetadata,
    ] {
        assert!(losses.contains(&kind), "missing loss {kind:?}");
    }
}

#[test]
fn inline_and_unknown_structure_exclude_affected_units() {
    let xml = document(
        "en-US",
        concat!(
            "<tu><tuv xml:lang=\"en-US\"><seg>Hello <ph x=\"1\"/>there</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>Bonjour</seg></tuv></tu>",
            "<tu><odd/><tuv xml:lang=\"en-US\"><seg>clean</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>propre</seg></tuv></tu>"
        ),
    );
    let report = preview(&xml).unwrap();
    assert!(report.rows[0].reasons.contains(&TmxRowReason::InlineMarkup));
    assert_eq!(report.rows[0].source_text, None);
    assert_eq!(report.rows[0].target_text.as_deref(), Some("Bonjour"));
    assert!(
        report.rows[1]
            .reasons
            .contains(&TmxRowReason::UnknownStructure)
    );
    assert!(kinds(&report).contains(&TmxLossKind::UnknownElement));
}

#[test]
fn damaged_extra_languages_do_not_exclude_a_clean_selected_pair() {
    let xml = document(
        "en-US",
        concat!(
            "<tu><tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv><tuv xml:lang=\"de-DE\"><seg><ph/>extra</seg></tuv><tuv xml:lang=\"es-ES\"/><tuv xml:lang=\"it-IT\"><odd/><seg>extra</seg></tuv></tu>",
            "<tu><tuv xml:lang=\"en-US\"><seg><ph/>source</seg></tuv><tuv xml:lang=\"fr-FR\"/><tuv xml:lang=\"de-DE\"><seg>extra</seg></tuv></tu>",
            "<tu><tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv><tuv xml:lang=\"bad_locale\"><seg>unknown role</seg></tuv></tu>"
        ),
    );
    let report = preview(&xml).unwrap();
    assert_eq!(report.rows[0].status, TmxRowStatus::Eligible);
    assert!(report.rows[0].reasons.is_empty());
    assert_eq!(report.rows[0].source_text.as_deref(), Some("source"));
    assert_eq!(report.rows[0].target_text.as_deref(), Some("target"));
    for kind in [
        TmxLossKind::ExtraLanguage,
        TmxLossKind::InlineMarkup,
        TmxLossKind::MissingSegment,
        TmxLossKind::UnknownStructure,
        TmxLossKind::UnknownElement,
    ] {
        assert!(kinds(&report).contains(&kind), "missing loss {kind:?}");
    }
    assert_eq!(report.rows[1].status, TmxRowStatus::Excluded);
    assert!(report.rows[1].reasons.contains(&TmxRowReason::InlineMarkup));
    assert!(
        report.rows[1]
            .reasons
            .contains(&TmxRowReason::UnknownStructure)
    );
    assert_eq!(report.rows[1].source_text, None);
    assert_eq!(report.rows[1].target_text, None);
    assert_eq!(report.rows[2].status, TmxRowStatus::Excluded);
    assert!(
        report.rows[2]
            .reasons
            .contains(&TmxRowReason::InvalidLanguage)
    );
}

#[test]
fn empty_segments_preserve_exact_text_and_nbsp_is_not_xml_space() {
    let xml = document(
        "en-US",
        concat!(
            "<tu><tuv xml:lang=\"en-US\"><seg></seg></tuv><tuv xml:lang=\"fr-FR\"><seg> \t\n</seg></tuv></tu>",
            "<tu><tuv xml:lang=\"en-US\"><seg>\u{a0}</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>valid</seg></tuv></tu>"
        ),
    );
    let report = preview(&xml).unwrap();
    assert_eq!(report.rows[0].status, TmxRowStatus::Excluded);
    assert_eq!(report.rows[0].source_text.as_deref(), Some(""));
    assert_eq!(report.rows[0].target_text.as_deref(), Some(" \t\n"));
    assert!(report.rows[0].reasons.contains(&TmxRowReason::EmptySource));
    assert!(report.rows[0].reasons.contains(&TmxRowReason::EmptyTarget));
    assert_eq!(report.rows[1].status, TmxRowStatus::Eligible);
    assert_eq!(report.rows[1].source_text.as_deref(), Some("\u{a0}"));
    assert!(report.rows[1].reasons.is_empty());

    let invalid_global = document("en-US", "").replacen("<body>", "<body>\u{a0}", 1);
    assert_eq!(
        preview(&invalid_global).unwrap_err().code,
        ErrorCode::InvalidInput
    );
    let unknown_unit = document(
        "en-US",
        "<tu>\u{a0}<tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv></tu>",
    );
    let report = preview(&unknown_unit).unwrap();
    assert_eq!(report.rows[0].status, TmxRowStatus::Excluded);
    assert!(
        report.rows[0]
            .reasons
            .contains(&TmxRowReason::UnknownStructure)
    );
}

#[test]
fn rejects_unsupported_global_structure_and_encoding() {
    let basic = document("en-US", "");
    for xml in [
        basic.replacen("<tmx", "<!DOCTYPE tmx SYSTEM \"file:///secret\"><tmx", 1),
        basic.replacen("<tmx", "<tmx:tmx", 1),
        basic.replacen("version=\"1.4\"", "version=\"1.3\"", 1),
        basic.replacen("<header", "<body/><header", 1),
        basic.replacen("</body>", "</body><body/>", 1),
        basic.replacen("</tmx>", "", 1),
        basic.replacen("<header", "<header srclang=\"en-US\"", 1),
    ] {
        assert!(
            preview(&xml).is_err(),
            "accepted unsupported structure: {xml}"
        );
    }
    assert!(preview_tmx_exchange(&[0xff, 0xfe, 0x00], "en-US", "fr-FR").is_err());
    assert!(
        preview(&format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>{basic}"
        ))
        .is_err()
    );
    assert!(preview(&format!("<?xml version=\"1.1\"?>{basic}")).is_err());
}

#[test]
fn enforces_input_and_decoded_segment_caps() {
    let oversized = vec![b' '; MAX_TMX_INPUT_BYTES + 1];
    assert_eq!(
        preview_tmx_exchange(&oversized, "en-US", "fr-FR")
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    let huge_seg = "x".repeat(MAX_SEG_BYTES + 1);
    let xml = document(
        "en-US",
        &format!(
            "<tu><tuv xml:lang=\"en-US\"><seg>{huge_seg}</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>ok</seg></tuv></tu>"
        ),
    );
    assert_eq!(preview(&xml).unwrap_err().code, ErrorCode::LimitExceeded);
}

#[test]
fn loss_counts_remain_complete_after_global_sample_cap() {
    let tus = (0..30).map(|_| "<tu><tuv xml:lang=\"en-US\"><seg>x</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>y</seg></tuv><tuv xml:lang=\"de-DE\"><seg>z</seg></tuv></tu>").collect::<String>();
    let report = preview(&document("en-US", &tus)).unwrap();
    let loss = report
        .losses
        .iter()
        .find(|loss| loss.kind == TmxLossKind::ExtraLanguage)
        .unwrap();
    assert_eq!(loss.count, 30);
    assert_eq!(loss.unlisted, 17);
    assert_eq!(loss.samples.len(), MAX_LOSS_SAMPLES - 3);
    assert_eq!(
        report
            .losses
            .iter()
            .map(|entry| entry.samples.len())
            .sum::<usize>(),
        MAX_LOSS_SAMPLES
    );
    assert_eq!(report.rows.len(), 30);
    assert!(
        report
            .rows
            .iter()
            .all(|row| row.status == TmxRowStatus::Eligible)
    );
}

#[test]
fn rejects_namespace_shadowing_on_unit_or_segment() {
    let body = "<tu><tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv></tu>";
    let plain = document("en-US", body);
    let namespaced_root = plain.replacen(
        "<tmx version",
        "<tmx xmlns=\"http://www.lisa.org/tmx14\" version",
        1,
    );
    assert_eq!(
        preview(&namespaced_root).unwrap().rows[0].status,
        TmxRowStatus::Eligible
    );
    for xml in [
        plain.replacen("<tu>", "<tu xmlns=\"urn:other\">", 1),
        plain.replacen("<seg>", "<seg xmlns=\"urn:other\">", 1),
        namespaced_root.replacen("<tu>", "<tu xmlns=\"\">", 1),
    ] {
        assert_eq!(preview(&xml).unwrap_err().code, ErrorCode::InvalidInput);
    }
}

#[test]
fn validates_xml_names_and_accepts_legal_unicode_unknown_names() {
    let body = "<tu><tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv></tu>";
    let plain = document("en-US", body);
    for xml in [
        plain.replacen("<tu>", "<tu 1bad=\"x\">", 1),
        plain.replacen("<tu>", "<1tu>", 1),
    ] {
        assert!(preview(&xml).is_err());
    }
    let valid = plain.replacen("<tu>", "<tu méta=\"x\">", 1);
    let report = preview(&valid).unwrap();
    assert_eq!(report.rows[0].status, TmxRowStatus::Eligible);
    assert!(
        report
            .losses
            .iter()
            .any(|loss| { loss.kind == TmxLossKind::UnknownAttribute && loss.field == "méta" })
    );
    let valid_unknown_element = plain.replacen("<tu>", "<tu><méta/>", 1);
    let report = preview(&valid_unknown_element).unwrap();
    assert!(
        report.rows[0]
            .reasons
            .contains(&TmxRowReason::UnknownStructure)
    );
    assert!(
        report
            .losses
            .iter()
            .any(|loss| { loss.kind == TmxLossKind::UnknownElement && loss.field == "méta" })
    );
}

#[test]
fn long_legal_names_and_metadata_keep_complete_losses_and_real_paths() {
    let name = "a".repeat(MAX_PATH_BYTES + 40);
    let metadata = "v".repeat(MAX_SEG_BYTES + 1);
    let body = format!(
        "<tu {name}=\"x\" creationid=\"{metadata}\"><{name}/><tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv></tu>"
    );
    let report = preview(&document("en-US", &body)).unwrap();
    assert_eq!(report.rows[0].status, TmxRowStatus::Excluded);
    assert_eq!(
        report.rows[0].tu_provenance.creation_id.as_deref(),
        Some(metadata.as_str())
    );
    assert!(
        report.rows[0]
            .reasons
            .contains(&TmxRowReason::UnknownStructure)
    );
    let attr = report
        .losses
        .iter()
        .find(|loss| loss.kind == TmxLossKind::UnknownAttribute && loss.field == name)
        .unwrap();
    assert_eq!(attr.samples[0].path, "/tmx/body/tu");
    let element = report
        .losses
        .iter()
        .find(|loss| loss.kind == TmxLossKind::UnknownElement && loss.field == name)
        .unwrap();
    assert_eq!(element.samples[0].path, "/*[1]/*[2]/*[1]/*[1]");
    assert!(element.samples[0].path.len() <= MAX_PATH_BYTES);
}

#[test]
fn rejects_raw_less_than_in_attribute_but_accepts_entity() {
    let body = "<tu tuid=\"a&lt;b\"><tuv xml:lang=\"en-US\"><seg>source</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>target</seg></tuv></tu>";
    let valid = document("en-US", body);
    assert_eq!(
        preview(&valid).unwrap().rows[0].tuid.as_deref(),
        Some("a<b")
    );
    let invalid = valid.replace("a&lt;b", "a<b");
    assert_eq!(preview(&invalid).unwrap_err().code, ErrorCode::InvalidInput);
}

#[test]
fn validates_xml_declaration_values_and_order() {
    let basic = document("en-US", "");
    for declaration in [
        "<?xml version=\"1.0\"?>",
        "<?xml version='1.0' encoding='utf-8' standalone='yes'?>",
        "<?xml version=\"1.0\" standalone=\"no\"?>",
    ] {
        assert!(preview(&format!("{declaration}{basic}")).is_ok());
    }
    for declaration in [
        "<?xml version=\"1.1\"?>",
        "<?xml version=\"1.0\" encoding=\"UTF-16\"?>",
        "<?xml version=\"1.0\" standalone=\"maybe\"?>",
        "<?xml version=\"1.0\" extra=\"x\"?>",
        "<?xml version=\"1.0\" encoding=\"UTF-8\" encoding=\"UTF-8\"?>",
        "<?xml version=\"1.0\" standalone=\"yes\" encoding=\"UTF-8\"?>",
        "<?xml version=\"&#x31;.0\"?>",
    ] {
        assert!(
            preview(&format!("{declaration}{basic}")).is_err(),
            "accepted declaration {declaration}"
        );
    }
}

#[test]
fn rejects_real_doctype_but_preserves_literals_in_cdata_and_comments() {
    let body = "<tu><tuv xml:lang=\"en-US\"><seg><![CDATA[<!DOCTYPE tmx>]]></seg></tuv><tuv xml:lang=\"fr-FR\"><seg>ok</seg></tuv></tu>";
    let basic = document("en-US", body);
    let with_comment = format!("<!-- literal <!DOCTYPE tmx> -->{basic}");
    let report = preview(&with_comment).unwrap();
    assert_eq!(
        report.rows[0].source_text.as_deref(),
        Some("<!DOCTYPE tmx>")
    );
    for doctype in [
        "<!DOCTYPE tmx>",
        "<!DOCTYPE tmx SYSTEM \"file:///secret\">",
        "<!DOCTYPE tmx [<!ENTITY x \"value\">]>",
    ] {
        assert!(
            preview(&format!("{doctype}{basic}")).is_err(),
            "accepted real DTD {doctype}"
        );
    }
}

#[test]
fn rejects_literal_cdata_terminator_in_character_data() {
    let valid = document(
        "en-US",
        "<tu><tuv xml:lang=\"en-US\"><seg>safe</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>ok</seg></tuv></tu>",
    );
    assert!(preview(&valid.replace("safe", "bad]]>text")).is_err());
}

#[test]
fn tu_and_tuv_budgets_accept_exact_limits_and_reject_one_more() {
    let unit = "<tu><tuv xml:lang=\"en-US\"><seg>x</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>y</seg></tuv></tu>";
    let body = unit.repeat(MAX_TUS);
    let report = preview(&document("en-US", &body)).unwrap();
    assert_eq!(report.rows.len(), MAX_TUS);
    assert!(
        report
            .rows
            .iter()
            .all(|row| row.status == TmxRowStatus::Eligible)
    );

    let too_many_units = document("en-US", &unit.repeat(MAX_TUS + 1));
    let error = preview(&too_many_units).unwrap_err();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "tmx-tu");

    let extra_variant = "<tuv xml:lang=\"de-DE\"><seg>z</seg></tuv>";
    let too_many_variants = document(
        "en-US",
        &body.replacen("</tu>", &format!("{extra_variant}</tu>"), 1),
    );
    let error = preview(&too_many_variants).unwrap_err();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "tmx-tuv");
}

#[test]
fn element_budget_accepts_8192_and_rejects_8193() {
    let base_elements = 3; // tmx, header and body
    // Notes under the header are legal but deliberately unmapped; aggregation
    // keeps the report small while every element still reaches the parser.
    let notes = "<note/>".repeat(MAX_ELEMENTS - base_elements);
    let full = document("en-US", "").replacen("/><body>", &format!(">{notes}</header><body>"), 1);
    let report = preview(&full).unwrap();
    assert!(report.rows.is_empty());
    assert!(report.losses.iter().any(|loss| {
        loss.kind == TmxLossKind::UnmappedMetadata
            && loss.field == "note"
            && loss.count as usize == MAX_ELEMENTS - base_elements
    }));
    let too_many =
        document("en-US", "").replacen("/><body>", &format!(">{notes}<note/></header><body>"), 1);
    let error = preview(&too_many).unwrap_err();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "tmx-elements");
}

#[test]
fn depth_budget_accepts_16_elements_and_rejects_17() {
    let nested = |levels: usize| {
        let inner = format!("{}{}", "<x>".repeat(levels), "</x>".repeat(levels));
        document("en-US", &format!("<tu>{inner}</tu>"))
    };
    let max_nested_below_tu = MAX_DEPTH - 3; // tmx/body/tu occupy three levels
    let report = preview(&nested(max_nested_below_tu)).unwrap();
    assert_eq!(report.rows.len(), 1);
    assert_eq!(report.rows[0].status, TmxRowStatus::Excluded);
    let error = preview(&nested(max_nested_below_tu + 1)).unwrap_err();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "tmx-depth");
}

#[test]
fn attribute_budget_accepts_32_and_rejects_33() {
    let with_unknown_attrs = |count: usize| {
        let attrs = (0..count)
            .map(|i| format!(" a{i}=\"v\""))
            .collect::<String>();
        document("en-US", "").replacen(
            "<tmx version=\"1.4\"",
            &format!("<tmx version=\"1.4\"{attrs}"),
            1,
        )
    };
    let report = preview(&with_unknown_attrs(MAX_ATTRIBUTES - 1)).unwrap();
    assert_eq!(
        report
            .losses
            .iter()
            .filter(|loss| loss.kind == TmxLossKind::UnknownAttribute)
            .count(),
        MAX_ATTRIBUTES - 1,
    );
    let error = preview(&with_unknown_attrs(MAX_ATTRIBUTES)).unwrap_err();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(error.stage, "tmx-attributes");
}

#[test]
fn bom_offsets_and_duplicate_ids_track_each_ordinal() {
    let unit = "<tu tuid=\"same\"><tuv xml:lang=\"en-US\"><seg>x</seg></tuv><tuv xml:lang=\"fr-FR\"><seg>y</seg></tuv></tu>";
    let xml = document("en-US", &unit.repeat(3));
    let positions: Vec<_> = xml
        .match_indices("<tu tuid=\"same\">")
        .map(|(offset, _)| offset + 3)
        .collect();
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(xml.as_bytes());
    let report = preview_tmx_exchange(&bytes, "en-US", "fr-FR").unwrap();
    assert_eq!(
        report
            .rows
            .iter()
            .map(|row| row.ordinal)
            .collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert!(
        report
            .rows
            .iter()
            .all(|row| row.tuid.as_deref() == Some("same"))
    );
    let duplicate = report
        .losses
        .iter()
        .find(|loss| loss.kind == TmxLossKind::DuplicateTuid)
        .unwrap();
    assert_eq!(duplicate.count, 2);
    assert_eq!(
        duplicate
            .samples
            .iter()
            .map(|sample| sample.ordinal)
            .collect::<Vec<_>>(),
        vec![Some(2), Some(3)]
    );
    assert_eq!(
        duplicate
            .samples
            .iter()
            .map(|sample| sample.byte_offset as usize)
            .collect::<Vec<_>>(),
        positions[1..].to_vec()
    );
}
