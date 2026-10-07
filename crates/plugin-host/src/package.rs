use crate::{CapturedRuntime, HostError, HostResult, staging::StagedDirectory};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tsumugi_plugin_sdk::*;

const MAX_FILES: usize = 256;
const MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) const MAX_DIRECTORIES: usize = 256;
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) const MAX_DEPTH: usize = 16;

mod directory;
pub(crate) mod installation;
pub use directory::PackageInspection;

pub(crate) fn portable_path(path: &str) -> HostResult<()> {
    validate_portable_package_path(path).map_err(|_| HostError::PackagePath)
}

pub use tsumugi_plugin_sdk::RuntimeArtifactFile as PackageFile;

/// Immutable captured bytes, checked against the digest supplied by a trusted
/// catalog/installer. This API does not authenticate a publisher or read an
/// arbitrary source directory, archive, symlink or project path.
#[derive(Clone)]
pub struct PackageImage {
    manifest_bytes: Arc<[u8]>,
    manifest: Arc<ValidatedManifest>,
    files: Arc<BTreeMap<String, PackageFile>>,
    digest: String,
}
impl PackageImage {
    /// Digest of ordered, length-delimited manifest/path/content bytes and file
    /// executable flags. Computing a digest is not authorization to execute.
    pub fn digest(manifest: &[u8], files: &BTreeMap<String, PackageFile>) -> HostResult<String> {
        if manifest.len() > MAX_MANIFEST_BYTES || files.is_empty() || files.len() > MAX_FILES {
            return Err(HostError::PackageLimit);
        }
        let mut size = manifest.len();
        let mut names = Vec::new();
        let mut hash = Sha256::new();
        hash.update(b"tsumugi-captured-package-v1\0");
        hash.update((manifest.len() as u64).to_be_bytes());
        hash.update(manifest);
        for (path, file) in files {
            portable_path(path)?;
            let folded = path.to_ascii_lowercase();
            if folded == "manifest.json"
                || folded.starts_with("manifest.json/")
                || names.iter().any(|n: &String| {
                    n == &folded
                        || n.starts_with(&(folded.clone() + "/"))
                        || folded.starts_with(&(n.clone() + "/"))
                })
            {
                return Err(HostError::PackagePath);
            }
            names.push(folded);
            size = size
                .checked_add(file.bytes.len())
                .ok_or(HostError::PackageLimit)?;
            if size > MAX_PACKAGE_BYTES {
                return Err(HostError::PackageLimit);
            }
            hash.update((path.len() as u64).to_be_bytes());
            hash.update(path.as_bytes());
            hash.update([u8::from(file.executable)]);
            hash.update((file.bytes.len() as u64).to_be_bytes());
            hash.update(&file.bytes);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    pub fn capture(
        manifest_bytes: Vec<u8>,
        files: BTreeMap<String, PackageFile>,
        expected_digest: &str,
    ) -> HostResult<Self> {
        let digest = Self::digest(&manifest_bytes, &files)?;
        if digest != expected_digest {
            return Err(HostError::PackageMismatch);
        }
        let manifest = parse_manifest(&manifest_bytes).map_err(|_| HostError::InvalidContract)?;
        for component in &manifest.manifest().components {
            if let Some(path) = &component.entrypoint {
                let file = files.get(path).ok_or(HostError::MissingArtifact)?;
                if component.runtime == RuntimeKind::NativeWorker && !file.executable {
                    return Err(HostError::MissingArtifact);
                }
            }
        }
        for contribution in &manifest.manifest().contributions {
            if let ContributionKind::Resource { path, .. } | ContributionKind::Skill { path } =
                &contribution.contribution
            {
                if !files.contains_key(path) {
                    return Err(HostError::MissingArtifact);
                }
            }
        }
        Ok(Self {
            manifest_bytes: manifest_bytes.into(),
            manifest: Arc::new(manifest),
            files: Arc::new(files),
            digest,
        })
    }
    pub fn package_digest(&self) -> &str {
        &self.digest
    }
    pub fn manifest(&self) -> &ValidatedManifest {
        &self.manifest
    }
    /// Interpret only the explicitly selected SDK resource from this immutable
    /// package. The resource cannot substitute another package's declarations.
    pub fn source_import(&self, contribution_id: &str) -> HostResult<SourceImportBinding> {
        let declaration = parse_source_import_declaration(
            self.resource_bytes(contribution_id, &source_import_declaration_contract())?,
        )
        .map_err(|_| HostError::InvalidContract)?;
        let review = self.review_declaration(&declaration.review_resource)?;
        declaration
            .bind(&self.manifest, &self.digest, &review.declaration)
            .map_err(|_| HostError::InvalidContract)
    }
    /// Bind the selected immutable SDK build resource without executing a
    /// component, reading user material or granting publication authority.
    pub fn build_declaration(&self, contribution_id: &str) -> HostResult<BuildBinding> {
        parse_build_declaration(
            self.resource_bytes(contribution_id, &build_declaration_contract())?,
        )
        .and_then(|declaration| declaration.bind(&self.manifest, &self.digest))
        .map_err(|_| HostError::InvalidContract)
    }
    /// Select immutable translation metadata; interpretation and current project
    /// adoption are separate from resource inspection and execution consent.
    pub fn translation_import(
        &self,
        contribution_id: &str,
    ) -> HostResult<TranslationImportBinding> {
        parse_translation_import_declaration(
            self.resource_bytes(contribution_id, &translation_import_declaration_contract())?,
        )
        .and_then(|declaration| declaration.bind(&self.manifest, &self.digest))
        .map_err(|_| HostError::InvalidContract)
    }
    /// Inspect a fixed domain QA resource; this neither runs its checker nor
    /// replaces the application's mandatory checks, waivers or human decisions.
    pub fn review_declaration(&self, contribution_id: &str) -> HostResult<ReviewBinding> {
        parse_review_declaration(
            self.resource_bytes(contribution_id, &review_declaration_contract())?,
        )
        .and_then(|declaration| declaration.bind(&self.manifest, &self.digest))
        .map_err(|_| HostError::InvalidContract)
    }
    /// Read one declared resource from the captured package, with an exact
    /// schema and behavior match. Bytes remain opaque: the caller owns domain
    /// validation. This does not open source paths, activate code or grant
    /// project mutation or execution authority.
    pub fn resource_bytes(
        &self,
        contribution_id: &str,
        expected: &ContractRef,
    ) -> HostResult<&[u8]> {
        let contribution = self
            .manifest
            .manifest()
            .contributions
            .iter()
            .find(|entry| entry.id == contribution_id)
            .ok_or(HostError::InvalidContract)?;
        let ContributionKind::Resource { schema, path } = &contribution.contribution else {
            return Err(HostError::InvalidContract);
        };
        if schema != expected {
            return Err(HostError::InvalidContract);
        }
        let file = self.files.get(path).ok_or(HostError::MissingArtifact)?;
        if file.executable {
            return Err(HostError::InvalidContract);
        }
        Ok(&file.bytes)
    }
    /// Read one declared Skill from the same immutable package. Guidance is
    /// untrusted content and supplies no tool, network or execution permission.
    pub fn skill_bytes(&self, contribution_id: &str) -> HostResult<&[u8]> {
        let contribution = self
            .manifest
            .manifest()
            .contributions
            .iter()
            .find(|entry| entry.id == contribution_id)
            .ok_or(HostError::InvalidContract)?;
        let ContributionKind::Skill { path } = &contribution.contribution else {
            return Err(HostError::InvalidContract);
        };
        let file = self.files.get(path).ok_or(HostError::MissingArtifact)?;
        if file.executable {
            return Err(HostError::InvalidContract);
        }
        Ok(&file.bytes)
    }
    pub(crate) fn stage(
        &self,
        staging_parent: &Path,
        runtime: Option<&CapturedRuntime>,
        authorized: impl Fn() -> bool,
    ) -> HostResult<StagedDirectory> {
        crate::staging::materialize(
            staging_parent,
            &self.manifest_bytes,
            &self.files,
            runtime,
            authorized,
        )
    }
}
