//! Local trusted application decisions, independent of installation receipts.
use super::*;
use crate::catalog::PackageApprovalIndex;
use std::collections::BTreeSet;

pub(super) const SETTINGS_VERSION: u32 = 3;
const LEGACY_SETTINGS_VERSION: u32 = 2;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_action_proof: Option<SettingsActionProof>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    known_settings_actions: Vec<String>,
}

/// Opaque, credential-free trusted application input, not execution authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SettingsActionProof {
    request: String,
    complete: bool,
}

impl Default for PluginSettings {
    fn default() -> Self {
        Self {
            format_version: SETTINGS_VERSION,
            revision: 0,
            action_id: None,
            packages: vec![],
            runtimes: vec![],
            last_action_proof: None,
            known_settings_actions: vec![],
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
    pub fn action_request(&self) -> Option<&str> {
        self.last_action_proof.as_ref().map(|proof| proof.request.as_str())
    }
    pub fn action_complete(&self) -> bool {
        self.last_action_proof.as_ref().is_some_and(|proof| proof.complete)
    }
    pub fn knows_action(&self, action: &str) -> bool {
        self.action_id() == Some(action)
            || self.known_settings_actions.binary_search_by(|id| id.as_str().cmp(action)).is_ok()
    }

    pub(super) fn next(
        expected_revision: u64,
        action: &str,
        update: &PluginSettingsUpdate,
    ) -> InstallResult<Self> {
        Self::next_with_proof(expected_revision, action, update, None)
    }

    pub(super) fn next_with_proof(
        expected_revision: u64,
        action: &str,
        update: &PluginSettingsUpdate,
        proof: Option<(&str, bool)>,
    ) -> InstallResult<Self> {
        validate_action(action)?;
        if proof.is_some_and(|(request, _)| request.len() > MAX_SETTINGS_BYTES
            || !serde_json::from_str::<serde_json::Value>(request).is_ok_and(|value| value.is_object())) {
            return Err(InstallError::InvalidAction);
        }
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
            last_action_proof: proof.map(|(request, complete)| SettingsActionProof { request: request.into(), complete }),
            known_settings_actions: vec![action.into()],
        })
    }

    pub(super) fn inherit_known_actions(&mut self, current: &Self) {
        // v2 proves only its last UUID. Earlier absent history is not invented.
        self.known_settings_actions.extend(current.known_settings_actions.iter().cloned());
        self.known_settings_actions.extend(current.action_id.iter().cloned());
        self.known_settings_actions.sort();
        self.known_settings_actions.dedup();
    }

    pub(super) fn same_action(&self, other: &Self) -> bool {
        let same_proof = match (&self.last_action_proof, &other.last_action_proof) {
            (Some(current), Some(original)) => current.request == original.request
                && (current.complete || !original.complete),
            (None, None) => true,
            _ => false,
        };
        self.revision == other.revision && self.action_id == other.action_id
            && self.packages == other.packages && self.runtimes == other.runtimes
            && same_proof
    }

    pub(super) fn completed_action(&self, expected_revision: u64, action: &str, request: &str) -> InstallResult<Self> {
        if self.action_id() != Some(action) || expected_revision.checked_add(1) != Some(self.revision)
            || self.action_request() != Some(request) {
            return Err(InstallError::ActionConflict);
        }
        let mut completed = self.clone();
        completed.last_action_proof.as_mut().ok_or(InstallError::ActionConflict)?.complete = true;
        Ok(completed)
    }

    pub(super) fn validate_persisted(&self) -> InstallResult<()> {
        if !matches!(self.format_version, LEGACY_SETTINGS_VERSION | SETTINGS_VERSION)
            || self.format_version == LEGACY_SETTINGS_VERSION
                && (self.last_action_proof.is_some() || !self.known_settings_actions.is_empty())
            || self.revision == 0
            || self
                .action_id
                .as_deref()
                .is_none_or(|action| validate_action(action).is_err())
        {
            return Err(InstallError::CorruptSettings);
        }
        if self.known_settings_actions.iter().any(|id| validate_action(id).is_err())
            || self.known_settings_actions.windows(2).any(|pair| pair[0] >= pair[1])
            || self.format_version == SETTINGS_VERSION
                && !self.known_settings_actions.iter().any(|id| Some(id.as_str()) == self.action_id()) {
            return Err(InstallError::CorruptSettings);
        }
        if self.last_action_proof.as_ref().is_some_and(|proof| proof.request.len() > MAX_SETTINGS_BYTES
            || !serde_json::from_str::<serde_json::Value>(&proof.request).is_ok_and(|value| value.is_object())) {
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
