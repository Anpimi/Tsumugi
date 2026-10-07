//! Discover immutable advisory declarations and capture an explicit rule subset.
//! Neither inspection nor capture executes a component or grants permission.
use super::*;
use std::collections::BTreeSet;
use tsumugi_core::AdvisoryReviewCheck;
use tsumugi_plugin_host::catalog::PackageApproval;

// Bound the projection across the already bounded installed package catalog.
// Overflow rejects the observation rather than hiding remaining choices.
const MAX_TEXT_REVIEW_CHOICES: usize = 1024;

enum ObservedTextReview {
    Request(PluginTextReviewRequest),
    Unavailable(PluginTextReviewListEntry),
}

#[derive(Clone)]
pub(in crate::commands) struct TextReviewEnvironment {
    pub captured: DeclaredEnvironment<sdk::TextReviewBinding>,
    pub resource_pins: Vec<sdk::TextReviewResourcePin>,
    pub rules: Vec<sdk::ContractRef>,
}

impl TextReviewEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginTextReviewView, CommandError> {
        let environment = self.captured.runtime.environment();
        Ok(PluginTextReviewView {
            settings_revision: self.captured.settings_revision,
            resource_id: self.captured.resource_id.clone().ok_or_else(invalid)?,
            binding: self.captured.binding.clone(),
            resource_pins: self.resource_pins.clone(),
            rules: self.rules.clone(),
            package_origin: self.captured.package.origin().into(),
            environment_digest: environment.digest().map_err(|_| invalid())?,
            environment,
            runtime_origin: (&self.captured.runtime_origin).into(),
        })
    }

    pub(in crate::commands) fn advisory_check(&self) -> Result<AdvisoryReviewCheck, CommandError> {
        AdvisoryReviewCheck::capture(
            &self.captured.binding,
            &self.captured.runtime.environment(),
            self.captured.resource_id.as_deref().ok_or_else(invalid)?,
            self.resource_pins.clone(),
            self.rules.clone(),
        )
        .map_err(|_| invalid())
    }
}

impl ApplicationPlugins {
    fn capture_text_review_request(
        &self,
        request: &PluginTextReviewRequest,
    ) -> Result<TextReviewEnvironment, CommandError> {
        let captured = self.capture_declared_environment(
            &request.package,
            &request.resource_id,
            &request.environment_digest,
            |image, resource| {
                let binding = image.text_review_declaration(resource)?;
                let providers = [binding.checker.clone()];
                Ok((binding, providers))
            },
        )?;
        let resource_pins = captured
            .package
            .image()
            .text_review_resource_pins(&request.resource_id)
            .map_err(|error| map_store_error(InstallError::Host(error)))?;
        // Discovery describes every available rule. Only capture_text_review
        // accepts an execution choice, and its caller must provide the subset.
        let rules = captured
            .binding
            .declaration
            .rules
            .iter()
            .map(|r| r.rule.clone())
            .collect();
        Ok(TextReviewEnvironment {
            captured,
            resource_pins,
            rules,
        })
    }

    pub(in crate::commands) fn capture_text_review(
        &self,
        selection: &PluginTextReviewSelection,
    ) -> Result<TextReviewEnvironment, CommandError> {
        if selection.rules.is_empty()
            || selection.rules.len() > sdk::MAX_REVIEW_RULES
            || selection.rules.iter().collect::<BTreeSet<_>>().len() != selection.rules.len()
        {
            return Err(invalid());
        }
        let mut environment = self.capture_text_review_request(&PluginTextReviewRequest {
            package: selection.package.clone(),
            resource_id: selection.resource_id.clone(),
            environment_digest: selection.environment_digest.clone(),
        })?;
        if selection
            .rules
            .iter()
            .any(|rule| !environment.rules.contains(rule))
        {
            return Err(invalid());
        }
        environment.rules = selection.rules.clone();
        environment.advisory_check()?;
        Ok(environment)
    }

    /// Reopen the exact selector and immutable evidence captured for this action.
    /// Saved metadata cannot supply current approvals or resource-byte proof.
    pub(in crate::commands) fn capture_captured_text_review(
        &self,
        captured: &AdvisoryReviewCheck,
    ) -> Result<TextReviewEnvironment, CommandError> {
        captured.validate().map_err(|_| invalid())?;
        let provider = &captured.binding.checker.provider;
        let actual = self.capture_text_review(&PluginTextReviewSelection {
            package: PluginPackageRequest {
                plugin: provider.plugin.clone(),
                package_digest: provider.package_digest.clone(),
            },
            resource_id: captured.declaration_resource_id.clone(),
            environment_digest: captured.environment.digest().map_err(|_| invalid())?,
            rules: captured.rules.clone(),
        })?;
        if actual.captured.binding != captured.binding
            || actual.captured.runtime.environment() != captured.environment
            || actual.resource_pins != captured.resource_pins
        {
            return Err(invalid());
        }
        Ok(actual)
    }

    fn text_review_list(&self) -> Result<PluginTextReviewListView, CommandError> {
        // Reuse installed inventory and its actual runtime offers. This does
        // not scan arbitrary directories or infer a runtime from a package name.
        let inventory = self.inventory()?;
        let environments = observed_environments(&inventory);
        let observations = self.read_installed_snapshot(|store, settings, _, allowed| {
            if settings.revision() != inventory.settings_revision.get() {
                return Err(map_store_error(InstallError::RevisionConflict));
            }
            let mut entries = Vec::new();
            for package in &inventory.packages {
                // The Store's sealed receipt supplies inspection identity, not
                // approval. Actual capture independently requires enabled settings.
                let installed = store.load(&PackageApproval {
                    plugin: package.plugin.clone(),
                    package_digest: package.package_digest.clone(),
                    origin: PackageOrigin {
                        source_id: package.origin.source_id.clone(),
                        publisher_id: package.origin.publisher_id.clone(),
                    },
                }, allowed).map_err(map_store_error)?;
                let image = installed.image();
                let manifest = image.manifest().manifest();
                for resource in &manifest.contributions {
                    if !matches!(&resource.contribution, sdk::ContributionKind::Resource { schema, .. }
                        if schema.id == sdk::text_review_declaration_contract().id)
                    {
                        continue;
                    }
                    let request_package = PluginPackageRequest {
                        plugin: package.plugin.clone(),
                        package_digest: package.package_digest.clone(),
                    };
                    let runtime = image.text_review_declaration(&resource.id)
                        .map_err(|error| map_store_error(InstallError::Host(error)))
                        .and_then(|binding| manifest.components.iter()
                            .find(|component| component.id == binding.checker.provider.component_id)
                            .map(|component| component.runtime)
                            .ok_or_else(invalid));
                    match runtime {
                        Err(error) => push_observation(&mut entries, ObservedTextReview::Unavailable(PluginTextReviewListEntry {
                            package: request_package, resource_id: resource.id.clone(),
                            environment_digest: None,
                            availability: PluginTextReviewAvailability::Unavailable { error },
                        }))?,
                        Ok(kind) => {
                            let candidates: Vec<_> = environments.iter()
                                .filter(|environment| matches!((kind, environment),
                                    (sdk::RuntimeKind::JavaScript, sdk::ExecutionEnvironmentDescriptor::Captured(_))
                                    | (sdk::RuntimeKind::NativeWorker, sdk::ExecutionEnvironmentDescriptor::Native(_))))
                                .collect();
                            if candidates.is_empty() {
                                push_observation(&mut entries, ObservedTextReview::Unavailable(PluginTextReviewListEntry {
                                    package: request_package, resource_id: resource.id.clone(),
                                    environment_digest: None,
                                    availability: PluginTextReviewAvailability::Unavailable {
                                        error: map_store_error(InstallError::MissingRuntime),
                                    },
                                }))?;
                            } else {
                                for environment in candidates {
                                    push_observation(&mut entries, ObservedTextReview::Request(PluginTextReviewRequest {
                                        package: request_package.clone(), resource_id: resource.id.clone(),
                                        environment_digest: environment.digest().map_err(|_| invalid())?,
                                    }))?;
                                }
                            }
                        }
                    }
                }
            }
            Ok(entries)
        })?;
        let mut entries = Vec::with_capacity(observations.len());
        for observation in observations {
            match observation {
                ObservedTextReview::Unavailable(entry) => entries.push(entry),
                ObservedTextReview::Request(request) => {
                    let availability = match self
                        .capture_text_review_request(&request)
                        .and_then(|environment| environment.view())
                    {
                        Ok(view) if view.settings_revision == inventory.settings_revision => {
                            PluginTextReviewAvailability::Ready { view }
                        }
                        Ok(_) => return Err(map_store_error(InstallError::RevisionConflict)),
                        Err(error) => PluginTextReviewAvailability::Unavailable { error },
                    };
                    entries.push(PluginTextReviewListEntry {
                        package: request.package,
                        resource_id: request.resource_id,
                        environment_digest: Some(request.environment_digest),
                        availability,
                    });
                }
            }
        }
        if self.environment_settings_revision()? != inventory.settings_revision {
            return Err(map_store_error(InstallError::RevisionConflict));
        }
        Ok(PluginTextReviewListView {
            settings_revision: inventory.settings_revision,
            entries,
        })
    }
}

fn push_observation(
    entries: &mut Vec<ObservedTextReview>,
    entry: ObservedTextReview,
) -> Result<(), CommandError> {
    if entries.len() >= MAX_TEXT_REVIEW_CHOICES {
        return Err(map_store_error(InstallError::LimitExceeded));
    }
    entries.push(entry);
    Ok(())
}

fn observed_environments(
    inventory: &PluginInventoryView,
) -> Vec<sdk::ExecutionEnvironmentDescriptor> {
    let mut values = Vec::new();
    for environment in inventory
        .runtimes
        .iter()
        .map(|r| sdk::ExecutionEnvironmentDescriptor::Captured(r.environment.clone()))
        .chain(
            inventory
                .runtime_decisions
                .iter()
                .map(|r| r.environment.clone()),
        )
        .chain(
            inventory
                .runtime_offers
                .iter()
                .map(|r| sdk::ExecutionEnvironmentDescriptor::Captured(r.environment.clone())),
        )
        .chain(match &inventory.native_host_offer {
            PluginNativeHostOfferView::Available { environment, .. } => Some(
                sdk::ExecutionEnvironmentDescriptor::Native(environment.clone()),
            ),
            PluginNativeHostOfferView::Unavailable { .. } => None,
        })
    {
        if !values.contains(&environment) {
            values.push(environment);
        }
    }
    values
}

#[tauri::command]
pub async fn read_plugin_text_review(
    state: State<'_, AppState>,
    request: PluginTextReviewRequest,
) -> Result<PluginTextReviewView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || {
            plugins.capture_text_review_request(&request)?.view()
        })
        .await
}

#[tauri::command]
pub async fn read_plugin_text_reviews(
    state: State<'_, AppState>,
) -> Result<PluginTextReviewListView, CommandError> {
    let plugins = state.plugins.clone();
    state
        .io
        .run(CommandStage::Read, move || plugins.text_review_list())
        .await
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests;
