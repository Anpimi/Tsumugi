use crate::{ChannelReceipt, HostError, HostResult, ScopeBinding};
use std::{future::Future, pin::Pin};
use tsumugi_plugin_sdk::*;

/// Actual Host channel and the original outer invocation. A worker cannot
/// construct this principal or replace its package, instance, scope or input
/// identity by claiming another context in a service frame.
#[derive(Clone, Debug)]
pub struct ServiceCaller {
    channel: ChannelReceipt,
    invocation: InvocationRequest,
    deadline: std::time::Instant,
}
impl ServiceCaller {
    pub(crate) fn capture(
        channel: ChannelReceipt,
        invocation: &InvocationRequest,
        deadline: std::time::Instant,
    ) -> Self {
        Self {
            channel,
            invocation: invocation.clone(),
            deadline,
        }
    }
    pub fn channel(&self) -> &ChannelReceipt {
        &self.channel
    }
    pub fn invocation(&self) -> &InvocationRequest {
        &self.invocation
    }
    pub fn context(&self) -> &InvocationContext {
        &self.invocation.context
    }
    /// The original outer invocation deadline, fixed before its first frame.
    /// Enqueued work must retain this bound rather than start a new timeout.
    pub fn deadline(&self) -> std::time::Instant {
        self.deadline
    }
}

pub type ProjectServiceFuture<'a> =
    Pin<Box<dyn Future<Output = HostResult<ServiceResponse>> + Send + 'a>>;

/// Trusted, explicitly selected project-service transport. Offered descriptors
/// are captured before launch; availability and authority must remain current.
/// The callback must finish a bounded query or short enqueue/receipt operation,
/// never wait for model completion while occupying the component invocation.
/// Descriptor/currentness access and future construction must be nonblocking
/// and bounded so that the Host can keep polling its authority and deadline.
/// Implementations validate their own payload semantics and mutation authority;
/// no Core context, project store, database or privileged object crosses to the
/// child. This transport creates no production AI adapter or execution grant.
pub trait ProjectServiceBroker: Send + Sync {
    fn bindings(&self) -> &[ServiceBinding];
    fn is_current(&self, binding: &ServiceBinding) -> bool;
    fn call<'a>(
        &'a self,
        caller: ServiceCaller,
        binding: ServiceBinding,
        request: ServiceRequest,
    ) -> ProjectServiceFuture<'a>;

    /// Release this process channel's registrations once on close, fault or
    /// drop. This synchronous cleanup must be bounded. A durable child operation
    /// must retain its original caller/authority association until its own AI
    /// terminal state; channel closure is not rollback or adoption revocation.
    fn release_channel(&self, channel: &ChannelReceipt);
}

pub(crate) fn select_service_bindings(
    component: &ComponentDeclaration,
    capability: &CapabilityDeclaration,
    scope: &ScopeBinding,
    broker: Option<&dyn ProjectServiceBroker>,
) -> HostResult<Vec<ServiceBinding>> {
    let bindings = broker.map_or(&[][..], |broker| broker.bindings());
    validate_service_bindings(bindings).map_err(|_| HostError::InvalidContract)?;
    for binding in bindings {
        if binding.project_id != scope.project_id
            || binding.scope_id != scope.scope_id
            || !component
                .dependencies
                .iter()
                .any(|dependency| dependency.contract == binding.contract)
            || !capability.permissions.iter().any(|permission| {
                matches!(permission, PermissionRequest::ProjectService { contract }
                    if *contract == binding.contract)
            })
            || matches!(
                (capability.effect, binding.effect),
                (
                    EffectKind::ReadOnly,
                    EffectKind::Proposal | EffectKind::External
                ) | (EffectKind::Proposal, EffectKind::External)
            )
        {
            return Err(HostError::DependencyUnavailable);
        }
        if !broker
            .expect("an offered binding has a broker")
            .is_current(binding)
        {
            return Err(HostError::AuthorityRevoked);
        }
    }
    for dependency in &component.dependencies {
        let count = bindings
            .iter()
            .filter(|binding| binding.contract == dependency.contract)
            .count();
        if (dependency.required && count == 0)
            || (dependency.selection == ProviderSelection::Single && count > 1)
        {
            return Err(HostError::DependencyUnavailable);
        }
    }
    // The broker supplies explicit choices. Canonical order preserves separate
    // provider identities; it is not priority or a merge policy.
    let mut captured = bindings.to_vec();
    captured.sort_by(|a, b| {
        (&a.contract, &a.provider_id, &a.handle_id).cmp(&(
            &b.contract,
            &b.provider_id,
            &b.handle_id,
        ))
    });
    Ok(captured)
}
