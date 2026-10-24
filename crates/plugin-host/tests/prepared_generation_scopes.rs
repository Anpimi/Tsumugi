use tsumugi_plugin_host::{HostError, ScopeBinding, select_declared_services};
use tsumugi_plugin_sdk::*;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}

fn declarations(
    scope: ComponentScope,
) -> (
    ComponentDeclaration,
    CapabilityDeclaration,
    ScopeBinding,
    Vec<ServiceBinding>,
) {
    let generation = generation_service_contract();
    let query = contract("example.query");
    let component = ComponentDeclaration {
        id: "generation".into(),
        scope,
        runtime: RuntimeKind::JavaScript,
        entrypoint: Some("component.mjs".into()),
        dependencies: vec![
            CapabilityDependency {
                contract: generation.clone(),
                required: true,
                selection: ProviderSelection::Single,
            },
            CapabilityDependency {
                contract: query.clone(),
                required: true,
                selection: ProviderSelection::Single,
            },
        ],
        exit: ExitRequirements {
            stop_timeout_ms: 300,
            cleanup_timeout_ms: 500,
        },
    };
    let capability = CapabilityDeclaration {
        contract: contract("example.generator"),
        input_schema: generation_component_input_contract(),
        output_schema: generation_service_receipt_contract(),
        error_schema: generation_service_error_contract(),
        profiles: vec![],
        effect: EffectKind::External,
        permissions: vec![
            PermissionRequest::ProjectService {
                contract: generation.clone(),
            },
            PermissionRequest::ProjectService {
                contract: query.clone(),
            },
        ],
        limits: CapabilityLimits {
            timeout_ms: 5000,
            max_input_bytes: 65536,
            max_output_bytes: 1024,
            concurrency: 1,
        },
    };
    let scope = ScopeBinding {
        project_id: "project-a".into(),
        scope_id: if scope == ComponentScope::Attempt {
            "attempt-a"
        } else {
            "project-a"
        }
        .into(),
    };
    let generation = ServiceBinding {
        handle_id: "generation".into(),
        provider_id: "tsumugi.core".into(),
        contract: generation,
        input_schema: generation_service_input_contract(),
        output_schema: generation_service_receipt_contract(),
        error_schema: generation_service_error_contract(),
        effect: EffectKind::External,
        project_id: scope.project_id.clone(),
        scope_id: scope.scope_id.clone(),
        activation_generation: 1,
        configuration_digest: payload_digest("fixed configuration"),
        limits: CapabilityLimits {
            timeout_ms: 5000,
            max_input_bytes: 16384,
            max_output_bytes: 1024,
            concurrency: 1,
        },
    };
    let query = ServiceBinding {
        handle_id: "prepared-query".into(),
        provider_id: "example.selected-query".into(),
        contract: query,
        input_schema: contract("example.query-input"),
        output_schema: contract("example.query-output"),
        error_schema: contract("example.query-error"),
        effect: EffectKind::ReadOnly,
        project_id: scope.project_id.clone(),
        scope_id: scope.scope_id.clone(),
        activation_generation: 1,
        configuration_digest: payload_digest("fixed query input"),
        limits: CapabilityLimits {
            timeout_ms: 1000,
            max_input_bytes: 1024,
            max_output_bytes: 1024,
            concurrency: 1,
        },
    };
    (component, capability, scope, vec![generation, query])
}

#[test]
fn prepared_generation_queries_use_the_exact_project_or_attempt_facade() {
    for scope in [ComponentScope::Project, ComponentScope::Attempt] {
        let (component, capability, principal, bindings) = declarations(scope);
        let selected =
            select_declared_services(&component, &capability, &principal, &bindings).unwrap();
        assert_eq!(selected.len(), 2);
        assert!(selected.contains(&bindings[0]));
        assert!(selected.contains(&bindings[1]));
        for variant in [
            "foreign-project",
            "foreign-attempt",
            "project-alias",
            "undeclared-version",
            "effect",
        ] {
            let mut forged = bindings.clone();
            match variant {
                "foreign-project" => forged[1].project_id = "project-b".into(),
                "foreign-attempt" => forged[1].scope_id = "attempt-b".into(),
                "project-alias" => {
                    forged[1].scope_id = if scope == ComponentScope::Attempt {
                        "project-a"
                    } else {
                        "attempt-a"
                    }
                    .into()
                }
                "undeclared-version" => forged[1].contract.behavior_version += 1,
                _ => forged[1].effect = EffectKind::Proposal,
            }
            let result = select_declared_services(&component, &capability, &principal, &forged);
            if scope == ComponentScope::Attempt || variant != "effect" {
                assert_eq!(
                    result.unwrap_err(),
                    HostError::DependencyUnavailable,
                    "{scope:?}: {variant}"
                );
            } else {
                // Generic Project service policy is unchanged; the trusted
                // prepared-tool broker separately restricts its query effects.
                assert!(result.is_ok());
            }
        }
    }
}

#[test]
fn attempt_wrapper_requires_current_declared_services_without_inventing_missing_providers() {
    let (component, capability, principal, bindings) = declarations(ComponentScope::Attempt);
    for variant in [
        "missing-query",
        "missing-generation",
        "unknown-required",
        "permission",
        "legacy-input",
        "native-caller",
    ] {
        let mut declaration = component.clone();
        let mut capability = capability.clone();
        let mut selected = bindings.clone();
        match variant {
            "missing-query" => {
                selected.pop();
            }
            "missing-generation" => {
                selected.remove(0);
            }
            "unknown-required" => {
                declaration.dependencies.push(CapabilityDependency {
                    contract: contract("example.unavailable"),
                    required: true,
                    selection: ProviderSelection::Single,
                });
                capability
                    .permissions
                    .push(PermissionRequest::ProjectService {
                        contract: contract("example.unavailable"),
                    });
            }
            "permission" => {
                capability.permissions.pop();
            }
            "legacy-input" => capability.input_schema = generation_service_input_contract(),
            _ => declaration.runtime = RuntimeKind::NativeWorker,
        }
        assert_eq!(
            select_declared_services(&declaration, &capability, &principal, &selected).unwrap_err(),
            HostError::DependencyUnavailable,
            "{variant}"
        );
    }
    let mut optional = component.clone();
    optional.dependencies[1].required = false;
    let selected =
        select_declared_services(&optional, &capability, &principal, &bindings[..1]).unwrap();
    assert_eq!(selected, bindings[..1]);
    let mut collect = component;
    collect.dependencies[1].selection = ProviderSelection::CollectIndependent;
    let mut explicit = bindings;
    let mut second = explicit[1].clone();
    second.provider_id = "example.second-query".into();
    second.handle_id = "second-prepared-query".into();
    explicit.push(second);
    let selected = select_declared_services(&collect, &capability, &principal, &explicit).unwrap();
    assert_eq!(selected.len(), 3);
    assert!(explicit.iter().all(|binding| selected.contains(binding)));
}

#[test]
fn legacy_attempt_generation_keeps_only_core_and_generic_project_services_keep_their_contract() {
    let (mut component, mut capability, principal, bindings) =
        declarations(ComponentScope::Attempt);
    capability.input_schema = generation_service_input_contract();
    component.dependencies.pop();
    capability.permissions.pop();
    assert_eq!(
        select_declared_services(&component, &capability, &principal, &bindings[..1]).unwrap(),
        bindings[..1]
    );
    assert_eq!(
        select_declared_services(&component, &capability, &principal, &bindings).unwrap_err(),
        HostError::DependencyUnavailable
    );
    let (component, mut capability, principal, bindings) = declarations(ComponentScope::Project);
    capability.input_schema = generation_service_input_contract();
    assert_eq!(
        select_declared_services(&component, &capability, &principal, &bindings)
            .unwrap()
            .len(),
        2
    );
}
