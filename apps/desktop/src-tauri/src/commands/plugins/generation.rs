//! Select an ordinary generation component from installed package and runtime
//! decisions. Reading this selection neither invokes it nor grants execution.
use super::environment::{DeclaredEnvironment, invalid};
use super::*;
use tsumugi_plugin_host::PackageImage;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginGenerationComponentRequest {
    pub provider: sdk::ProviderSelectionBinding,
    #[serde(deserialize_with = "Option::deserialize")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(required, schema_with = "generation_profile_schema")
    )]
    pub profile: Option<sdk::ContractRef>,
    pub environment_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginGenerationComponentView {
    pub settings_revision: UnsignedDecimal,
    pub binding: sdk::CapabilityBinding,
    pub component_scope: sdk::ComponentScope,
    #[serde(deserialize_with = "Option::deserialize")]
    #[cfg_attr(
        feature = "wire-schema",
        schemars(required, schema_with = "generation_profile_schema")
    )]
    pub profile: Option<sdk::ContractRef>,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

#[cfg(feature = "wire-schema")]
fn generation_profile_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    generator.subschema_for::<Option<sdk::ContractRef>>()
}

#[derive(Clone)]
pub(in crate::commands) struct GenerationComponentEnvironment {
    pub(in crate::commands) captured: DeclaredEnvironment<sdk::CapabilityBinding>,
    pub(in crate::commands) profile: Option<sdk::ContractRef>,
}

impl GenerationComponentEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginGenerationComponentView, CommandError> {
        let environment = self.captured.runtime.environment();
        Ok(PluginGenerationComponentView {
            settings_revision: self.captured.settings_revision,
            binding: self.captured.binding.clone(),
            component_scope: self
                .captured
                .execution_binding(&self.captured.binding, self.profile.clone())?
                .component_scope,
            profile: self.profile.clone(),
            package_origin: self.captured.package.origin().into(),
            environment_digest: environment.digest().map_err(|_| invalid())?,
            environment,
            runtime_origin: (&self.captured.runtime_origin).into(),
        })
    }
}

fn resolve_generation_component(
    image: &PackageImage,
    provider: &sdk::ProviderSelectionBinding,
    profile: Option<&sdk::ContractRef>,
) -> Result<sdk::CapabilityBinding, HostError> {
    let binding = sdk::bind_capability(
        image.manifest(),
        &provider.contribution_id,
        image.package_digest(),
    )
    .map_err(|_| HostError::InvalidContract)?;
    if binding.provider != *provider {
        return Err(HostError::PackageMismatch);
    }
    image
        .manifest()
        .capability(
            &provider.contribution_id,
            &binding.declaration.contract,
            profile,
        )
        .map_err(|_| HostError::InvalidContract)?;
    let component = image
        .manifest()
        .manifest()
        .components
        .iter()
        .find(|component| component.id == binding.provider.component_id)
        .ok_or(HostError::InvalidContract)?;
    let service = sdk::generation_service_contract();
    if !matches!(
        component.scope,
        sdk::ComponentScope::Project | sdk::ComponentScope::Attempt
    ) || component.runtime != sdk::RuntimeKind::JavaScript
        || !component.dependencies.iter().any(|dependency| {
            dependency.contract == service
                && dependency.required
                && dependency.selection == sdk::ProviderSelection::Single
        })
        || binding.declaration.effect != sdk::EffectKind::External
        || !binding
            .declaration
            .permissions
            .contains(&sdk::PermissionRequest::ProjectService { contract: service })
        || (binding.declaration.input_schema != sdk::generation_service_input_contract()
            && (binding.declaration.input_schema != sdk::generation_component_input_contract()
                || component.scope != sdk::ComponentScope::Project))
        || binding.declaration.output_schema != sdk::generation_service_receipt_contract()
        || binding.declaration.error_schema != sdk::generation_service_error_contract()
    {
        return Err(HostError::InvalidContract);
    }
    Ok(binding)
}

impl ApplicationPlugins {
    pub(in crate::commands) fn capture_generation_component(
        &self,
        request: &PluginGenerationComponentRequest,
    ) -> Result<GenerationComponentEnvironment, CommandError> {
        request.provider.validate().map_err(|_| invalid())?;
        let package = PluginPackageRequest {
            plugin: request.provider.plugin.clone(),
            package_digest: request.provider.package_digest.clone(),
        };
        let captured = self.capture_capability_environment(
            &package,
            None,
            &request.environment_digest,
            &[sdk::ComponentScope::Project, sdk::ComponentScope::Attempt],
            |image| {
                let binding = resolve_generation_component(
                    image,
                    &request.provider,
                    request.profile.as_ref(),
                )?;
                let capabilities = [binding.clone()];
                Ok((binding, capabilities))
            },
        )?;
        Ok(GenerationComponentEnvironment {
            captured,
            profile: request.profile.clone(),
        })
    }
}

#[tauri::command]
pub async fn read_plugin_generation_component(
    state: State<'_, AppState>,
    request: PluginGenerationComponentRequest,
) -> Result<PluginGenerationComponentView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins.capture_generation_component(&request)?.view()
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tsumugi_plugin_host::PackageFile;

    fn contract(id: &str) -> sdk::ContractRef {
        sdk::ContractRef {
            id: id.into(),
            schema_version: 1,
            behavior_version: 1,
        }
    }

    fn manifest() -> sdk::PluginManifest {
        let permissions = vec![
            sdk::PermissionRequest::CapturedInput,
            sdk::PermissionRequest::ProjectService {
                contract: sdk::generation_service_contract(),
            },
        ];
        sdk::PluginManifest {
            protocol_version: sdk::MANIFEST_PROTOCOL,
            plugin: sdk::PluginIdentity {
                publisher: "example".into(),
                id: "generation".into(),
                version: "0.1.0".into(),
            },
            permissions: permissions.clone(),
            components: vec![sdk::ComponentDeclaration {
                id: "generator".into(),
                scope: sdk::ComponentScope::Project,
                runtime: sdk::RuntimeKind::JavaScript,
                entrypoint: Some("component.mjs".into()),
                dependencies: vec![sdk::CapabilityDependency {
                    contract: sdk::generation_service_contract(),
                    required: true,
                    selection: sdk::ProviderSelection::Single,
                }],
                exit: sdk::ExitRequirements {
                    stop_timeout_ms: 300,
                    cleanup_timeout_ms: 500,
                },
            }],
            contributions: vec![sdk::ContributionDeclaration {
                id: "generation.call".into(),
                component_id: "generator".into(),
                contribution: sdk::ContributionKind::Capability {
                    declaration: sdk::CapabilityDeclaration {
                        contract: contract("example.generation"),
                        input_schema: sdk::generation_service_input_contract(),
                        output_schema: sdk::generation_service_receipt_contract(),
                        error_schema: sdk::generation_service_error_contract(),
                        profiles: vec![contract("example.generation-profile")],
                        effect: sdk::EffectKind::External,
                        permissions,
                        limits: sdk::CapabilityLimits {
                            max_input_bytes: sdk::MAX_GENERATION_SERVICE_INPUT_BYTES as u32,
                            max_output_bytes: sdk::MAX_GENERATION_SERVICE_RECEIPT_BYTES as u32,
                            concurrency: 1,
                            timeout_ms: 1_000,
                        },
                    },
                },
            }],
        }
    }

    fn declaration(manifest: &mut sdk::PluginManifest) -> &mut sdk::CapabilityDeclaration {
        let sdk::ContributionKind::Capability { declaration } =
            &mut manifest.contributions[0].contribution
        else {
            panic!("expected capability fixture")
        };
        declaration
    }

    fn image(manifest: &sdk::PluginManifest) -> PackageImage {
        let files = BTreeMap::from([(
            "component.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('metadata inspection must not execute');".to_vec(),
                executable: manifest.components[0].runtime == sdk::RuntimeKind::NativeWorker,
            },
        )]);
        let bytes = serde_json::to_vec(manifest).unwrap();
        let digest = PackageImage::digest(&bytes, &files).unwrap();
        PackageImage::capture(bytes, files, &digest).unwrap()
    }

    fn selection_request(image: &PackageImage) -> PluginGenerationComponentRequest {
        PluginGenerationComponentRequest {
            provider: sdk::bind_capability(
                image.manifest(),
                "generation.call",
                image.package_digest(),
            )
            .unwrap()
            .provider,
            profile: Some(contract("example.generation-profile")),
            environment_digest: "b".repeat(64),
        }
    }

    #[test]
    fn generation_selection_requires_every_actual_provider_identity() {
        let image = image(&manifest());
        let request = selection_request(&image);
        let actual =
            resolve_generation_component(&image, &request.provider, request.profile.as_ref())
                .unwrap();
        assert_eq!(actual.provider, request.provider);
        for scenario in 0..6 {
            let mut provider = request.provider.clone();
            match scenario {
                0 => provider.plugin.publisher = "different".into(),
                1 => provider.plugin.id = "different".into(),
                2 => provider.plugin.version = "0.2.0".into(),
                3 => provider.component_id = "different".into(),
                4 => provider.contribution_id = "different".into(),
                5 => provider.package_digest = "c".repeat(64),
                _ => unreachable!(),
            }
            provider.validate().unwrap();
            assert!(
                resolve_generation_component(&image, &provider, request.profile.as_ref()).is_err(),
                "provider identity scenario {scenario}"
            );
        }
    }

    #[test]
    fn generation_selection_uses_exact_explicit_sdk_profiles() {
        let mut manifest = manifest();
        let captured = image(&manifest);
        let request = selection_request(&captured);
        assert!(resolve_generation_component(&captured, &request.provider, None).is_err());
        for scenario in 0..3 {
            let mut profile = request.profile.clone().unwrap();
            match scenario {
                0 => profile.id = "example.other-profile".into(),
                1 => profile.schema_version += 1,
                2 => profile.behavior_version += 1,
                _ => unreachable!(),
            }
            assert!(
                resolve_generation_component(&captured, &request.provider, Some(&profile)).is_err()
            );
        }
        declaration(&mut manifest).profiles.clear();
        let captured = image(&manifest);
        let request = selection_request(&captured);
        assert!(resolve_generation_component(&captured, &request.provider, None).is_ok());
        assert!(
            resolve_generation_component(&captured, &request.provider, request.profile.as_ref())
                .is_err()
        );
    }

    #[test]
    fn generation_selection_rejects_incompatible_component_service_and_data_contracts() {
        for scenario in 0..16 {
            let mut manifest = manifest();
            match scenario {
                0 => manifest.components[0].scope = sdk::ComponentScope::Application,
                1 => {
                    manifest.components[0].scope = sdk::ComponentScope::Attempt;
                    let image = image(&manifest);
                    let request = selection_request(&image);
                    assert!(
                        resolve_generation_component(
                            &image,
                            &request.provider,
                            request.profile.as_ref()
                        )
                        .is_ok()
                    );
                    continue;
                }
                2 => manifest.components[0].runtime = sdk::RuntimeKind::NativeWorker,
                3 => {
                    manifest.components[0].runtime = sdk::RuntimeKind::Data;
                    manifest.components[0].entrypoint = None;
                    // The SDK rejects a data component before it can become
                    // a validated capability provider for this selector.
                    assert!(manifest.validate().is_err());
                    continue;
                }
                4 => manifest.components[0].dependencies.clear(),
                5 => manifest.components[0].dependencies[0].required = false,
                6 => {
                    manifest.components[0].dependencies[0].selection =
                        sdk::ProviderSelection::CollectIndependent
                }
                7 => {
                    manifest.components[0].dependencies[0]
                        .contract
                        .schema_version += 1
                }
                8 => {
                    manifest.components[0].dependencies[0]
                        .contract
                        .behavior_version += 1
                }
                9 => declaration(&mut manifest).effect = sdk::EffectKind::Proposal,
                10 => declaration(&mut manifest).effect = sdk::EffectKind::ReadOnly,
                11 => {
                    declaration(&mut manifest)
                        .permissions
                        .retain(|permission| *permission == sdk::PermissionRequest::CapturedInput);
                }
                12 => declaration(&mut manifest).input_schema.schema_version += 1,
                13 => declaration(&mut manifest).output_schema.behavior_version += 1,
                14 => declaration(&mut manifest).error_schema.id = "example.other-error".into(),
                15 => {
                    let permission = sdk::PermissionRequest::ProjectService {
                        contract: sdk::ContractRef {
                            behavior_version: 2,
                            ..sdk::generation_service_contract()
                        },
                    };
                    manifest.permissions[1] = permission.clone();
                    declaration(&mut manifest).permissions[1] = permission;
                }
                _ => unreachable!(),
            }
            let image = image(&manifest);
            let request = selection_request(&image);
            assert_eq!(
                resolve_generation_component(&image, &request.provider, request.profile.as_ref()),
                Err(HostError::InvalidContract),
                "declaration scenario {scenario}"
            );
        }
    }

    #[test]
    fn generation_selection_wire_rejects_authorization_and_environment_substitution() {
        let request = selection_request(&image(&manifest()));
        let value = serde_json::to_value(&request).unwrap();
        assert_eq!(
            serde_json::from_value::<PluginGenerationComponentRequest>(value.clone()).unwrap(),
            request
        );
        for field in [
            "approved",
            "budget",
            "model",
            "environment",
            "scope",
            "grant",
        ] {
            let mut forged = value.clone();
            forged[field] = serde_json::json!(true);
            assert!(serde_json::from_value::<PluginGenerationComponentRequest>(forged).is_err());
        }
        let mut unspecified = value;
        unspecified.as_object_mut().unwrap().remove("profile");
        assert!(serde_json::from_value::<PluginGenerationComponentRequest>(unspecified).is_err());
        let mut no_profile = request;
        no_profile.profile = None;
        let value = serde_json::to_value(&no_profile).unwrap();
        assert!(value["profile"].is_null());
        assert_eq!(
            serde_json::from_value::<PluginGenerationComponentRequest>(value).unwrap(),
            no_profile
        );
    }

    #[test]
    fn generation_component_shared_wire_fixture_roundtrips_exact_sdk_binding() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/pluginGenerationComponent.contract.json"
        ))
        .unwrap();
        let request: PluginGenerationComponentRequest =
            serde_json::from_value(fixture["request"].clone()).unwrap();
        let view: PluginGenerationComponentView =
            serde_json::from_value(fixture["view"].clone()).unwrap();
        request.provider.validate().unwrap();
        view.binding.validate().unwrap();
        view.environment.validate().unwrap();
        assert_eq!(view.binding.provider, request.provider);
        assert_eq!(view.profile, request.profile);
        assert_eq!(view.environment_digest, request.environment_digest);
        assert_eq!(
            view.environment.digest().unwrap(),
            request.environment_digest
        );
        assert_eq!(serde_json::to_value(&request).unwrap(), fixture["request"]);
        assert_eq!(serde_json::to_value(&view).unwrap(), fixture["view"]);
        let mut unspecified = fixture["request"].clone();
        unspecified.as_object_mut().unwrap().remove("profile");
        assert!(serde_json::from_value::<PluginGenerationComponentRequest>(unspecified).is_err());
        let mut unspecified = fixture["view"].clone();
        unspecified.as_object_mut().unwrap().remove("profile");
        assert!(serde_json::from_value::<PluginGenerationComponentView>(unspecified).is_err());
        let mut forged = fixture["request"].clone();
        forged["approved"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PluginGenerationComponentRequest>(forged).is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn installed(manifest: &sdk::PluginManifest) -> InstalledFixture {
        let image = image(manifest);
        let approval = tsumugi_plugin_host::catalog::PackageApproval {
            plugin: manifest.plugin.clone(),
            package_digest: image.package_digest().into(),
            origin: PackageOrigin {
                source_id: "manual-local".into(),
                publisher_id: "user-approved".into(),
            },
        };
        InstalledFixture::from_image(
            std::sync::Arc::new(ApplicationPlugins::default()),
            image,
            approval,
        )
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn generation_capture_rejects_invalid_provider_before_installation_io() {
        let directory = tempfile::tempdir().unwrap();
        let owner = ApplicationPlugins::default();
        let root = directory.path().join("application");
        owner.configure(root.clone()).unwrap();
        let mut request = selection_request(&image(&manifest()));
        request.provider.component_id.clear();
        assert_eq!(
            owner
                .capture_generation_component(&request)
                .err()
                .unwrap()
                .code,
            CommandErrorCode::InvalidInput
        );
        assert!(!root.exists());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn installed_generation_capture_requires_independent_runtime_approval() {
        let fixture = installed(&manifest());
        fixture.install();
        fixture.decide(true, vec![]);
        let request = selection_request(&fixture.image);
        let settings = std::fs::read(fixture.root().join("settings.json")).unwrap();
        let error = fixture
            .owner
            .capture_generation_component(&request)
            .err()
            .unwrap();
        assert_eq!(error.code, CommandErrorCode::PermissionDenied);
        assert_eq!(error.reason.as_deref(), Some("plugin-approval-mismatch"));
        assert_eq!(
            std::fs::read(fixture.root().join("settings.json")).unwrap(),
            settings
        );
        let mut unselected = request;
        unselected.profile = None;
        let error = fixture
            .owner
            .capture_generation_component(&unselected)
            .err()
            .unwrap();
        assert_ne!(error.reason.as_deref(), Some("plugin-approval-mismatch"));
    }

    #[cfg(all(
        feature = "execution-test-host",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn installed_generation_capture_is_read_only_and_needs_no_execution_grant() {
        use tsumugi_plugin_host::{CapturedRuntime, RuntimeApproval};
        let fixture = installed(&manifest());
        fixture.install();
        let descriptor: sdk::RuntimeEnvironmentDescriptor = serde_json::from_slice(
            &std::fs::read(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_APPROVAL")
                    .expect("independent runtime descriptor required"),
            )
            .unwrap(),
        )
        .unwrap();
        let runtime = CapturedRuntime::capture_directories(
            &PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_TOOL")
                    .expect("explicit runtime tool required"),
            ),
            &PathBuf::from(
                std::env::var_os("TSUMUGI_TEST_RUNTIME_HOST")
                    .expect("explicit runtime Host required"),
            ),
            &descriptor,
            || true,
        )
        .unwrap();
        let approval = RuntimeApproval {
            environment: descriptor.into(),
            origin: crate::runtime_bundle::bundled_origin(),
        };
        fixture.install_runtime(&runtime, &approval);
        fixture.decide(true, vec![approval.clone()]);
        let mut request = selection_request(&fixture.image);
        request.environment_digest = approval.environment.digest().unwrap();
        let settings = std::fs::read(fixture.root().join("settings.json")).unwrap();
        // No ProjectStore, execution Runtime or grant is constructed for discovery.
        let captured = fixture
            .owner
            .capture_generation_component(&request)
            .unwrap();
        let view = captured.view().unwrap();
        assert_eq!(view.binding.provider, request.provider);
        assert_eq!(view.profile, request.profile);
        assert_eq!(view.binding, captured.captured.binding);
        assert_eq!(view.environment, approval.environment);
        assert_eq!(view.environment_digest, request.environment_digest);
        assert_eq!(view.package_origin, (&fixture.approval.origin).into());
        assert_eq!(view.runtime_origin, (&approval.origin).into());
        assert_eq!(view.settings_revision.get(), 1);
        assert!(captured.captured.resource_id.is_none());
        assert_eq!(
            std::fs::read(fixture.root().join("settings.json")).unwrap(),
            settings
        );
        let mut substituted = request.clone();
        substituted.environment_digest = "c".repeat(64);
        assert!(
            fixture
                .owner
                .capture_generation_component(&substituted)
                .is_err()
        );
        fixture.decide(false, vec![approval]);
        assert!(
            fixture
                .owner
                .capture_generation_component(&request)
                .is_err()
        );
    }
}
