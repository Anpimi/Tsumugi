use super::*;
use crate::{
    BuildLocaleChoice, ReleaseAdoptionHandler, ReviewDecisionKind, ReviewWrite,
    SaveTranslationRevision,
};

const S1: &str = include_str!("../../tests/fixtures/webvtt/s1.vtt");
const S2: &str = include_str!("../../tests/fixtures/webvtt/s2.vtt");
const EXPECTED: &str = include_str!("../../tests/fixtures/webvtt/expected-zh-CN.vtt");
const VALUES: [&str; 6] = ["你好\n世界", "等待", "旧", "布局", "相同", "消失"];
fn vtt(text: &str) -> SourceBundle {
    SourceBundle::capture_webvtt(text.as_bytes(), "en").unwrap()
}
fn locale(source: &str) -> BuildLocale {
    let output = extract(&vtt(source), &Cancellation::default()).unwrap();
    BuildLocale {
        locale: "zh-CN".into(),
        file_name: "zh-CN.vtt".into(),
        source_template: Some(source.into()),
        entries: output
            .occurrences
            .iter()
            .zip(VALUES)
            .map(|(cue, text)| BuildEntry {
                ordinal: cue.ordinal,
                unit_id: ExecutionId::new(),
                source_revision_id: ExecutionId::new(),
                native_key: cue.key.clone(),
                source_text: cue.text.clone(),
                value: text.into(),
                selection_id: Some(ExecutionId::new()),
                revision_id: Some(ExecutionId::new()),
                fallback_id: None,
                decision_id: Some(ExecutionId::new()),
                check_id: ExecutionId::new(),
                waiver_ids: vec![],
            })
            .collect(),
    }
}
#[test]
fn caption_parser_and_reconstruction_match_independent_oracle_for_line_endings() {
    for newline in ["\n", "\r\n", "\r"] {
        for bom in ["", "\u{feff}"] {
            let source = format!("{bom}{}", S1.replace('\n', newline));
            let parsed = extract(&vtt(&source), &Cancellation::default()).unwrap();
            assert_eq!(parsed.identity_policy, webvtt::POLICY);
            assert_eq!(
                parsed
                    .occurrences
                    .iter()
                    .map(|c| (c.key.as_str(), c.text.as_str()))
                    .collect::<Vec<_>>(),
                [
                    ("keep", "Hello\nWorld"),
                    ("timed", "Wait"),
                    ("word", "Old"),
                    ("layout", "Layout"),
                    ("rename", "Same"),
                    ("removed", "Gone")
                ]
            );
            let output = build_locale(&locale(&source), &Cancellation::default()).unwrap();
            assert_eq!(
                output.utf8,
                format!("{bom}{}", EXPECTED.replace('\n', newline))
            );
            validate_build_output(&locale(&source), &output).unwrap();
        }
    }
}
#[test]
fn caption_profile_rejects_ambiguous_malformed_and_injected_structure() {
    let invalids = [
        S1.replace("WEBVTT", "INVALID"),
        S1.replace("timed\n", "keep\n"),
        S1.replace("timed\n", "KEEP\n"),
        S1.replace("timed\n", ""),
        S1.replace("00:01.000", "00:60.000"),
        S1.replace("00:01.000", "00:05.000"),
        S1.replace("00:02.000", "00:00.000"),
        S1.replace("align:center", "align:bogus"),
        S1.replace("align:center", "vertical:rl"),
        S1.replace("align:center", "size:101%"),
        S1.replace("align:center", "size:20% size:30%"),
        S1.replace("region:main", "region:missing"),
        S1.replace("Wait", "<b>Wait</b>"),
        S1.replace("Wait", "A --> B"),
        S1.replace("Wait", "&amp;"),
        S1.replace("Wait", ""),
        S1.replace("Wait", "a\0b"),
    ];
    for source in invalids {
        assert!(
            extract(&vtt(&source), &Cancellation::default()).is_err(),
            "accepted malformed captions: {source:?}"
        );
    }
    assert!(SourceBundle::capture_webvtt(&[0xff], "en").is_err());
    assert!(SourceBundle::capture_webvtt(&vec![b'a'; MAX_SOURCE_BYTES + 1], "en").is_err());
    let cancel = Cancellation::default();
    cancel.request();
    assert_eq!(
        extract(&vtt(S1), &cancel).unwrap_err().code,
        ErrorCode::Cancelled
    );
    let mut input = vtt(S1)
        .fixed_input(ProjectId::new_v4())
        .unwrap()
        .envelope()
        .clone();
    input.capability_id = CAPABILITY.into();
    assert!(SourceBundle::from_input(&FixedInput::capture(input).unwrap()).is_err());
}
#[test]
fn caption_checker_rejects_template_and_non_payload_changes() {
    let fixed = locale(S1);
    let valid = build_locale(&fixed, &Cancellation::default()).unwrap();
    for (old, new) in [
        ("00:00.000", "00:00.100"),
        ("color: lime", "color: red"),
        ("NOTE Keep", "NOTE Altered"),
        ("keep\n", "different\n"),
        ("你好", "错误"),
    ] {
        let mut forged = valid.clone();
        forged.utf8 = forged.utf8.replace(old, new);
        forged.sha256 = artifact_digest(forged.utf8.as_bytes());
        assert!(validate_build_output(&fixed, &forged).is_err());
    }
    for text in ["", "a\n\nb", "x --> y", "<v speaker>x", "a\0b", "a\n"] {
        let mut fixed = fixed.clone();
        fixed.entries[0].value = text.into();
        assert!(build_locale(&fixed, &Cancellation::default()).is_err());
    }
    for name in [
        "../zh.vtt",
        "i18n/zh.vtt",
        "con.vtt",
        "source.vtt",
        "zh.json",
    ] {
        let mut fixed = fixed.clone();
        fixed.file_name = name.into();
        assert!(build_locale(&fixed, &Cancellation::default()).is_err());
    }
}
#[test]
fn caption_project_maintains_timing_basis_reviews_releases_and_receipts_on_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("project");
    let mut store = create(&path);
    let (input, result) = generate(&mut store, vtt(S1));
    let action = prepare(&mut store, &input, &result);
    let receipt = store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    assert_eq!(
        store
            .adopt_execution(&action, &SourceAdoptionHandler)
            .unwrap(),
        receipt
    );
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let rows = store.source_content(snapshot, 0, 50).unwrap().rows;
    let project: ExecutionId =
        ExecutionId::parse(&store.metadata().unwrap().project_id().to_string()).unwrap();
    for (row, text) in rows.iter().zip(VALUES) {
        let unit = row.unit_id.unwrap();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        store
            .save_translation_revision(&SaveTranslationRevision {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                source_revision_id: target.source_revision_id,
                expected_selection_id: target.selection_id,
                text: text.into(),
            })
            .unwrap();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        store
            .run_review_checks(project, unit, "zh-CN", &target.basis, ExecutionId::new())
            .unwrap();
        let target = store.review_target(project, unit, "zh-CN").unwrap();
        store
            .write_review(&ReviewWrite {
                project_id: project,
                action_id: ExecutionId::new(),
                unit_id: unit,
                locale: "zh-CN".into(),
                expected_basis: target.basis,
                expected_decision_id: None,
                actor: "Caption reviewer".into(),
                kind: ReviewDecisionKind::Approve,
                reason: String::new(),
            })
            .unwrap();
    }
    let ready = store
        .review_eligibility(project, &["zh-CN".into()])
        .unwrap();
    assert!(ready.ready);
    let build = store
        .prepare_locale_build(
            project,
            ExecutionId::new(),
            &[BuildLocaleChoice {
                locale: "zh-CN".into(),
                file_name: "zh-CN.vtt".into(),
            }],
            &ready.basis,
        )
        .unwrap();
    let manifest = BuildManifest::from_input(&build).unwrap();
    assert_eq!(manifest.plugin_id, webvtt::PLUGIN);
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register(Arc::new(WebvttBuildRunner)).unwrap();
    runtime.submit(&mut store, &build).unwrap();
    let mut forged = manifest.clone();
    forged.locales[0].source_template = Some(S1.replace("color: lime", "color: red"));
    forged.source_files[0].sha256 = artifact_digest(
        forged.locales[0]
            .source_template
            .as_ref()
            .unwrap()
            .as_bytes(),
    );
    let input = forged.fixed_input(ExecutionId::new()).unwrap();
    assert_eq!(
        runtime.submit(&mut store, &input).unwrap_err().code,
        ErrorCode::OutputInvalid
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let build_result = loop {
        runtime.tick(&mut store).unwrap();
        if let Some(id) = store
            .execution_current_result(
                build.envelope().attempt_id,
                build.envelope().items[0].item_id,
            )
            .unwrap()
        {
            break id;
        };
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    };
    let release_action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            build.envelope().attempt_id,
            build.envelope().units[0].unit_id,
            vec![build_result],
            serde_json::Value::Null,
        )
        .unwrap();
    let release_receipt = store
        .adopt_execution(&release_action, &ReleaseAdoptionHandler)
        .unwrap();
    let release: ExecutionId = ExecutionId::parse(&release_receipt.changes[0].id).unwrap();
    assert_eq!(
        store.release_artifact(release, "zh-CN").unwrap().1,
        EXPECTED.as_bytes()
    );
    let (next, next_result) = generate(&mut store, vtt(S2));
    let comparison = store
        .source_comparison(
            next.envelope().attempt_id,
            next_result.envelope().result_id,
            0,
            50,
        )
        .unwrap();
    assert_eq!(
        (
            comparison.unchanged,
            comparison.changed,
            comparison.added,
            comparison.removed
        ),
        (1, 3, 2, 2)
    );
    let mut confirmation = comparison.confirmation;
    confirmation.actor = Some("Caption reviewer".into());
    for row in &comparison.rows {
        if row.kind == "changed" {
            confirmation.lineage.push(LineageChoice {
                new_ordinal: row.new.as_ref().unwrap().ordinal,
                old_occurrence_id: row.old.as_ref().unwrap().occurrence_id.unwrap(),
                decision: LineageDecision::Continue,
                reason: "Confirmed same cue with updated timing or text".into(),
            });
        }
    }
    let estimate = store
        .source_update_estimate(
            next.envelope().attempt_id,
            next_result.envelope().result_id,
            &confirmation,
        )
        .unwrap();
    assert_eq!(
        (
            estimate[0].preserved,
            estimate[0].reassess,
            estimate[0].unresolved
        ),
        (1, 3, 2),
    );
    let change = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            next.envelope().attempt_id,
            next.envelope().units[0].unit_id,
            vec![next_result.envelope().result_id],
            value(&confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&change, &SourceAdoptionHandler)
        .unwrap();
    let changed = store.content_scope().unwrap().current_snapshot.unwrap();
    let page = store.source_content(changed, 0, 50).unwrap();
    assert_eq!(rows[0].source_revision_id, page.rows[0].source_revision_id);
    for index in 1..=3 {
        assert_eq!(rows[index].unit_id, page.rows[index].unit_id);
        assert_ne!(
            rows[index].source_revision_id,
            page.rows[index].source_revision_id
        );
        assert!(
            store
                .review_target(project, page.rows[index].unit_id.unwrap(), "zh-CN")
                .unwrap()
                .current_decision
                .is_none()
        );
    }
    assert_ne!(rows[4].unit_id, page.rows[4].unit_id);
    assert!(
        !store
            .review_eligibility(project, &["zh-CN".into()])
            .unwrap()
            .ready
    );
    assert!(
        store
            .prepare_locale_build(
                project,
                ExecutionId::new(),
                &[BuildLocaleChoice {
                    locale: "zh-CN".into(),
                    file_name: "zh-CN.vtt".into()
                }],
                &ready.basis
            )
            .is_err()
    );
    drop(runtime);
    drop(store);
    let reopened = ProjectStore::open(&path).unwrap();
    assert_eq!(reopened.source_history(0, 10).unwrap().total, 2);
    assert_eq!(
        reopened.release_artifact(release, "zh-CN").unwrap().1,
        EXPECTED.as_bytes()
    );
    assert_eq!(reopened.source_content(snapshot, 0, 50).unwrap().rows, rows);
}
