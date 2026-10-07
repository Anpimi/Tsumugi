//! Installed checker snapshots share the original package/runtime authority.
//! A preview and a reopened runner never confer execution permission.
use super::*;
use crate::commands::plugins::{
    ApplicationPlugins,
    reviews::{
        PluginReviewView, PluginTextReviewSelection, PluginTextReviewView, ReviewEnvironment,
        TextReviewEnvironment,
    },
};
use tsumugi_core::content::SourceReviewBinding;
use tsumugi_core::{AdvisoryReviewCheck, ReviewChecker, ReviewCheckerKey, ReviewCheckerKind};
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum ReviewCheckerView {
    Format { plugin: PluginReviewView },
    AdvisoryText { plugin: PluginTextReviewView },
}

#[derive(Clone)]
pub(in crate::commands::execution) enum CheckerEnvironment {
    Format {
        binding: SourceReviewBinding,
        environment: ReviewEnvironment,
    },
    AdvisoryText {
        binding: AdvisoryReviewCheck,
        environment: TextReviewEnvironment,
    },
}

impl CheckerEnvironment {
    pub(in crate::commands::execution) fn capture(
        plugins: &ApplicationPlugins,
        checker: &ReviewChecker,
        source: &SourceReviewBinding,
        advisory: &[AdvisoryReviewCheck],
    ) -> Result<Self, CommandError> {
        let captured = match checker.kind {
            ReviewCheckerKind::Format => Self::Format {
                binding: source.clone(),
                environment: plugins.capture_review(source)?,
            },
            ReviewCheckerKind::AdvisoryText => {
                let binding = advisory
                    .iter()
                    .find(|selection| {
                        selection.binding.checker.provider == checker.key.provider
                            && selection.binding.declaration.profile == checker.key.profile
                    })
                    .ok_or_else(stale)?;
                Self::AdvisoryText {
                    binding: binding.clone(),
                    environment: plugins.capture_captured_text_review(binding)?,
                }
            }
        };
        if captured.binding()? != checker.binding {
            return Err(stale());
        }
        Ok(captured)
    }

    pub(in crate::commands::execution) fn binding(
        &self,
    ) -> Result<tsumugi_core::execution::PluginExecutionBinding, CommandError> {
        match self {
            Self::Format { binding, .. } => Ok(binding.checker.clone()),
            Self::AdvisoryText { binding, .. } => {
                Ok(tsumugi_core::execution::PluginExecutionBinding {
                    capability: binding.binding.checker.clone(),
                    profile: Some(binding.binding.declaration.profile.clone()),
                    environment: binding.environment.clone(),
                })
            }
        }
    }

    pub(in crate::commands::execution) fn key(&self) -> Result<ReviewCheckerKey, CommandError> {
        let binding = self.binding()?;
        Ok(ReviewCheckerKey {
            provider: binding.capability.provider,
            profile: binding.profile.ok_or_else(stale)?,
        })
    }

    pub(in crate::commands::execution) fn view(&self) -> Result<ReviewCheckerView, CommandError> {
        match self {
            Self::Format { environment, .. } => Ok(ReviewCheckerView::Format {
                plugin: environment.view()?,
            }),
            Self::AdvisoryText { environment, .. } => Ok(ReviewCheckerView::AdvisoryText {
                plugin: environment.view()?,
            }),
        }
    }

    pub(in crate::commands::execution) fn settings_revision(&self) -> UnsignedDecimal {
        match self {
            Self::Format { environment, .. } => environment.settings_revision,
            Self::AdvisoryText { environment, .. } => environment.captured.settings_revision,
        }
    }

    pub(in crate::commands::execution) fn reopen(
        &self,
        plugins: &ApplicationPlugins,
    ) -> Result<Self, CommandError> {
        let current = match self {
            Self::Format { binding, .. } => Self::Format {
                binding: binding.clone(),
                environment: plugins.capture_review(binding)?,
            },
            Self::AdvisoryText { binding, .. } => Self::AdvisoryText {
                binding: binding.clone(),
                environment: plugins.capture_captured_text_review(binding)?,
            },
        };
        if current.settings_revision() != self.settings_revision()
            || current.binding()? != self.binding()?
        {
            return Err(stale());
        }
        Ok(current)
    }

    pub(in crate::commands::execution) fn runner(self) -> Result<Arc<RunnerProxy>, CommandError> {
        let (package, checker, runtime, staging) = match self {
            Self::Format { environment, .. } => (
                environment.package,
                environment.binding.declaration.checker,
                environment.runtime,
                environment.staging_parent,
            ),
            Self::AdvisoryText { environment, .. } => (
                environment.captured.package,
                environment.captured.binding.declaration.checker,
                environment.captured.runtime,
                environment.captured.staging_parent,
            ),
        };
        RunnerProxy::new(
            package.image().clone(),
            &checker,
            runtime,
            staging,
            HostLimits::default(),
        )
        .map(Arc::new)
        .map_err(map_adopt)
    }
}

pub(in crate::commands::execution) fn capture_advisory(
    plugins: &ApplicationPlugins,
    selections: &[PluginTextReviewSelection],
) -> Result<Vec<AdvisoryReviewCheck>, CommandError> {
    if selections.len() > tsumugi_plugin_sdk::MAX_REVIEW_RULES {
        return Err(map_adopt(ExecutionError::new(
            ErrorCode::LimitExceeded,
            "review-checkers",
        )));
    }
    selections
        .iter()
        .map(|selection| plugins.capture_text_review(selection)?.advisory_check())
        .collect()
}

pub(in crate::commands::execution) fn stale() -> CommandError {
    map_adopt(ExecutionError::new(
        ErrorCode::DependencyConflict,
        "review-check-preflight",
    ))
}
