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
    CapturedNativeRuntime, CapturedRuntime, HostError, HostLimits, LaunchOptions, PackageImage,
    ProcessSession, ReceivedResult, RuntimeLauncher, ScopeBinding,
};

#[derive(Clone, Debug)]
pub enum RunnerRuntime {
    JavaScript(CapturedRuntime),
    Native(CapturedNativeRuntime),
}
impl From<CapturedRuntime> for RunnerRuntime {
    fn from(value: CapturedRuntime) -> Self {
        Self::JavaScript(value)
    }
}
impl From<CapturedNativeRuntime> for RunnerRuntime {
    fn from(value: CapturedNativeRuntime) -> Self {
        Self::Native(value)
    }
}
impl RunnerRuntime {
    fn environment(&self) -> sdk::ExecutionEnvironmentDescriptor {
        match self {
            Self::JavaScript(value) => value.descriptor().clone().into(),
            Self::Native(value) => value.descriptor().clone().into(),
        }
    }
    fn launcher(&self) -> RuntimeLauncher {
        match self {
            Self::JavaScript(runtime) => RuntimeLauncher::JavaScript {
                runtime: runtime.clone(),
            },
            Self::Native(runtime) => RuntimeLauncher::NativeCore {
                runtime: runtime.clone(),
            },
        }
    }
}

/// One captured package/contribution selection. Construct this only with the
/// trusted installer's captured image and complete runtime environment.
/// These values establish the selection, not execution permission or publisher
/// authentication. Core supplies a separate live permit for every dispatch.
#[derive(Clone)]
pub struct RunnerProxy {
    image: PackageImage,
    capability: sdk::CapabilityBinding,
    capability_version: String,
    runtime: RunnerRuntime,
    environment: sdk::ExecutionEnvironmentDescriptor,
    staging_parent: PathBuf,
    limits: HostLimits,
}

impl RunnerProxy {
    pub fn new(
        image: PackageImage,
        contribution_id: impl Into<String>,
        runtime: impl Into<RunnerRuntime>,
        staging_parent: impl Into<PathBuf>,
        limits: HostLimits,
    ) -> Result<Self, ExecutionError> {
        let contribution_id = contribution_id.into();
        let staging_parent = staging_parent.into();
        let runtime = runtime.into();
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
        let component = image
            .manifest()
            .manifest()
            .components
            .iter()
            .find(|component| component.id == capability.provider.component_id)
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "plugin-selection"))?;
        if !matches!(
            (&runtime, component.runtime),
            (RunnerRuntime::JavaScript(_), sdk::RuntimeKind::JavaScript)
                | (RunnerRuntime::Native(_), sdk::RuntimeKind::NativeWorker)
        ) {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "plugin-runtime-profile",
            ));
        }
        if let RunnerRuntime::Native(value) = &runtime {
            value.require_current().map_err(|_| {
                ExecutionError::new(ErrorCode::InvalidInput, "plugin-native-environment")
            })?;
        }
        let environment = runtime.environment();
        // Reuse Core's binding validation for the captured environment. A
        // declared profile is used only for this validation, never as a default
        // selection: execution_binding still requires an explicit profile.
        let checked = PluginExecutionBinding {
            profile: capability.declaration.profiles.first().cloned(),
            capability: capability.clone(),
            environment: environment.clone(),
        };
        checked.validate()?;
        Ok(Self {
            image,
            capability,
            capability_version: checked.capability_version(),
            runtime,
            environment,
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
            environment: self.environment.clone(),
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
        let live_request = request.clone();
        let live_permit = permit.clone();
        let live_cancellation = cancellation.clone();
        let mut session = ProcessSession::launch(
            &self.image,
            &self.capability.provider.contribution_id,
            &self.staging_parent,
            &self.runtime.launcher(),
            options,
            move || is_live(&live_request, &live_permit, &live_cancellation),
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
        // Clamp the complete result-frame allowance to this Host's policy.
        // The captured declaration separately bounds unescaped payload bytes;
        // comparing that raw limit to this frame allowance would mix budgets.
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
    fn plugin_environment(&self) -> Option<&sdk::ExecutionEnvironmentDescriptor> {
        Some(&self.environment)
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
        HostError::RuntimeMismatch => (ErrorCode::ResultMismatch, "plugin-runtime-binding"),
        HostError::PackageChanged => (ErrorCode::DependencyConflict, "plugin-package-changed"),
        HostError::CaptureFailed => (ErrorCode::StorageFailed, "plugin-package-capture"),
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
