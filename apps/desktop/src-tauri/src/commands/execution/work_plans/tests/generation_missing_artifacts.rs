//! Reversible external loss of sealed bytes in this test's own installation.
use super::*;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

fn move_sealed_directory(source: &Path, destination: &Path) {
    let permissions = fs::symlink_metadata(source).unwrap().permissions();
    assert_eq!(permissions.mode() & 0o7777, 0o500);
    // macOS requires the moved directory to be writable for a cross-parent
    // rename. Change only this fixture-owned wrapper, then reseal it before
    // any operation observes the missing artifact; its contents stay sealed.
    fs::set_permissions(source, fs::Permissions::from_mode(0o700)).unwrap();
    let result = fs::rename(source, destination);
    let retained = if result.is_ok() { destination } else { source };
    fs::set_permissions(retained, permissions).unwrap();
    result.unwrap();
}

pub(super) struct WithheldArtifact {
    original: PathBuf,
    held: PathBuf,
    identity: (u64, u64),
}
impl Drop for WithheldArtifact {
    fn drop(&mut self) {
        assert!(
            !self.original.exists(),
            "do not overwrite a replacement artifact"
        );
        let metadata = fs::symlink_metadata(&self.held).unwrap();
        assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
        assert_eq!((metadata.dev(), metadata.ino()), self.identity);
        move_sealed_directory(&self.held, &self.original);
    }
}

pub(super) fn withhold(
    installation: &OwnedDirectory,
    namespace: &str,
    digest: &str,
    fixture: &Fixture,
) -> WithheldArtifact {
    assert!(matches!(namespace, "objects" | "runtimes"));
    sdk::validate_package_digest(digest).unwrap();
    let root = installation.0.path();
    let store = root.join("application/plugins");
    let original = store.join(namespace).join(digest);
    let held = root.join(format!("withheld-{namespace}-{digest}"));
    let metadata = fs::symlink_metadata(&original).unwrap();
    assert!(metadata.is_dir() && !metadata.file_type().is_symlink());
    assert_eq!(
        original.parent().unwrap().canonicalize().unwrap(),
        root.canonicalize()
            .unwrap()
            .join("application/plugins")
            .join(namespace)
    );
    assert!(!held.exists());
    let settings = fs::read(store.join("settings.json")).unwrap();
    let owner = fixture.app.state::<AppState>().plugins.clone();
    let revision = owner.environment_settings_revision().unwrap();
    let project = fixture.bytes();
    let attempts = fixture.attempt_count();
    // This is an external-file-loss fixture, not a product uninstall operation.
    // Move only this exact installed object after all owned work has settled;
    // keep its receipt and sealed bytes for restoration after the manager closes.
    move_sealed_directory(&original, &held);
    assert!(!original.exists());
    let after = fs::symlink_metadata(&held).unwrap();
    assert_eq!((after.dev(), after.ino()), (metadata.dev(), metadata.ino()));
    assert_eq!(after.permissions(), metadata.permissions());
    assert_eq!(fs::read(store.join("settings.json")).unwrap(), settings);
    assert_eq!(owner.environment_settings_revision().unwrap(), revision);
    assert_eq!(fixture.bytes(), project);
    assert_eq!(fixture.attempt_count(), attempts);
    WithheldArtifact {
        original,
        held,
        identity: (metadata.dev(), metadata.ino()),
    }
}
