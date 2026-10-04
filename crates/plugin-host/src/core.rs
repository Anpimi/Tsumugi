//! A trusted adapter from Core's fixed execution port to an owned process
//! channel. Plugins receive SDK data only; they receive no project store,
//! transaction, or authorization renewal handle.

use std::path::PathBuf;

use tsumugi_core::execution::{
    Cancellation, DispatchRequest, ErrorCode, ExecutionError, FixedResult, PluginExecutionBinding,
    PluginPermit, PluginResultEvidence, QueryOutcome, ResultSender, Runner,
};
use tsumugi_plugin_sdk as sdk;

use crate::{
    HostError, HostLimits, LaunchOptions, PackageImage, ProcessSession, ReceivedResult,
    RuntimeLauncher, ScopeBinding,
};

/// One captured package/contribution selection. Construct this only with the
/// trusted installer's captured image, runtime launcher, and environment digest.
/// These values establish the selection, not execution permission or publisher
/// authentication. Core supplies a separate live permit for every dispatch.
#[derive(Clone)]
pub struct RunnerProxy {
    image: PackageImage,
    capability: sdk::CapabilityBinding,
    capability_version: String,
    environment_digest: String,
    launcher: RuntimeLauncher,
    staging_parent: PathBuf,
    limits: HostLimits,
}

impl RunnerProxy {
    pub fn new(
        image: PackageImage,
        contribution_id: impl Into<String>,
        environment_digest: impl Into<String>,
        launcher: RuntimeLauncher,
        staging_parent: impl Into<PathBuf>,
        limits: HostLimits,
    ) -> Result<Self, ExecutionError> {
        let contribution_id = contribution_id.into();
        let environment_digest = environment_digest.into();
        let staging_parent = staging_parent.into();
        if !staging_parent.is_absolute() {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "plugin-staging-parent",
            ));
        }
        // Never accept a caller's claimed provider identity or declaration.
        let capability =
            sdk::bind_capability(image.manifest(), &contribution_id, image.package_digest())
                .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "plugin-selection"))?;
        // Reuse Core's binding validation for the captured environment. A
        // declared profile is used only for this validation, never as a default
        // selection: execution_binding still requires an explicit profile.
        let checked = PluginExecutionBinding {
            profile: capability.declaration.profiles.first().cloned(),
            capability: capability.clone(),
            environment_digest: environment_digest.clone(),
        };
        checked.validate()?;
        Ok(Self {
            image,
            capability,
            capability_version: checked.capability_version(),
            environment_digest,
            launcher,
            staging_parent,
            limits,
        })
    }

    /// Capture this selection for a Core input. A capability with declared
    /// profiles requires a selected profile; an undeclared profile is rejected.
    pub fn execution_binding(
        &self,
        profile: Option<sdk::ContractRef>,
    ) -> Result<PluginExecutionBinding, ExecutionError> {
        let binding = PluginExecutionBinding {
            capability: self.capability.clone(),
            profile,
            environment_digest: self.environment_digest.clone(),
        };
        binding.validate()?;
        Ok(binding)
    }

    fn check_request(&self, request: &DispatchRequest) -> Result<(), ExecutionError> {
        let envelope = request.input.envelope();
        let captured = envelope
            .plugin
            .as_ref()
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "plugin-input"))?;
        let expected = self.execution_binding(captured.profile.clone())?;
        // The whole declaration matters, including schemas, permissions,
        // profiles and limits; provider equality alone is insufficient.
        if *captured != expected
            || envelope.capability_id != self.capability_id()
            || envelope.capability_version != self.capability_version()
            || envelope.automation.is_some()
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "plugin-selection",
            ));
        }
        request.input.item(request.item_id)?;
        Ok(())
    }

    async fn execute(
        &self,
        request: &DispatchRequest,
        permit: &PluginPermit,
        cancellation: &Cancellation,
    ) -> Result<FixedResult, ExecutionError> {
        require_live(request, permit, cancellation)?;
        let project_id = request.input.envelope().project_id.to_string();
        let options = LaunchOptions {
            scope: ScopeBinding {
                project_id: project_id.clone(),
                scope_id: project_id,
            },
            // Only a matching Core permit can reach this call. The durable
            // grant owner checked consent before issuing the read-only handle.
            allow_unsandboxed_execution: true,
            limits: self.limits.clone(),
        };
        let mut session = ProcessSession::launch(
            &self.image,
            &self.capability.provider.contribution_id,
            &self.staging_parent,
            &self.launcher,
            options,
            || is_live(request, permit, cancellation),
        )
        .await
        .map_err(|error| current_error(error, request, permit, cancellation))?;

        // Every path after a successful launch closes the owned session, even
        // if request construction, invocation, or evidence validation fails.
        let outcome = self
            .invoke(&mut session, request, permit, cancellation)
            .await;
        let receipt = session.close().await;
        if !receipt.direct_child_reaped {
            return Err(ExecutionError::new(
                ErrorCode::OutcomeUnknown,
                "plugin-cleanup",
            ));
        }
        let received = outcome?;
        require_live(request, permit, cancellation)?;
        FixedResult::capture_plugin(
            &request.input,
            request.item_id,
            request.dispatch_token,
            PluginResultEvidence {
                authorization_id: permit.grant_id(),
                channel: received.channel().provider.clone(),
                result: received.result().clone(),
            },
        )
    }

    async fn invoke(
        &self,
        session: &mut ProcessSession,
        request: &DispatchRequest,
        permit: &PluginPermit,
        cancellation: &Cancellation,
    ) -> Result<ReceivedResult, ExecutionError> {
        require_live(request, permit, cancellation)?;
        let channel = session.channel();
        let mut invocation = request.input.plugin_request(
            request.item_id,
            request.dispatch_token,
            &channel.provider,
        )?;
        // SDK max_result_bytes bounds the complete encoded result envelope,
        // including payload escaping and metadata. The transport can be narrower
        // than Core's fixed upper bound without rejecting every small result.
        invocation.max_result_bytes = invocation
            .max_result_bytes
            .min(self.limits.max_frame_bytes as u32);
        require_live(request, permit, cancellation)?;
        let received = session
            .invoke(
                &invocation,
                || cancellation.is_requested(),
                || is_live(request, permit, cancellation),
            )
            .await
            .map_err(|error| current_error(error, request, permit, cancellation))?;
        require_live(request, permit, cancellation)?;
        let actual = received.channel();
        // These independent receipt fields are supplied by Host, never copied
        // from the result's claimed identity.
        if actual.provider != channel.provider
            || actual.child_pid != channel.child_pid
            || actual.scope.project_id != invocation.context.project_id
            || actual.scope.scope_id != invocation.context.scope_id
        {
            return Err(ExecutionError::new(
                ErrorCode::ResultMismatch,
                "plugin-channel-binding",
            ));
        }
        Ok(received)
    }
}

impl Runner for RunnerProxy {
    fn capability_id(&self) -> &str {
        &self.capability.declaration.contract.id
    }

    fn capability_version(&self) -> &str {
        &self.capability_version
    }

    fn plugin_provider(&self) -> Option<&sdk::ProviderSelectionBinding> {
        Some(&self.capability.provider)
    }

    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let permit = request.plugin_permit().cloned().ok_or_else(|| {
            ExecutionError::new(ErrorCode::Unauthorized, "plugin-permit").for_item(request.item_id)
        })?;
        self.check_request(&request)
            .map_err(|error| error.for_item(request.item_id))?;
        require_live(&request, &permit, &cancellation)
            .map_err(|error| error.for_item(request.item_id))?;
        // Core invokes Runner on its worker thread. All process IO and child
        // cleanup stay on the runtime owned by this dispatch.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| {
                ExecutionError::new(ErrorCode::StorageFailed, "plugin-runtime")
                    .for_item(request.item_id)
            })?;
        let result = runtime
            .block_on(self.execute(&request, &permit, &cancellation))
            .map_err(|error| error.for_item(request.item_id))?;
        require_live(&request, &permit, &cancellation)
            .map_err(|error| error.for_item(request.item_id))?;
        // Core checks current authority again at durable acceptance. This send
        // does not create an adoption grant or claim that external effects can
        // be rolled back or safely replayed.
        results
            .send(result)
            .map_err(|error| error.for_item(request.item_id))
    }

    fn query(&self, _request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        // A new process cannot authenticate the outcome of an earlier instance.
        Ok(QueryOutcome::Unavailable)
    }
}

fn is_live(request: &DispatchRequest, permit: &PluginPermit, cancellation: &Cancellation) -> bool {
    !cancellation.is_requested() && permit.matches(&request.input) && permit.is_authorized()
}

fn require_live(
    request: &DispatchRequest,
    permit: &PluginPermit,
    cancellation: &Cancellation,
) -> Result<(), ExecutionError> {
    if cancellation.is_requested() {
        return Err(ExecutionError::new(
            ErrorCode::Cancelled,
            "plugin-cancelled",
        ));
    }
    if !permit.matches(&request.input) || !permit.is_authorized() {
        return Err(ExecutionError::new(
            ErrorCode::Unauthorized,
            "plugin-permit",
        ));
    }
    Ok(())
}

fn current_error(
    error: HostError,
    request: &DispatchRequest,
    permit: &PluginPermit,
    cancellation: &Cancellation,
) -> ExecutionError {
    if let Err(error) = require_live(request, permit, cancellation) {
        return error;
    }
    let (code, stage) = match error {
        HostError::InvalidContract => (ErrorCode::InvalidInput, "plugin-contract"),
        HostError::PackageLimit => (ErrorCode::LimitExceeded, "plugin-package-limit"),
        HostError::PackagePath => (ErrorCode::InvalidInput, "plugin-package-path"),
        HostError::PackageMismatch => (ErrorCode::ResultMismatch, "plugin-package-binding"),
        HostError::MissingArtifact => (ErrorCode::DependencyConflict, "plugin-artifact"),
        HostError::StageFailed => (ErrorCode::StorageFailed, "plugin-stage"),
        HostError::ExecutionNotAuthorized | HostError::AuthorityRevoked => {
            (ErrorCode::Unauthorized, "plugin-permit")
        }
        HostError::UnsupportedPlatform => (ErrorCode::DependencyConflict, "plugin-platform"),
        HostError::UnsupportedRuntime => (ErrorCode::DependencyConflict, "plugin-launcher"),
        HostError::DependencyUnavailable => (ErrorCode::DependencyConflict, "plugin-dependency"),
        HostError::InvalidLimits => (ErrorCode::InvalidInput, "plugin-limits"),
        HostError::SpawnFailed => (ErrorCode::StorageFailed, "plugin-spawn"),
        HostError::ChannelFailed => (ErrorCode::OutcomeUnknown, "plugin-channel"),
        HostError::OutputLimit => (ErrorCode::LimitExceeded, "plugin-output-limit"),
        HostError::InvalidFrame => (ErrorCode::ResultMismatch, "plugin-frame"),
        HostError::HandshakeMismatch => (ErrorCode::ResultMismatch, "plugin-handshake"),
        HostError::RequestMismatch => (ErrorCode::ResultMismatch, "plugin-request"),
        HostError::ResultMismatch => (ErrorCode::ResultMismatch, "plugin-result"),
        HostError::UnexpectedFrame => (ErrorCode::ResultMismatch, "plugin-direction"),
        HostError::Timeout => (ErrorCode::OutcomeUnknown, "plugin-timeout"),
        HostError::Cancelled => (ErrorCode::Cancelled, "plugin-cancelled"),
        HostError::Crashed => (ErrorCode::OutcomeUnknown, "plugin-crashed"),
        HostError::Closed => (ErrorCode::OutcomeUnknown, "plugin-closed"),
    };
    ExecutionError::new(code, stage)
}
