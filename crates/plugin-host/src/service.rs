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

/// Attempt generation callers use an explicit SDK input contract. Only the
/// component wrapper can declare additional query dependencies; declarations
/// neither make missing providers available nor authorize their execution.
pub(crate) fn supports_attempt_services(
    component: &ComponentDeclaration,
    capability: &CapabilityDeclaration,
) -> bool {
    let contract = generation_service_contract();
    if component.runtime != RuntimeKind::JavaScript
        || capability.effect != EffectKind::External
        || capability.output_schema != generation_service_receipt_contract()
        || capability.error_schema != generation_service_error_contract()
        || !capability
            .permissions
            .contains(&PermissionRequest::ProjectService {
                contract: contract.clone(),
            })
    {
        return false;
    }
    if capability.input_schema == generation_service_input_contract() {
        return component
            .dependencies
            .iter()
            .filter(|dependency| dependency.required)
            .all(|dependency| {
                dependency.contract == contract && dependency.selection == ProviderSelection::Single
            });
    }
    capability.input_schema == generation_component_input_contract()
        && component.dependencies.iter().any(|dependency| {
            dependency.contract == contract
                && dependency.required
                && dependency.selection == ProviderSelection::Single
        })
        && component
            .dependencies
            .iter()
            .filter(|dependency| dependency.required)
            .all(|dependency| {
                if dependency.contract == contract {
                    dependency.selection == ProviderSelection::Single
                } else {
                    capability
                        .permissions
                        .contains(&PermissionRequest::ProjectService {
                            contract: dependency.contract.clone(),
                        })
                }
            })
}

pub(crate) fn select_service_bindings(
    component: &ComponentDeclaration,
    capability: &CapabilityDeclaration,
    scope: &ScopeBinding,
    broker: Option<&dyn ProjectServiceBroker>,
) -> HostResult<Vec<ServiceBinding>> {
    let bindings = broker.map_or(&[][..], |broker| broker.bindings());
    let captured = select_declared_services(component, capability, scope, bindings)?;
    if captured.iter().any(|binding| {
        !broker
            .expect("an offered binding has a broker")
            .is_current(binding)
    }) {
        return Err(HostError::AuthorityRevoked);
    }
    Ok(captured)
}

/// Pure declaration compatibility for a trusted preparation preview. This does
/// not authenticate its arguments or establish provider availability, approval,
/// currentness or execution permission. Process launch reuses this predicate
/// with its captured package and independently checks the actual live broker.
pub fn select_declared_services(
    component: &ComponentDeclaration,
    capability: &CapabilityDeclaration,
    scope: &ScopeBinding,
    bindings: &[ServiceBinding],
) -> HostResult<Vec<ServiceBinding>> {
    // Additional Attempt services belong only to the explicit component wrapper
    // and remain read-only. Every facade uses the caller's exact dispatch scope;
    // the broker independently retains each callee's execution binding.
    if component.scope == ComponentScope::Attempt
        && (!bindings.is_empty()
            || component
                .dependencies
                .iter()
                .any(|dependency| dependency.required))
        && (!supports_attempt_services(component, capability)
            || bindings.iter().any(|binding| {
                if binding.contract == generation_service_contract() {
                    validate_generation_service_binding(binding).is_err()
                } else {
                    capability.input_schema != generation_component_input_contract()
                        || binding.effect != EffectKind::ReadOnly
                }
            }))
    {
        return Err(HostError::DependencyUnavailable);
    }
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
