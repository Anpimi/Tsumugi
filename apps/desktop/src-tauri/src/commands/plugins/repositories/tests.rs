use super::*;
use serde_json::json;
use std::{fs, future::Future, os::unix::fs::PermissionsExt};
use tauri::{
    Manager,
    ipc::{CallbackFn, InvokeBody},
    webview::InvokeRequest,
};

#[path = "../../../../../../../crates/plugin-host/tests/support/offline_repository.rs"]
mod signed;

fn drive<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

struct Fixture {
    directory: tempfile::TempDir,
    owner: Arc<ApplicationPlugins>,
    source: signed::Fixture,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let owner = Arc::new(ApplicationPlugins::default());
        owner
            .configure(directory.path().join("application"))
            .unwrap();
        Self {
            directory,
            owner,
            source: drive(signed::Fixture::new(false)),
        }
    }
    fn select(&self) -> PluginRepositorySelectionView {
        let picker = self.owner.begin_picker().unwrap();
        self.owner
            .finish_repository_picker(
                picker.id,
                Some((
                    self.source.directory.clone(),
                    self.source.write_initial_root(),
                )),
            )
            .unwrap()
            .unwrap()
    }
    fn refresh(&self) -> PluginRepositoryVerifiedView {
        let selection = self.select();
        self.owner
            .refresh_repository(PluginRepositoryRefreshRequest {
                ticket: selection.ticket,
                expected_revision: selection.revision,
                action_id: ExecutionId::new(),
            })
            .unwrap()
    }
    fn install_request(
        view: &PluginRepositoryVerifiedView,
        revision: u64,
    ) -> PluginRepositoryInstallRequest {
        PluginRepositoryInstallRequest {
            ticket: view.ticket,
            expected_revision: revision.into(),
            action_id: ExecutionId::new(),
            members: view
                .packages
                .iter()
                .map(|p| PluginRepositoryMemberRequest {
                    package: PluginPackageRequest {
                        plugin: p.manifest.plugin.clone(),
                        package_digest: p.package_digest.clone(),
                    },
                    kind: p.kind,
                })
                .collect(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        writable(self.directory.path());
    }
}
fn writable(path: &std::path::Path) {
    if fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        for entry in fs::read_dir(path).unwrap() {
            writable(&entry.unwrap().path());
        }
    }
}

#[test]
fn repository_picker_is_read_only_and_verified_packages_remain_separate_disabled_decisions() {
    let f = Fixture::new();
    let selection = f.select();
    assert!(!f.directory.path().join("application").exists());
    let request = PluginRepositoryRefreshRequest {
        ticket: selection.ticket,
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let verified = f.owner.refresh_repository(request.clone()).unwrap();
    assert_ne!(verified.ticket, selection.ticket);
    assert_eq!(verified.source_id, selection.source_id);
    assert_eq!(verified.action_id, request.action_id);
    assert_eq!(verified.revision.get(), 1);
    let inventory = f.owner.inventory().unwrap();
    assert_eq!(inventory.settings_revision.get(), 0);
    assert!(inventory.package_decisions.is_empty());
    assert!(inventory.packages.is_empty());
    fs::remove_dir_all(&f.source.directory).unwrap();
    let installed = f
        .owner
        .mutate(packages::MutationRequest::RepositoryInstall(
            Fixture::install_request(&verified, 0),
        ))
        .unwrap();
    assert_eq!(installed.packages.len(), 1);
    assert!(
        installed
            .package_decisions
            .iter()
            .all(|p| !p.enabled && p.origin.source_id == selection.source_id)
    );
    assert_eq!(
        installed.packages[0].origin.publisher_id,
        "repo-attested-publisher"
    );
}

#[test]
fn metadata_expiry_and_downgrade_do_not_promote_package_approval_or_reset_trust() {
    let f = Fixture::new();
    let verified = f.refresh();
    drive(f.source.publish(
        (2, 2, 2),
        signed::EXPIRED,
        serde_json::to_value(&f.source.catalog).unwrap(),
    ));
    let selected = f.select();
    let error = f
        .owner
        .refresh_repository(PluginRepositoryRefreshRequest {
            ticket: selected.ticket,
            expected_revision: selected.revision,
            action_id: ExecutionId::new(),
        })
        .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("plugin-repository-expired"));
    let inventory = f.owner.inventory().unwrap();
    assert!(inventory.package_decisions.is_empty());
    assert_eq!(inventory.settings_revision.get(), 0);
    // A previous verified ticket cannot bypass a newer rejected trust action.
    assert!(
        f.owner
            .mutate(packages::MutationRequest::RepositoryInstall(
                Fixture::install_request(&verified, 0)
            ))
            .is_err()
    );
    assert_eq!(
        f.owner.repository_sources_view().unwrap().sources[0].state,
        PluginRepositoryState::Rejected
    );
}

#[test]
fn repository_software_rollback_requires_its_exact_explicit_kind_and_one_version_per_member() {
    let f = Fixture::new();
    let first = f.refresh();
    f.owner
        .mutate(packages::MutationRequest::RepositoryInstall(
            Fixture::install_request(&first, 0),
        ))
        .unwrap();
    let mut catalog = f.source.catalog.clone();
    catalog
        .packages
        .push(signed::package(&f.source.directory, "older", "0.9.0"));
    catalog
        .packages
        .push(signed::package(&f.source.directory, "newer", "1.1.0"));
    drive(f.source.publish(
        (2, 2, 2),
        signed::FUTURE,
        serde_json::to_value(&catalog).unwrap(),
    ));
    let next = f.refresh();
    assert_eq!(
        next.packages
            .iter()
            .find(|p| p.manifest.plugin.version == "0.9.0")
            .unwrap()
            .kind,
        PluginRepositoryInstallKind::Rollback
    );
    assert_eq!(
        next.packages
            .iter()
            .find(|p| p.manifest.plugin.version == "1.1.0")
            .unwrap()
            .kind,
        PluginRepositoryInstallKind::Update
    );
    let all = Fixture::install_request(&next, 1);
    assert!(
        f.owner
            .mutate(packages::MutationRequest::RepositoryInstall(all.clone()))
            .is_err()
    );
    let mut rollback = all;
    rollback
        .members
        .retain(|p| p.package.plugin.version == "0.9.0");
    rollback.members[0].kind = PluginRepositoryInstallKind::Update;
    assert!(
        f.owner
            .mutate(packages::MutationRequest::RepositoryInstall(
                rollback.clone()
            ))
            .is_err()
    );
    assert_eq!(f.owner.inventory().unwrap().settings_revision.get(), 1);
    rollback.members[0].kind = PluginRepositoryInstallKind::Rollback;
    let result = f
        .owner
        .mutate(packages::MutationRequest::RepositoryInstall(rollback))
        .unwrap();
    assert_eq!(result.settings_revision.get(), 2);
    assert_eq!(result.packages.len(), 2);
    assert!(result.package_decisions.iter().all(|p| !p.enabled));
}

#[test]
fn independently_signed_repository_cannot_replace_the_same_name_and_bytes_from_another_source() {
    let f = Fixture::new();
    let first = f.refresh();
    let installed = f
        .owner
        .mutate(packages::MutationRequest::RepositoryInstall(
            Fixture::install_request(&first, 0),
        ))
        .unwrap();
    let other = drive(signed::Fixture::new(false));
    let picker = f.owner.begin_picker().unwrap();
    let selected = f
        .owner
        .finish_repository_picker(
            picker.id,
            Some((other.directory.clone(), other.write_initial_root())),
        )
        .unwrap()
        .unwrap();
    assert_ne!(selected.source_id, first.source_id);
    let verified = f
        .owner
        .refresh_repository(PluginRepositoryRefreshRequest {
            ticket: selected.ticket,
            expected_revision: selected.revision,
            action_id: ExecutionId::new(),
        })
        .unwrap();
    assert_eq!(
        verified.packages[0].manifest.plugin,
        first.packages[0].manifest.plugin
    );
    assert_eq!(
        verified.packages[0].package_digest,
        first.packages[0].package_digest
    );
    let error = f
        .owner
        .mutate(packages::MutationRequest::RepositoryInstall(
            Fixture::install_request(&verified, 1),
        ))
        .unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("plugin-source-conflict"));
    assert_eq!(f.owner.inventory().unwrap(), installed);
}

#[test]
fn repository_registered_ipc_binds_root_action_source_and_exact_member_installation() {
    let f = Fixture::new();
    let app = crate::commands::register_commands(tauri::test::mock_builder())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let owner = &app.state::<AppState>().plugins;
    owner
        .configure(f.directory.path().join("ipc-application"))
        .unwrap();
    let picker = owner.begin_picker().unwrap();
    let selection = owner
        .finish_repository_picker(
            picker.id,
            Some((f.source.directory.clone(), f.source.write_initial_root())),
        )
        .unwrap()
        .unwrap();
    drop(picker);
    let window =
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
            .build()
            .unwrap();
    let call = |command: &str, request: serde_json::Value| {
        tauri::test::get_ipc_response(
            &window,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: crate::ipc_test_url().parse().unwrap(),
                body: InvokeBody::Json(json!({"request":request})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.into(),
            },
        )
    };
    let request = PluginRepositoryRefreshRequest {
        ticket: selection.ticket,
        expected_revision: 0.into(),
        action_id: ExecutionId::new(),
    };
    let mut forged = serde_json::to_value(&request).unwrap();
    forged["trustedRoot"] = json!({});
    assert!(call("refresh_plugin_repository", forged).is_err());
    let verified = call(
        "refresh_plugin_repository",
        serde_json::to_value(&request).unwrap(),
    )
    .unwrap()
    .deserialize::<PluginRepositoryVerifiedView>()
    .unwrap();
    let install = Fixture::install_request(&verified, 0);
    let mut forged = serde_json::to_value(&install).unwrap();
    forged["origin"] = json!({"sourceId":"other","publisherId":"other"});
    assert!(call("install_repository_packages", forged).is_err());
    let installed = call(
        "install_repository_packages",
        serde_json::to_value(&install).unwrap(),
    )
    .unwrap()
    .deserialize::<PluginInventoryView>()
    .unwrap();
    assert_eq!(
        installed.last_settings_action,
        Some(install.action_id.to_string())
    );
    assert_eq!(installed.packages.len(), 1);
    assert_eq!(installed.packages[0].origin.source_id, selection.source_id);
    assert!(!installed.package_decisions[0].enabled);
    let observed = call("read_plugin_repositories", json!({}))
        .unwrap()
        .deserialize::<PluginRepositorySourcesView>()
        .unwrap();
    assert_eq!(observed.sources[0].action_id, Some(request.action_id));
}
