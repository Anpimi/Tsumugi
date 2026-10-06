//! Local trusted application decisions, independent of installation receipts.
use super::*;
use crate::catalog::PackageApprovalIndex;
use std::collections::BTreeSet;

pub(super) const SETTINGS_VERSION: u32 = 2;
pub(super) const MAX_SETTINGS_BYTES: usize = 1024 * 1024;

/// An independently approved exact package version. Enablement only permits
/// new declaration resolution; it is not an attempt grant or activation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedPackageSetting {
    pub approval: PackageApproval,
    pub enabled: bool,
}

/// The trusted application passes a complete desired state after verifying
/// bundled metadata or an explicit human decision. Never construct it from an
/// inventory or receipt alone. No grants, sessions or channel tokens are stored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSettingsUpdate {
    pub packages: Vec<ApprovedPackageSetting>,
    pub runtimes: Vec<RuntimeApproval>,
}

impl PluginSettingsUpdate {
    pub(super) fn normalized(&self) -> InstallResult<Self> {
        if self.packages.len() > MAX_INSTALLED_PACKAGES
            || self.runtimes.len() > MAX_INSTALLED_RUNTIMES
        {
            return Err(InstallError::LimitExceeded);
        }
        let mut index = PackageApprovalIndex::default();
        for package in &self.packages {
            index.insert(&package.approval)?;
        }
        let mut seen = BTreeSet::new();
        let mut runtimes = Vec::new();
        for runtime in &self.runtimes {
            let digest = runtime.validate()?;
            if !seen.insert(digest.clone()) {
                return Err(InstallError::IdentityConflict);
            }
            runtimes.push((digest, runtime.clone()));
        }
        runtimes.sort_by(|a, b| a.0.cmp(&b.0));
        let mut packages = self.packages.clone();
        packages.sort_by(|a, b| a.approval.plugin.cmp(&b.approval.plugin));
        Ok(Self {
            packages,
            runtimes: runtimes.into_iter().map(|(_, approval)| approval).collect(),
        })
    }
}

/// A strict, versioned local decision snapshot. Missing storage is revision 0
/// with empty disabled state. Persisted snapshots have a positive revision and
/// the last settings action UUID. These values do not restore Core grants.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSettings {
    pub(super) format_version: u32,
    pub(super) revision: u64,
    pub(super) action_id: Option<String>,
    pub(super) packages: Vec<ApprovedPackageSetting>,
    pub(super) runtimes: Vec<RuntimeApproval>,
}

impl Default for PluginSettings {
    fn default() -> Self {
        Self {
            format_version: SETTINGS_VERSION,
            revision: 0,
            action_id: None,
            packages: vec![],
            runtimes: vec![],
        }
    }
}

impl PluginSettings {
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn action_id(&self) -> Option<&str> {
        self.action_id.as_deref()
    }
    pub fn packages(&self) -> &[ApprovedPackageSetting] {
        &self.packages
    }
    pub fn runtimes(&self) -> &[RuntimeApproval] {
        &self.runtimes
    }

    pub(super) fn next(
        expected_revision: u64,
        action: &str,
        update: &PluginSettingsUpdate,
    ) -> InstallResult<Self> {
        validate_action(action)?;
        let revision = expected_revision
            .checked_add(1)
            .ok_or(InstallError::LimitExceeded)?;
        let normalized = update.normalized()?;
        Ok(Self {
            format_version: SETTINGS_VERSION,
            revision,
            action_id: Some(action.into()),
            packages: normalized.packages,
            runtimes: normalized.runtimes,
        })
    }

    pub(super) fn validate_persisted(&self) -> InstallResult<()> {
        if self.format_version != SETTINGS_VERSION
            || self.revision == 0
            || self
                .action_id
                .as_deref()
                .is_none_or(|action| validate_action(action).is_err())
        {
            return Err(InstallError::CorruptSettings);
        }
        let update = PluginSettingsUpdate {
            packages: self.packages.clone(),
            runtimes: self.runtimes.clone(),
        };
        let normalized = update
            .normalized()
            .map_err(|_| InstallError::CorruptSettings)?;
        if normalized != update {
            return Err(InstallError::CorruptSettings);
        }
        Ok(())
    }
}
