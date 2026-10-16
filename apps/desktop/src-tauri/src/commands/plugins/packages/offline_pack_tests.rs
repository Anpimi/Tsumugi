use super::super::packs::*;
use super::*;
use crate::commands::RecoveryGuidance;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};
use tsumugi_plugin_host::{
    ApprovedPackageSetting, PackageImage, PluginSettingsUpdate, catalog::PackageOrigin,
};

struct Fixture {
    directory: tempfile::TempDir,
    owner: ApplicationPlugins,
    root: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let owner = ApplicationPlugins::default();
        owner
            .configure(directory.path().join("application"))
            .unwrap();
        let root = directory.path().join("pack");
        fs::create_dir(&root).unwrap();
        let sample: PluginCandidateView = serde_json::from_str(include_str!(
            "../../../../../test/fixtures/pluginPackage.contract.json"
        ))
        .unwrap();
        let mut members = Vec::new();
        for name in ["first", "second"] {
            let member = root.join(name);
            fs::create_dir(&member).unwrap();
            let mut manifest = sample.manifest.clone();
            manifest.plugin.id = format!("local-{name}");
            fs::write(
                member.join("manifest.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            fs::write(
                member.join("worker.mjs"),
                b"throw new Error('installation must not execute');",
            )
            .unwrap();
            let inspection = PackageImage::inspect_directory(&member, || true).unwrap();
            members.push(json!({"directory":name,"plugin":inspection.plugin,"packageDigest":inspection.package_digest}));
        }
        fs::write(root.join("pack.json"), serde_json::to_vec(&json!({"formatVersion":1,"id":"offline-tools","displayName":"Offline tools","packages":members})).unwrap()).unwrap();
        Self {
            directory,
            owner,
            root,
        }
    }
    fn select(&self) -> PluginPackCandidateView {
        let picker = self.owner.begin_picker().unwrap();
        self.owner
            .finish_pack_picker(picker.id, Some(self.root.clone()))
            .unwrap()
            .unwrap()
    }
    fn request(view: &PluginPackCandidateView) -> PluginPackInstallRequest {
        PluginPackInstallRequest {
            ticket: view.ticket,
            members: view
                .packages
                .iter()
                .map(|p| PluginPackageRequest {
                    plugin: p.manifest.plugin.clone(),
                    package_digest: p.package_digest.clone(),
                })
                .collect(),
            expected_revision: 0.into(),
            action_id: ExecutionId::new(),
        }
    }
    fn install(
        &self,
        request: PluginPackInstallRequest,
    ) -> Result<PluginInventoryView, CommandError> {
        self.owner.mutate(MutationRequest::PackInstall(request))
    }
    fn settings(&self) -> PathBuf {
        self.directory
            .path()
            .join("application/plugins/settings.json")
    }
    fn rewrite(path: &Path, bytes: &[u8]) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fn writable(path: &Path) {
            if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
                fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
                for entry in fs::read_dir(path).unwrap() {
                    writable(&entry.unwrap().path());
                }
            }
        }
        writable(self.directory.path());
    }
}

#[test]
fn offline_pack_selection_has_no_store_effect_and_installation_uses_only_selected_frozen_bytes() {
    let f = Fixture::new();
    let selected = f.select();
    assert_eq!(selected.packages.len(), 2);
    assert!(!f.settings().exists());
    let mut request = Fixture::request(&selected);
    request.members.truncate(1);
    fs::remove_dir_all(&f.root).unwrap();
    let installed = f.install(request.clone()).unwrap();
    assert_eq!(installed.settings_revision.get(), 1);
    assert_eq!(
        installed.last_settings_action,
        Some(request.action_id.to_string())
    );
    assert_eq!(installed.packages.len(), 1);
    assert_eq!(installed.packages[0].plugin, request.members[0].plugin);
    assert!(!installed.package_decisions[0].enabled);
    assert_eq!(
        installed.package_decisions[0].origin.source_id,
        "manual-local"
    );
    assert_eq!(
        installed.package_decisions[0].origin.publisher_id,
        "manual-approval"
    );
    f.owner
        .manager
        .lock()
        .unwrap()
        .pack_candidate
        .as_mut()
        .unwrap()
        .expires = Instant::now();
    assert_eq!(f.install(request).unwrap(), installed);
}

#[test]
fn offline_pack_rejects_empty_duplicate_forged_and_outside_members_before_settings_change() {
    for scenario in [
        "empty",
        "duplicate",
        "digest",
        "identity",
        "ticket",
        "too-many",
    ] {
        let f = Fixture::new();
        let selected = f.select();
        let mut request = Fixture::request(&selected);
        match scenario {
            "empty" => request.members.clear(),
            "duplicate" => request.members.push(request.members[0].clone()),
            "digest" => request.members[0].package_digest = "f".repeat(64),
            "identity" => request.members[0].plugin.publisher = "another".into(),
            "ticket" => request.ticket = ExecutionId::new(),
            "too-many" => request.members = vec![request.members[0].clone(); 17],
            _ => unreachable!(),
        }
        assert!(f.install(request).is_err(), "{scenario}");
        assert!(!f.settings().exists(), "{scenario}");
        assert!(f.owner.inventory().unwrap().packages.is_empty());
    }
}

#[test]
fn offline_pack_preview_expiry_replacement_and_closed_owner_reject_new_installation() {
    for scenario in ["expired", "replaced", "closed", "stale"] {
        let f = Fixture::new();
        let selected = f.select();
        let mut request = Fixture::request(&selected);
        match scenario {
            "expired" => {
                f.owner
                    .manager
                    .lock()
                    .unwrap()
                    .pack_candidate
                    .as_mut()
                    .unwrap()
                    .expires = Instant::now()
            }
            "replaced" => {
                f.select();
            }
            "closed" => f.owner.close(),
            "stale" => request.expected_revision = 1.into(),
            _ => unreachable!(),
        }
        assert!(f.install(request).is_err(), "{scenario}");
        assert!(!f.settings().exists());
    }
}

#[test]
fn offline_pack_does_not_replace_cross_source_or_cross_publisher_approval() {
    for changed in ["source", "publisher"] {
        let f = Fixture::new();
        let selected = f.select();
        let member = &selected.packages[0];
        {
            let mut manager = f.owner.manager.lock().unwrap();
            f.owner.provision(&mut manager).unwrap();
            manager
                .store
                .as_mut()
                .unwrap()
                .update_settings(
                    0,
                    &ExecutionId::new().to_string(),
                    &PluginSettingsUpdate {
                        packages: vec![ApprovedPackageSetting {
                            approval: PackageApproval {
                                plugin: member.manifest.plugin.clone(),
                                package_digest: member.package_digest.clone(),
                                origin: PackageOrigin {
                                    source_id: if changed == "source" {
                                        "verified-source"
                                    } else {
                                        "manual-local"
                                    }
                                    .into(),
                                    publisher_id: if changed == "publisher" {
                                        "verified-publisher"
                                    } else {
                                        "manual-approval"
                                    }
                                    .into(),
                                },
                            },
                            enabled: false,
                        }],
                        runtimes: vec![],
                    },
                    || true,
                )
                .unwrap();
        }
        let before = fs::read(f.settings()).unwrap();
        let mut request = Fixture::request(&selected);
        request.expected_revision = 1.into();
        let error = f.install(request).unwrap_err();
        assert_eq!(
            error.reason.as_deref(),
            Some(if changed == "source" {
                "plugin-source-conflict"
            } else {
                "plugin-publisher-conflict"
            })
        );
        assert_eq!(fs::read(f.settings()).unwrap(), before);
        assert!(f.owner.inventory().unwrap().packages.is_empty());
    }
}

#[test]
fn offline_pack_retry_keeps_original_partial_steps_through_source_loss_and_unknown_projection() {
    let f = Fixture::new();
    let selected = f.select();
    let request = Fixture::request(&selected);
    let installed = f.install(request.clone()).unwrap();
    let settings_bytes = fs::read(f.settings()).unwrap();
    let second = f
        .directory
        .path()
        .join("application/plugins/objects")
        .join(&selected.packages[1].package_digest)
        .join("receipt.json");
    let receipt_bytes = fs::read(&second).unwrap();
    let actions = {
        let mut manager = f.owner.manager.lock().unwrap();
        let pending = manager.pending.as_mut().unwrap();
        pending.complete = false;
        for step in &mut pending.packages {
            step.original = Some(step.action.clone());
        }
        pending
            .packages
            .iter()
            .map(|step| step.action.clone())
            .collect::<Vec<_>>()
    };
    fs::remove_dir_all(&f.root).unwrap();
    Fixture::rewrite(&second, b"invalid retained second receipt");
    let error = f.install(request.clone()).unwrap_err();
    assert!(error.recovery_required);
    assert_eq!(
        error.recovery_guidance,
        Some(RecoveryGuidance::ReconcileOriginal)
    );
    assert_eq!(fs::read(f.settings()).unwrap(), settings_bytes);
    assert_eq!(
        f.owner.begin_picker().err().unwrap().code,
        CommandErrorCode::Busy
    );
    let mut altered = request.clone();
    altered.members.pop();
    assert_eq!(f.install(altered).unwrap_err().code, CommandErrorCode::Busy);
    Fixture::rewrite(&second, &receipt_bytes);
    assert_eq!(f.install(request.clone()).unwrap(), installed);
    assert_eq!(
        f.owner
            .manager
            .lock()
            .unwrap()
            .pending
            .as_ref()
            .unwrap()
            .packages
            .iter()
            .map(|step| step.action.clone())
            .collect::<Vec<_>>(),
        actions
    );
    Fixture::rewrite(&f.settings(), b"lost original projection");
    assert_eq!(
        f.install(request.clone()).unwrap_err().code,
        CommandErrorCode::OutcomeUnknown
    );
    Fixture::rewrite(&f.settings(), &settings_bytes);
    assert_eq!(f.install(request).unwrap(), installed);
    assert_eq!(installed.packages.len(), 2);
}

#[test]
fn offline_pack_preserves_existing_enablement_without_enabling_new_members() {
    let f = Fixture::new();
    let selected = f.select();
    let mut first = Fixture::request(&selected);
    first.members.truncate(1);
    let installed = f.install(first).unwrap();
    let enabled = f
        .owner
        .mutate(MutationRequest::Enable(PluginEnableRequest {
            package: PluginPackageRequest {
                plugin: installed.packages[0].plugin.clone(),
                package_digest: installed.packages[0].package_digest.clone(),
            },
            enabled: true,
            expected_revision: 1.into(),
            action_id: ExecutionId::new(),
        }))
        .unwrap();
    let mut all = Fixture::request(&selected);
    all.expected_revision = enabled.settings_revision;
    let result = f.install(all).unwrap();
    assert!(
        result
            .package_decisions
            .iter()
            .find(|p| p.plugin == selected.packages[0].manifest.plugin)
            .unwrap()
            .enabled
    );
    assert!(
        !result
            .package_decisions
            .iter()
            .find(|p| p.plugin == selected.packages[1].manifest.plugin)
            .unwrap()
            .enabled
    );
}

#[test]
fn offline_pack_registered_ipc_installs_exact_members_and_rejects_extra_authority() {
    let f = Fixture::new();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let owner = &app.state::<AppState>().plugins;
    owner
        .configure(f.directory.path().join("ipc-application"))
        .unwrap();
    let picker = owner.begin_picker().unwrap();
    let selected = owner
        .finish_pack_picker(picker.id, Some(f.root.clone()))
        .unwrap()
        .unwrap();
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let call = |request: Value| {
        tauri::test::get_ipc_response(
            &window,
            InvokeRequest {
                cmd: "install_plugin_pack".into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: crate::ipc_test_url().parse().unwrap(),
                body: InvokeBody::Json(json!({"request":request})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
    };
    let request = Fixture::request(&selected);
    let mut forged = serde_json::to_value(&request).unwrap();
    forged["origin"] = json!({"sourceId":"trusted","publisherId":"trusted"});
    assert!(call(forged).is_err());
    assert!(
        !f.directory
            .path()
            .join("ipc-application/plugins/settings.json")
            .exists()
    );
    let result = call(serde_json::to_value(&request).unwrap())
        .unwrap()
        .deserialize::<PluginInventoryView>()
        .unwrap();
    assert_eq!(
        result.last_settings_action,
        Some(request.action_id.to_string())
    );
    assert_eq!(result.packages.len(), 2);
    assert!(result.package_decisions.iter().all(|d| !d.enabled));
    assert_eq!(
        call(serde_json::to_value(&request).unwrap())
            .unwrap()
            .deserialize::<PluginInventoryView>()
            .unwrap(),
        result
    );
}
