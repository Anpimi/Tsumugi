//! A local Pack is an untrusted selection of independently reviewed packages.
//! Capturing it performs no installation, activation, signature verification,
//! dependency download or execution. The application supplies manual approval.
use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tsumugi_plugin_sdk as sdk;

use crate::{
    HostError, HostResult, PackageImage,
    tree::{TreeLimits, capture_tree_with_layout},
};

pub const MAX_PACK_MEMBERS: usize = 16;
pub const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
const MAX_DESCRIPTOR_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflinePackDescriptor {
    pub format_version: u32,
    pub id: String,
    pub display_name: String,
    pub packages: Vec<OfflinePackMember>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OfflinePackMember {
    /// A single portable directory name immediately below the selected root.
    pub directory: String,
    pub plugin: sdk::PluginIdentity,
    pub package_digest: String,
}

/// Immutable bytes from one complete, bounded, descriptor-relative snapshot.
/// Package names and digest pins in pack.json are claims, not trusted metadata.
#[derive(Clone)]
pub struct CapturedOfflinePack {
    descriptor: OfflinePackDescriptor,
    descriptor_digest: String,
    packages: Vec<PackageImage>,
}

impl CapturedOfflinePack {
    pub fn capture_directory(root: &Path, authorized: impl Fn() -> bool) -> HostResult<Self> {
        let started = Instant::now();
        let timeout = Duration::from_secs(30);
        let captured = capture_tree_with_layout(
            root,
            &TreeLimits {
                max_files: 1024,
                max_bytes: MAX_PACK_BYTES,
                max_directories: 1024,
                max_depth: 17,
                timeout,
                special_file_limit: Some(("pack.json", MAX_DESCRIPTOR_BYTES)),
            },
            &authorized,
        )?;
        let mut files = captured.files;
        let raw = files
            .remove("pack.json")
            .ok_or(HostError::MissingArtifact)?;
        if raw.executable {
            return Err(HostError::PackagePath);
        }
        let descriptor: OfflinePackDescriptor =
            serde_json::from_slice(&raw.bytes).map_err(|_| HostError::InvalidContract)?;
        descriptor.validate()?;
        let mut packages = Vec::with_capacity(descriptor.packages.len());
        for member in &descriptor.packages {
            if !authorized() {
                return Err(HostError::AuthorityRevoked);
            }
            if started.elapsed() >= timeout {
                return Err(HostError::Timeout);
            }
            let prefix = format!("{}/", member.directory);
            // The aggregate tree allowance must not relax the original package
            // limit. Empty directories count too, from these same held scans.
            let directories = captured
                .directories
                .iter()
                .filter(|path| **path == member.directory || path.starts_with(&prefix))
                .count();
            if directories > crate::package::MAX_DIRECTORIES {
                return Err(HostError::PackageLimit);
            }
            let paths: Vec<_> = files
                .keys()
                .filter(|path| path.starts_with(&prefix))
                .cloned()
                .collect();
            let mut contents = std::collections::BTreeMap::new();
            for path in paths {
                let relative = path[prefix.len()..].to_owned();
                contents.insert(relative, files.remove(&path).expect("captured member path"));
            }
            let manifest = contents
                .remove("manifest.json")
                .ok_or(HostError::MissingArtifact)?;
            let image = PackageImage::capture(manifest.bytes, contents, &member.package_digest)?;
            if image.manifest().manifest().plugin != member.plugin {
                return Err(HostError::PackageMismatch);
            }
            packages.push(image);
        }
        if !files.is_empty() {
            return Err(HostError::PackagePath);
        }
        if !authorized() {
            return Err(HostError::AuthorityRevoked);
        }
        if started.elapsed() >= timeout {
            return Err(HostError::Timeout);
        }
        use sha2::{Digest, Sha256};
        Ok(Self {
            descriptor,
            descriptor_digest: format!("{:x}", Sha256::digest(&raw.bytes)),
            packages,
        })
    }

    pub fn descriptor(&self) -> &OfflinePackDescriptor {
        &self.descriptor
    }
    pub fn descriptor_digest(&self) -> &str {
        &self.descriptor_digest
    }
    pub fn packages(&self) -> &[PackageImage] {
        &self.packages
    }
}

impl OfflinePackDescriptor {
    fn validate(&self) -> HostResult<()> {
        if self.format_version != 1
            || self.id.is_empty()
            || self.id.len() > 128
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || self.display_name.trim().is_empty()
            || self.display_name.len() > 256
            || self.display_name.chars().any(char::is_control)
        {
            return Err(HostError::InvalidContract);
        }
        if self.packages.is_empty() || self.packages.len() > MAX_PACK_MEMBERS {
            return Err(HostError::PackageLimit);
        }
        let mut names = BTreeSet::new();
        let mut plugins = BTreeSet::new();
        for member in &self.packages {
            crate::package::portable_path(&member.directory)?;
            if member.directory.contains('/')
                || member.directory.eq_ignore_ascii_case("pack.json")
                || !names.insert(member.directory.to_ascii_lowercase())
                || !plugins.insert(member.plugin.id.clone())
            {
                return Err(HostError::PackagePath);
            }
            member
                .plugin
                .validate()
                .map_err(|_| HostError::InvalidContract)?;
            sdk::validate_package_digest(&member.package_digest)
                .map_err(|_| HostError::InvalidContract)?;
        }
        Ok(())
    }
}
