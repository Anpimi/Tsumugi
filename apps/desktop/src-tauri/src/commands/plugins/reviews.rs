//! Reopen the exact checker captured by the adopted source. This uses the
//! installed catalog/runtime owner and does not grant permission to execute.
use super::environment::{DeclaredEnvironment, invalid};
use super::*;
use tsumugi_core::content::SourceReviewBinding;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct PluginReviewView {
    pub settings_revision: UnsignedDecimal,
    pub declaration: sdk::ReviewDeclaration,
    pub checker: sdk::CapabilityBinding,
    pub package_origin: PluginOriginView,
    pub environment: sdk::ExecutionEnvironmentDescriptor,
    pub environment_digest: String,
    pub runtime_origin: PluginOriginView,
}

pub(in crate::commands) type ReviewEnvironment = DeclaredEnvironment<sdk::ReviewBinding>;
impl ReviewEnvironment {
    pub(in crate::commands) fn view(&self) -> Result<PluginReviewView, CommandError> {
        Ok(PluginReviewView {
            settings_revision: self.settings_revision,
            declaration: self.binding.declaration.clone(),
            checker: self.binding.checker.clone(),
            package_origin: self.package.origin().into(),
            environment: self.runtime.descriptor().clone().into(),
            environment_digest: self.runtime.descriptor().digest().map_err(|_| invalid())?,
            runtime_origin: (&self.runtime_origin).into(),
        })
    }
}

impl ApplicationPlugins {
    pub(in crate::commands) fn capture_review(
        &self,
        captured: &SourceReviewBinding,
    ) -> Result<ReviewEnvironment, CommandError> {
        captured.checker.validate().map_err(|_| invalid())?;
        let capability = &captured.checker.capability;
        let environment = self.capture_capability_environment(
            &PluginPackageRequest {
                plugin: capability.provider.plugin.clone(),
                package_digest: capability.provider.package_digest.clone(),
            },
            None,
            &captured
                .checker
                .environment_digest()
                .map_err(|_| invalid())?,
            |image| {
                // The immutable source receipt owns this declaration; bind it
                // against the installed manifest rather than guessing a Resource.
                let binding = captured
                    .declaration
                    .bind(image.manifest(), &capability.provider.package_digest)
                    .map_err(|_| HostError::InvalidContract)?;
                if binding.checker != *capability {
                    return Err(HostError::PackageMismatch);
                }
                Ok((binding.clone(), [binding.checker]))
            },
        )?;
        if captured.checker.profile.as_ref() != Some(&environment.binding.declaration.profile)
            || sdk::ExecutionEnvironmentDescriptor::from(environment.runtime.descriptor().clone())
                != captured.checker.environment
        {
            return Err(invalid());
        }
        Ok(environment)
    }
}
