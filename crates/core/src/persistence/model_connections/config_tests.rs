use super::*;

fn captured(store: &ModelConnectionStore, id: ExecutionId) -> AiConfig {
    let snapshot = store.snapshot().unwrap();
    let mut config = AiConfig {
        max_requests: 3,
        max_output_tokens: 37,
        share_terms: true,
        ..Default::default()
    };
    snapshot
        .resolve(&snapshot.reference(id).unwrap())
        .unwrap()
        .apply(&mut config);
    config.connection_profile = Some(snapshot.reference(id).unwrap());
    config
}

#[test]
fn profile_configuration_checks_reuse_defaults_without_changing_invocation_controls() {
    let (temp, store) = setup();
    store.verify_configs(&[AiConfig::default()]).unwrap();
    assert!(!temp.path().join("models").exists());
    let id = ExecutionId::new();
    store.change(&save(&store, id, "Saved", "model-a")).unwrap();
    let config = captured(&store, id);
    config.validate().unwrap();
    store
        .verify_configs(&[config.clone(), config.clone()])
        .unwrap();
    assert_eq!(
        (
            config.max_requests,
            config.max_output_tokens,
            config.share_terms,
            config.share_context
        ),
        (3, 37, true, false)
    );
    assert_eq!(
        ModelConnectionStore::at(temp.path().join("models"))
            .unwrap()
            .resolve(config.connection_profile.as_ref().unwrap())
            .unwrap(),
        AiConnection::from_config(&config)
    );
}

#[test]
fn profile_changes_revoke_fresh_preparation_but_keep_captured_settings_and_other_profiles() {
    let (_temp, store) = setup();
    let id = ExecutionId::new();
    store.change(&save(&store, id, "Saved", "model-a")).unwrap();
    let config = captured(&store, id);
    let bytes = serde_json::to_vec(&config).unwrap();
    store
        .change(&save(&store, ExecutionId::new(), "Other", "model-b"))
        .unwrap();
    store.verify_configs(&[config.clone()]).unwrap();
    store
        .change(&save(&store, id, "Renamed", "model-a"))
        .unwrap();
    assert_eq!(
        store.verify_configs(&[config.clone()]).unwrap_err().stage,
        "model-connection-changed"
    );
    assert_eq!(serde_json::to_vec(&config).unwrap(), bytes);
    let latest = captured(&store, id);
    store
        .change(&edit(
            &store,
            ModelConnectionEdit::Archive { profile_id: id },
        ))
        .unwrap();
    assert_eq!(
        store.verify_configs(&[latest.clone()]).unwrap_err().stage,
        "model-connection-unavailable"
    );
    store
        .change(&edit(
            &store,
            ModelConnectionEdit::Restore { profile_id: id },
        ))
        .unwrap();
    assert!(store.verify_configs(&[latest]).is_err());
    store.verify_configs(&[captured(&store, id)]).unwrap();
}

#[test]
fn profile_provenance_refuses_changed_defaults_foreign_stores_and_mixed_variants() {
    let (_temp, store) = setup();
    let id = ExecutionId::new();
    store.change(&save(&store, id, "Saved", "model-a")).unwrap();
    let config = captured(&store, id);
    let mut changed = config.clone();
    changed.endpoint = "https://other.example.test/changed".into();
    assert_eq!(
        store
            .verify_configs(&[config.clone(), changed])
            .unwrap_err()
            .stage,
        "ai-connection-profile"
    );
    let mut foreign = config.clone();
    foreign.connection_profile.as_mut().unwrap().store_id = ExecutionId::new();
    assert_eq!(
        store.verify_configs(&[foreign]).unwrap_err().stage,
        "model-connection-changed"
    );
    let mut invalid = config.clone();
    invalid.connection_profile.as_mut().unwrap().revision = 0.into();
    assert_eq!(
        invalid.validate().unwrap_err().stage,
        "ai-connection-profile"
    );
    invalid.connection_profile.as_mut().unwrap().revision = 1.into();
    invalid.connection_profile.as_mut().unwrap().digest = "invalid".into();
    assert_eq!(
        invalid.validate().unwrap_err().stage,
        "ai-connection-profile"
    );
    // One captured snapshot is a read fact; fresh checks explicitly reread the store.
    let old = store.snapshot().unwrap();
    store.change(&save(&store, id, "Saved", "model-b")).unwrap();
    old.verify_config(&config).unwrap();
    assert!(store.verify_configs(&[config]).is_err());
}

#[test]
fn manual_configuration_encoding_keeps_no_profile_identity_and_profiles_round_trip_exactly() {
    let manual = AiConfig::default();
    let encoded = serde_json::to_value(&manual).unwrap();
    assert!(encoded.get("connectionProfile").is_none());
    assert_eq!(serde_json::from_value::<AiConfig>(encoded).unwrap(), manual);
    let (_temp, store) = setup();
    let id = ExecutionId::new();
    store.change(&save(&store, id, "Saved", "model-a")).unwrap();
    let config = captured(&store, id);
    let encoded = serde_json::to_value(&config).unwrap();
    assert_eq!(encoded["connectionProfile"]["profileId"], id.to_string());
    assert_eq!(serde_json::from_value::<AiConfig>(encoded).unwrap(), config);
}
