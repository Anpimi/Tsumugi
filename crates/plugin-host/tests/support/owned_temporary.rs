pub(crate) struct OwnedTemporary(tempfile::TempDir);
impl OwnedTemporary {
    pub(crate) fn new() -> Self {
        Self(
            tempfile::Builder::new()
                .prefix("tsumugi-knowledge-")
                .tempdir()
                .unwrap(),
        )
    }
    pub(crate) fn path(&self) -> &std::path::Path {
        self.0.path()
    }
}
impl Drop for OwnedTemporary {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        // The installation store seals its owned objects. Restore directory
        // write permission only inside this synthetic fixture before TempDir
        // removes it; do not traverse a link or touch a selected package tree.
        fn writable(path: &std::path::Path) {
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                return;
            };
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return;
            }
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            for child in std::fs::read_dir(path).unwrap() {
                writable(&child.unwrap().path());
            }
        }
        writable(self.path());
    }
}
