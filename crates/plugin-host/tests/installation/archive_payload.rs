use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::Path,
};

use tsumugi_plugin_sdk::RuntimeArtifactFile;

pub(super) fn members(path: &Path) -> BTreeMap<String, RuntimeArtifactFile> {
    let bytes = fs::read(path).unwrap();
    let mut archive = tar::Archive::new(bytes.as_slice());
    archive
        .entries()
        .unwrap()
        .map(|entry| {
            let mut entry = entry.unwrap();
            assert!(entry.header().entry_type().is_file());
            let name = entry.path().unwrap().to_str().unwrap().to_owned();
            let executable = entry.header().mode().unwrap() & 0o111 != 0;
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            (name, RuntimeArtifactFile { bytes, executable })
        })
        .collect()
}

pub(super) fn encode(files: &BTreeMap<String, RuntimeArtifactFile>) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, file) in files {
        let mut header = tar::Header::new_ustar();
        if header.set_path(name).is_err() {
            builder
                .append_pax_extensions([("path", name.as_bytes())])
                .unwrap();
            header = tar::Header::new_ustar();
            header.set_path("artifact-file").unwrap();
        }
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(file.bytes.len() as u64);
        header.set_mode(if file.executable { 0o755 } else { 0o644 });
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        builder.append(&header, file.bytes.as_slice()).unwrap();
    }
    builder.into_inner().unwrap()
}

pub(super) fn replace(path: &Path, bytes: &[u8]) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
}

pub(super) fn replace_member(path: &Path, name: &str, bytes: &[u8]) {
    let mut files = members(path);
    files.get_mut(name).unwrap().bytes = bytes.to_vec();
    replace(path, &encode(&files));
}

pub(super) fn change_member_mode(path: &Path, name: &str, mode: u32) {
    let mut bytes = fs::read(path).unwrap();
    let (position, mut header) = {
        let mut archive = tar::Archive::new(bytes.as_slice());
        let entry = archive
            .entries()
            .unwrap()
            .map(Result::unwrap)
            .find(|entry| entry.path().unwrap() == Path::new(name))
            .unwrap();
        (entry.raw_header_position() as usize, entry.header().clone())
    };
    header.set_mode(mode);
    header.set_cksum();
    bytes[position..position + 512].copy_from_slice(header.as_bytes());
    replace(path, &bytes);
}

pub(super) fn write_development_tree(root: &Path, files: &BTreeMap<String, RuntimeArtifactFile>) {
    fs::create_dir(root).unwrap();
    let mut directories = BTreeSet::from([root.to_owned()]);
    for (name, file) in files {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &file.bytes).unwrap();
        fs::set_permissions(
            &path,
            fs::Permissions::from_mode(if file.executable { 0o500 } else { 0o400 }),
        )
        .unwrap();
        let mut parent = path.parent().unwrap();
        while parent.starts_with(root) {
            directories.insert(parent.to_owned());
            parent = parent.parent().unwrap();
        }
    }
    for directory in directories.iter().rev() {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o500)).unwrap();
    }
}
