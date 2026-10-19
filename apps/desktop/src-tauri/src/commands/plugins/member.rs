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

fn unavailable() -> CommandError {
    let mut error = CommandError::simple(
        CommandErrorCode::DependencyConflict,
        CommandStage::ExecutionRecover,
    );
    error.reason = Some("member-runtime-unavailable".into());
    error
}

impl ApplicationPlugins {
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
    ) -> Result<MemberEnvironment, CommandError> {
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
            let revision: UnsignedDecimal = settings.revision().into();
            if expected_revision.is_some_and(|expected| expected != revision) {
                return Err(unavailable());
            }
            let (runtime, _) =
                runtimes::load_approved_runtime(store, settings, &runtime_digest, allowed)?;
            let artifact = CapturedMemberArtifact::capture_directory(
                &root,
                &MemberArtifactManifest {
                    format: "tsumugi-member-runtime".into(),
                    version: 1,
                    protocol_version: tsumugi_core::ai::member_wire::PROTOCOL,
                    entrypoint: "worker.mjs".into(),
                },
                allowed,
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
