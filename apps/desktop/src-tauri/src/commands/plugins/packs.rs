//! Manual, per-member decisions for one immutable local Pack snapshot.
use super::packages::{MutationRequest, PickerLease, at_stage, failure, take_picker};
use super::*;
use std::time::Instant;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tsumugi_core::execution::ExecutionId;
use tsumugi_plugin_host::{
    CapturedOfflinePack,
    catalog::{PackageApproval, PackageCatalog, RegisteredPackage},
};

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginPackMemberView {
    pub manifest: sdk::PluginManifest,
    pub package_digest: String,
    pub file_count: u32,
    pub byte_count: UnsignedDecimal,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginPackCandidateView {
    pub ticket: ExecutionId,
    pub id: String,
    pub display_name: String,
    pub descriptor_digest: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 16)))]
    pub packages: Vec<PluginPackMemberView>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginPackInstallRequest {
    pub ticket: ExecutionId,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 16)))]
    pub members: Vec<PluginPackageRequest>,
    pub expected_revision: UnsignedDecimal,
    pub action_id: ExecutionId,
}

pub(super) struct Candidate {
    ticket: ExecutionId,
    captured: CapturedOfflinePack,
    pub(super) expires: Instant,
}

impl ApplicationPlugins {
    pub(super) fn finish_pack_picker(
        &self,
        picker: ExecutionId,
        directory: Option<PathBuf>,
    ) -> Result<Option<PluginPackCandidateView>, CommandError> {
        let mut manager = self.try_manager()?;
        let cancelled = take_picker(&mut manager, picker)?;
        let Some(directory) = directory else {
            return Ok(None);
        };
        let allowed = || self.open.load(Ordering::Acquire) && !cancelled.load(Ordering::Acquire);
        let captured = CapturedOfflinePack::capture_directory(&directory, allowed)
            .map_err(|error| at_stage(error.into(), CommandStage::Read))?;
        let view = PluginPackCandidateView {
            ticket: picker,
            id: captured.descriptor().id.clone(),
            display_name: captured.descriptor().display_name.clone(),
            descriptor_digest: captured.descriptor_digest().into(),
            packages: captured
                .packages()
                .iter()
                .map(|image| {
                    let inspection = image.inspection();
                    PluginPackMemberView {
                        manifest: image.manifest().manifest().clone(),
                        package_digest: inspection.package_digest,
                        file_count: inspection.file_count,
                        byte_count: inspection.byte_count.into(),
                    }
                })
                .collect(),
        };
        if !allowed() {
            return Err(map_store_error(InstallError::AuthorityRevoked));
        }
        manager.candidate = None;
        manager.repository_candidate = None;
        manager.repository_verified = None;
        manager.pack_candidate = Some(Candidate {
            ticket: picker,
            captured,
            expires: Instant::now() + super::packages::CANDIDATE_LIFETIME,
        });
        Ok(Some(view))
    }
}

pub(super) fn capture_offer(
    manager: &PluginManager,
    request: &PluginPackInstallRequest,
) -> Result<Vec<RegisteredPackage>, CommandError> {
    let invalid = || {
        failure(
            CommandErrorCode::InvalidInput,
            "plugin-pack-selection",
            CommandStage::PluginInstall,
        )
    };
    if request.members.is_empty() || request.members.len() > tsumugi_plugin_host::MAX_PACK_MEMBERS {
        return Err(invalid());
    }
    let candidate = manager
        .pack_candidate
        .as_ref()
        .filter(|c| c.ticket == request.ticket && Instant::now() < c.expires)
        .ok_or_else(|| {
            failure(
                CommandErrorCode::DependencyConflict,
                "plugin-selection-expired",
                CommandStage::PluginInstall,
            )
        })?;
    let mut catalog = PackageCatalog::new();
    let mut packages = Vec::new();
    for member in &request.members {
        let image = candidate
            .captured
            .packages()
            .iter()
            .find(|image| {
                image.manifest().manifest().plugin == member.plugin
                    && image.package_digest() == member.package_digest
            })
            .ok_or_else(invalid)?;
        let approval = PackageApproval {
            plugin: member.plugin.clone(),
            package_digest: member.package_digest.clone(),
            origin: super::packages::manual_origin(),
        };
        catalog
            .register(image.clone(), approval)
            .map_err(super::packages::catalog_error)?;
        packages.push(
            catalog
                .registered(&member.plugin)
                .map_err(super::packages::catalog_error)?
                .clone(),
        );
    }
    Ok(packages)
}

#[tauri::command]
pub async fn select_plugin_pack<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: PluginInventoryRequest,
) -> Result<Option<PluginPackCandidateView>, CommandError> {
    let PluginInventoryRequest {} = request;
    let plugins = state.plugins.clone();
    let picker: PickerLease = plugins.begin_picker()?;
    let selected = state
        .dialogs
        .run(CommandStage::Read, move || {
            Ok(app.dialog().file().blocking_pick_folder())
        })
        .await;
    state
        .io
        .run(CommandStage::Read, move || match selected {
            Ok(selected) => plugins.finish_pack_picker(
                picker.id,
                selected
                    .map(|p| p.into_path())
                    .transpose()
                    .map_err(|_| map_store_error(InstallError::InvalidRoot))?,
            ),
            Err(error) => {
                plugins.finish_pack_picker(picker.id, None)?;
                Err(error)
            }
        })
        .await
}

#[tauri::command]
pub async fn install_plugin_pack(
    state: State<'_, AppState>,
    request: PluginPackInstallRequest,
) -> Result<PluginInventoryView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::PluginInstall, move || {
            plugins.mutate(MutationRequest::PackInstall(request))
        })
        .await
}
