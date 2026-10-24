use super::*;
use std::collections::BTreeMap;

fn application_tool() -> WorkPlanToolSpec {
    let mut selected = tool();
    selected.execution.component_scope = sdk::ComponentScope::Application;
    selected.execution.application_scope = Some(ApplicationScopeBasis {
        instance_id: ExecutionId::new(),
        activation_generation: 1,
    });
    selected.application_capabilities = vec![sdk::ProcessCapability {
        contribution_id: selected.binding.capability.provider.contribution_id.clone(),
        capability: selected.binding.capability.declaration.clone(),
    }];
    selected
}

fn lease(selected: &WorkPlanToolSpec) -> ApplicationExecutionLease {
    let mut bindings = Vec::new();
    for member in &selected.application_capabilities {
        let mut binding = selected.execution.clone();
        binding.capability.provider.contribution_id = member.contribution_id.clone();
        binding.capability.declaration = member.capability.clone();
        let profiles = if member.capability.profiles.is_empty() {
            vec![None]
        } else {
            member
                .capability
                .profiles
                .iter()
                .cloned()
                .map(Some)
                .collect()
        };
        for profile in profiles {
            binding.profile = profile;
            bindings.push(binding.clone());
        }
    }
    ApplicationExecutionLease::capture(
        bindings,
        true,
        Cancellation::default(),
        Cancellation::default(),
    )
    .unwrap()
}

fn fixture_with_application() -> (Fixture, ApplicationExecutionLease) {
    let selected = application_tool();
    let lease = lease(&selected);
    let fixture = fixture_with_tool_runners_and_leases(
        2,
        vec![selected.clone()],
        vec![Arc::new(UncalledPlugin(selected.clone()))],
        BTreeMap::from([(selected.handle, lease.clone())]),
    );
    (fixture, lease)
}

#[test]
fn application_tool_roster_is_required_exact_and_read_only() {
    let selected = application_tool();
    let valid = WorkPlanTools {
        max_invocations: 2,
        entries: vec![selected.clone()],
    };
    valid.validate().unwrap();
    let mut document = serde_json::to_value(&selected).unwrap();
    document
        .as_object_mut()
        .unwrap()
        .remove("applicationCapabilities");
    assert!(serde_json::from_value::<WorkPlanToolSpec>(document).is_err());
    let mut sibling = selected.application_capabilities[0].clone();
    sibling.contribution_id = "query.second".into();
    let mut multiple = valid.clone();
    multiple.entries[0]
        .application_capabilities
        .push(sibling.clone());
    multiple.validate().unwrap();
    let mut missing = valid.clone();
    missing.entries[0].application_capabilities.clear();
    assert!(missing.validate().is_err());
    let mut wrong_selected = valid.clone();
    wrong_selected.entries[0].application_capabilities[0]
        .capability
        .output_schema
        .behavior_version += 1;
    assert!(wrong_selected.validate().is_err());
    let mut duplicate = valid.clone();
    duplicate.entries[0]
        .application_capabilities
        .push(selected.application_capabilities[0].clone());
    assert!(duplicate.validate().is_err());
    let mut effect = multiple.clone();
    effect.entries[0].application_capabilities[1]
        .capability
        .effect = sdk::EffectKind::External;
    assert!(effect.validate().is_err());
    let mut service = multiple.clone();
    service.entries[0].application_capabilities[1]
        .capability
        .permissions
        .push(sdk::PermissionRequest::ProjectService {
            contract: sdk::generation_service_contract(),
        });
    assert!(service.validate().is_err());
    let mut non_application = valid.clone();
    non_application.entries[0].execution.component_scope = sdk::ComponentScope::Project;
    non_application.entries[0].execution.application_scope = None;
    assert!(non_application.validate().is_err());
    let mut native = valid;
    native.entries[0].execution.environment = sdk::NativeHostEnvironmentDescriptor {
        protocol_version: sdk::NATIVE_HOST_ENVIRONMENT_PROTOCOL,
        platform: sdk::RuntimePlatform {
            operating_system: sdk::RuntimeOperatingSystem::Macos,
            architecture: sdk::RuntimeArchitecture::Aarch64,
        },
        sdk_version: "0.1.0-alpha.1".into(),
        process_protocol: sdk::PROCESS_PROTOCOL,
        profile: sdk::NativeHostProfile::NativeApplicationHostV1,
        host_version: "0.2.0-alpha.1".into(),
        executable: sdk::NativeHostExecutableIdentity::DarwinCodeDirectoryHashV1("a".repeat(40)),
    }
    .into();
    native.validate().unwrap();
    native.entries[0].application_capabilities.push(sibling);
    assert!(native.validate().is_err());
}

#[test]
fn application_tool_consent_requires_live_exact_lease_and_complete_roster() {
    let (f, original) = fixture_with_application();
    let selected = &f.plan.tools.as_ref().unwrap().entries[0];
    let consent = PluginConsent {
        unsandboxed_execution: true,
        application_execution: true,
    };
    let authorize = |leases| {
        f.runtime.authorize_work_plan_tools(
            &f.store,
            f.lease,
            now_ms() + 60_000,
            Instant::now() + Duration::from_secs(60),
            consent,
            leases,
        )
    };
    assert!(authorize(BTreeMap::new()).is_err());
    assert!(authorize(BTreeMap::from([(ExecutionId::new(), original.clone())])).is_err());
    let mut changed = selected.clone();
    changed
        .execution
        .application_scope
        .as_mut()
        .unwrap()
        .activation_generation += 1;
    assert!(!original.matches_binding(&changed.execution));
    assert!(authorize(BTreeMap::from([(selected.handle, lease(&changed))])).is_err());
    let mut sibling = selected.application_capabilities[0].clone();
    sibling.contribution_id = "query.extra".into();
    changed = selected.clone();
    changed.application_capabilities.push(sibling);
    assert!(authorize(BTreeMap::from([(selected.handle, lease(&changed))])).is_err());
    let full_lifetime = lease(&changed);
    let with_siblings = fixture_with_tool_runners_and_leases(
        2,
        vec![changed.clone()],
        vec![Arc::new(UncalledPlugin(changed.clone()))],
        BTreeMap::from([(changed.handle, full_lifetime)]),
    );
    assert!(
        with_siblings
            .runtime
            .authorize_work_plan_tools(
                &with_siblings.store,
                with_siblings.lease,
                now_ms() + 60_000,
                Instant::now() + Duration::from_secs(60),
                consent,
                BTreeMap::from([(changed.handle, original.clone())]),
            )
            .is_err()
    );
    original.revocation().request();
    assert!(authorize(BTreeMap::from([(selected.handle, original)])).is_err());
}

#[test]
fn application_tool_delegation_refuses_erased_lifetime_consent_on_reopen() {
    let (mut f, _lifetime) = fixture_with_application();
    let query = request(&f, vec![f.units[0]]);
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &query)
        .unwrap();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, ExecutionId::new())
        .unwrap();
    let path = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let database = path.join("project.sqlite3");
    let connection = rusqlite::Connection::open(&database).unwrap();
    assert_eq!(connection.execute(
        "UPDATE plugin_execution_grants SET application_execution=0 WHERE attempt_id=?1 AND application_execution=1 AND delegation IS NOT NULL",
        [query.attempt_id.to_string()],
    ).unwrap(), 1);
    drop(connection);
    let before = std::fs::read(&database).unwrap();
    assert!(matches!(
        ProjectStore::open(&path),
        Err(tsumugi_core::PersistenceError::CorruptProject { .. })
    ));
    assert_eq!(std::fs::read(database).unwrap(), before);
}

#[test]
fn application_tool_delegation_records_independent_grant_and_never_restores_lease() {
    let (mut f, lifetime) = fixture_with_application();
    let query = request(&f, vec![f.units[0]]);
    let prepared = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &query)
        .unwrap();
    let grant = ExecutionId::new();
    f.runtime
        .submit_work_plan_tool(&mut f.store, &prepared, &f.consent, grant)
        .unwrap();
    let db = rusqlite::Connection::open(f.store.directory().join("project.sqlite3")).unwrap();
    let recorded: (String, i64, bool) = db.query_row(
        "SELECT grant_id,application_execution,delegation IS NOT NULL FROM plugin_execution_grants WHERE attempt_id=?1",
        [query.attempt_id.to_string()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).unwrap();
    assert_eq!(recorded, (grant.to_string(), 1, true));
    drop(db);
    let item = prepared.input().envelope().items[0].item_id;
    let dispatch = f
        .store
        .dispatch_execution_item(query.attempt_id, item)
        .unwrap();
    assert!(dispatch.plugin_permit().unwrap().is_work_plan_tool());
    assert!(dispatch.plugin_permit().unwrap().is_authorized());
    lifetime.revocation().request();
    assert!(!dispatch.plugin_permit().unwrap().is_authorized());
    f.store
        .note_execution_unknown(query.attempt_id, item, "synthetic-lifetime-withdrawal")
        .unwrap();
    let second = request(&f, vec![f.units[0]]);
    let second = f
        .store
        .prepare_work_plan_agent_tool(&f.scope, &second)
        .unwrap();
    assert!(
        f.runtime
            .submit_work_plan_tool(&mut f.store, &second, &f.consent, ExecutionId::new())
            .is_err()
    );
    assert_eq!(
        f.store.work_plan_tool_invocations(f.plan.plan_id).unwrap(),
        1
    );
    let path = f.store.directory().to_owned();
    drop(f.runtime);
    drop(f.store);
    let reopened = ProjectStore::open(path).unwrap();
    assert_eq!(
        reopened.execution_input(query.attempt_id).unwrap().bytes(),
        prepared.input().bytes()
    );
    assert!(reopened.execution_dispatch(query.attempt_id, item).is_err());
    assert!(!lifetime.is_live());
}
