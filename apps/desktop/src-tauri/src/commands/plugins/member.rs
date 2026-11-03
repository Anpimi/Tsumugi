//! The built-in member uses one already approved Node environment. Capturing
//! application code neither installs a runtime nor grants execution consent.
use super::*;
use tsumugi_plugin_host::{
    CapturedRuntime,
    member::{CapturedMemberArtifact, MemberArtifactManifest},
};

pub(in crate::commands) struct MemberEnvironment {
    pub runtime: CapturedRuntime,
    pub artifact: CapturedMemberArtifact,
    pub staging_parent: PathBuf,
    pub settings_revision: UnsignedDecimal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum MemberArtifactAvailability {
    Available,
    ResourcesUnavailable,
}

fn member_manifest() -> MemberArtifactManifest {
    MemberArtifactManifest {
        format: "tsumugi-member-runtime".into(),
        version: 1,
        protocol_version: tsumugi_core::ai::member_wire::PROTOCOL,
        entrypoint: "worker.mjs".into(),
    }
}

fn unavailable() -> CommandError {
    let mut error = CommandError::simple(
        CommandErrorCode::DependencyConflict,
        CommandStage::ExecutionRecover,
    );
    error.reason = Some("member-runtime-unavailable".into());
    error
}

impl ApplicationPlugins {
    /// Observe application files through the execution capture owner without
    /// loading a runtime, starting a worker, or changing any approval.
    pub(super) fn member_artifact_availability(
        &self,
    ) -> Result<MemberArtifactAvailability, CommandError> {
        let root = self
            .member_resources
            .lock()
            .map_err(|_| unavailable())?
            .clone();
        let present = root.is_some_and(|root| {
            CapturedMemberArtifact::capture_directory(&root, &member_manifest(), || {
                self.open.load(Ordering::Acquire)
            })
            .is_ok()
        });
        Ok(if present {
            MemberArtifactAvailability::Available
        } else {
            MemberArtifactAvailability::ResourcesUnavailable
        })
    }

    pub(in crate::commands) fn configure_member_bundle(
        &self,
        resources: Option<PathBuf>,
    ) -> Result<(), CommandError> {
        let root = resources
            .filter(|path| {
                path.is_absolute()
                    && !path
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir))
            })
            .map(|root| root.join("member-runtime"));
        let mut configured = self.member_resources.lock().map_err(|_| unavailable())?;
        if configured.is_some() {
            return Err(unavailable());
        }
        *configured = root;
        Ok(())
    }

    pub(in crate::commands) fn capture_member_environment(
        &self,
        expected_revision: Option<UnsignedDecimal>,
        authorized: impl Fn() -> bool,
    ) -> Result<MemberEnvironment, CommandError> {
        if !authorized() {
            return Err(CommandError::simple(
                CommandErrorCode::Cancelled,
                CommandStage::ExecutionRecover,
            ));
        }
        // Application assembly chooses one exact default identity. An arbitrary
        // installed approval or a selected domain tool cannot choose Node.
        let runtime_digest = self
            .try_manager()?
            .bundle
            .as_ref()
            .ok_or_else(unavailable)?
            .environment_digest()?;
        let root = self
            .member_resources
            .lock()
            .map_err(|_| unavailable())?
            .clone()
            .ok_or_else(unavailable)?;
        self.read_installed_snapshot(|store, settings, staging_parent, allowed| {
            let capture_allowed = || allowed() && authorized();
            let revision: UnsignedDecimal = settings.revision().into();
            if expected_revision.is_some_and(|expected| expected != revision) {
                return Err(unavailable());
            }
            let (runtime, _) = runtimes::load_approved_runtime(
                store,
                settings,
                &runtime_digest,
                &capture_allowed,
            )?;
            let artifact = CapturedMemberArtifact::capture_directory(
                &root,
                &member_manifest(),
                &capture_allowed,
            )
            .map_err(|_| unavailable())?;
            Ok(MemberEnvironment {
                runtime,
                artifact,
                staging_parent: staging_parent.to_owned(),
                settings_revision: revision,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn member_readiness_checks_real_files_without_installing_or_approving_a_runtime() {
        let temporary = tempfile::tempdir().unwrap();
        let resources = temporary.path().join("resources");
        let artifact = resources.join("member-runtime");
        std::fs::create_dir_all(&artifact).unwrap();
        let owner = ApplicationPlugins::default();
        owner
            .configure(temporary.path().join("application"))
            .unwrap();
        owner.configure_member_bundle(Some(resources)).unwrap();
        let before = owner.inventory().unwrap();
        assert_eq!(
            before.member_artifact_availability,
            MemberArtifactAvailability::ResourcesUnavailable
        );
        std::fs::write(
            artifact.join("manifest.json"),
            serde_json::to_vec(&member_manifest()).unwrap(),
        )
        .unwrap();
        std::fs::write(
            artifact.join("worker.mjs"),
            "throw new Error('readiness must not execute this file');",
        )
        .unwrap();
        let available = owner.inventory().unwrap();
        assert_eq!(
            available.member_artifact_availability,
            MemberArtifactAvailability::Available
        );
        assert_eq!(available.settings_revision, before.settings_revision);
        assert_eq!(available.last_settings_action, before.last_settings_action);
        assert!(available.runtimes.is_empty() && available.runtime_decisions.is_empty());
        let mut wrong = member_manifest();
        wrong.protocol_version += 1;
        std::fs::write(
            artifact.join("manifest.json"),
            serde_json::to_vec(&wrong).unwrap(),
        )
        .unwrap();
        assert_eq!(
            owner.inventory().unwrap().member_artifact_availability,
            MemberArtifactAvailability::ResourcesUnavailable
        );
        std::fs::remove_file(artifact.join("worker.mjs")).unwrap();
        assert_eq!(
            owner.inventory().unwrap().member_artifact_availability,
            MemberArtifactAvailability::ResourcesUnavailable
        );
    }
}
