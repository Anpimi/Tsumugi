//! Read the existing uncompressed candidate transport without extracting files.
use crate::{
    HostError, HostResult,
    package_profile::{MAX_DEPTH, MAX_DIRECTORIES, MAX_FILES, MAX_PACKAGE_BYTES, portable_path},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
};
use tar::{Archive, EntryType};
use tsumugi_plugin_sdk::{MAX_MANIFEST_BYTES, RuntimeArtifactFile};

/// Encoded candidate limit: the original payload budget plus bounded tar overhead.
pub const MAX_PACKAGE_ARCHIVE_BYTES: usize = MAX_PACKAGE_BYTES + 1024 * 1024;

fn field(bytes: &[u8]) -> HostResult<&[u8]> {
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    if bytes[end..].iter().any(|byte| *byte != 0) || bytes[..end].contains(&b'\\') {
        return Err(HostError::PackagePath);
    }
    Ok(&bytes[..end])
}

pub(crate) fn capture_files(
    bytes: &[u8],
    check: impl Fn() -> HostResult<()>,
) -> HostResult<BTreeMap<String, RuntimeArtifactFile>> {
    check()?;
    if bytes.len() > MAX_PACKAGE_ARCHIVE_BYTES {
        return Err(HostError::PackageLimit);
    }
    if bytes.len() < 1024 || bytes.len() % 512 != 0 {
        return Err(HostError::CaptureFailed);
    }
    let mut archive = Archive::new(bytes);
    let mut files = BTreeMap::new();
    let mut directories = BTreeSet::from([String::new()]);
    let mut spellings = BTreeMap::new();
    let mut names = BTreeSet::<String>::new();
    let mut pending_path = None;
    let mut total = 0usize;
    let mut end = 0usize;
    for (index, entry) in archive
        .entries()
        .map_err(|_| HostError::CaptureFailed)?
        .raw(true)
        .enumerate()
    {
        check()?;
        if index >= 2 * (MAX_FILES + 1) {
            return Err(HostError::PackageLimit);
        }
        let mut entry = entry.map_err(|_| HostError::CaptureFailed)?;
        let header = entry.header();
        let ustar = header.as_ustar().ok_or(HostError::PackagePath)?;
        field(&ustar.name)?;
        field(&ustar.prefix)?;
        if !field(&ustar.linkname)?.is_empty() {
            return Err(HostError::PackagePath);
        }
        let size = usize::try_from(entry.size()).map_err(|_| HostError::PackageLimit)?;
        let payload =
            usize::try_from(entry.raw_file_position()).map_err(|_| HostError::PackageLimit)?;
        end = payload
            .checked_add(
                size.div_ceil(512)
                    .checked_mul(512)
                    .ok_or(HostError::PackageLimit)?,
            )
            .ok_or(HostError::PackageLimit)?;
        if end > bytes.len().saturating_sub(1024) {
            return Err(HostError::CaptureFailed);
        }
        if bytes[payload + size..end].iter().any(|byte| *byte != 0) {
            return Err(HostError::CaptureFailed);
        }
        match header.entry_type() {
            EntryType::XHeader => {
                if pending_path.is_some() || size > 2048 {
                    return Err(HostError::PackagePath);
                }
                let mut pax = Vec::with_capacity(size);
                entry
                    .read_to_end(&mut pax)
                    .map_err(|_| HostError::CaptureFailed)?;
                // The library's iterator ends at an empty line. This profile
                // permits exactly one complete record, so no hidden suffix can
                // follow an early newline or a malformed final line.
                if pax.len() != size
                    || pax.last() != Some(&b'\n')
                    || pax.iter().filter(|byte| **byte == b'\n').count() != 1
                {
                    return Err(HostError::CaptureFailed);
                }
                for extension in tar::PaxExtensions::new(&pax) {
                    let extension = extension.map_err(|_| HostError::CaptureFailed)?;
                    if extension.key_bytes() != b"path" || pending_path.is_some() {
                        return Err(HostError::PackagePath);
                    }
                    let path = std::str::from_utf8(extension.value_bytes())
                        .map_err(|_| HostError::PackagePath)?;
                    portable_path(path)?;
                    pending_path = Some(path.to_owned());
                }
                if pending_path.is_none() {
                    return Err(HostError::PackagePath);
                }
                continue;
            }
            EntryType::Regular => {}
            _ => return Err(HostError::PackagePath),
        }
        let mode = entry.header().mode().map_err(|_| HostError::PackagePath)?;
        if mode & !0o777 != 0 {
            return Err(HostError::PackagePath);
        }
        let raw = entry.header().path_bytes();
        let path = match pending_path.take() {
            Some(path) => path,
            None => std::str::from_utf8(&raw)
                .map_err(|_| HostError::PackagePath)?
                .to_owned(),
        };
        portable_path(&path)?;
        let folded = path.to_ascii_lowercase();
        if (folded == "manifest.json" && (path != "manifest.json" || mode & 0o111 != 0))
            || folded.starts_with("manifest.json/")
            || names.iter().any(|old| {
                old == &folded
                    || old.starts_with(&(folded.clone() + "/"))
                    || folded.starts_with(&(old.clone() + "/"))
            })
        {
            return Err(HostError::PackagePath);
        }
        names.insert(folded);
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() - 1 > MAX_DEPTH {
            return Err(HostError::PackageLimit);
        }
        let mut prefix = String::new();
        for (index, part) in parts.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if spellings
                .insert(prefix.to_ascii_lowercase(), prefix.clone())
                .is_some_and(|old| old != prefix)
            {
                return Err(HostError::PackagePath);
            }
            if index + 1 < parts.len() {
                directories.insert(prefix.clone());
            }
        }
        if directories.len() > MAX_DIRECTORIES || files.len() > MAX_FILES {
            return Err(HostError::PackageLimit);
        }
        total = total.checked_add(size).ok_or(HostError::PackageLimit)?;
        if total > MAX_PACKAGE_BYTES || (path == "manifest.json" && size > MAX_MANIFEST_BYTES) {
            return Err(HostError::PackageLimit);
        }
        let mut contents = Vec::new();
        contents
            .try_reserve_exact(size)
            .map_err(|_| HostError::PackageLimit)?;
        let mut buffer = [0; 64 * 1024];
        loop {
            check()?;
            let count = entry
                .read(&mut buffer)
                .map_err(|_| HostError::CaptureFailed)?;
            if count == 0 {
                break;
            }
            contents.extend_from_slice(&buffer[..count]);
        }
        if contents.len() != size {
            return Err(HostError::CaptureFailed);
        }
        files.insert(
            path,
            RuntimeArtifactFile {
                bytes: contents,
                executable: mode & 0o111 != 0,
            },
        );
    }
    if pending_path.is_some() {
        return Err(HostError::PackagePath);
    }
    // The tar iterator normally stops at the first zero header. Require both
    // terminators and only zero padding, rejecting concatenated/trailing input.
    if bytes.len().saturating_sub(end) < 1024 {
        return Err(HostError::CaptureFailed);
    }
    for chunk in bytes[end..].chunks(64 * 1024) {
        check()?;
        if chunk.iter().any(|byte| *byte != 0) {
            return Err(HostError::CaptureFailed);
        }
    }
    if !files.contains_key("manifest.json") {
        return Err(HostError::MissingArtifact);
    }
    check()?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn append(
        builder: &mut tar::Builder<Vec<u8>>,
        path: &str,
        mode: u32,
        kind: EntryType,
        bytes: &[u8],
    ) {
        let mut header = tar::Header::new_ustar();
        header.set_path(path).unwrap();
        header.set_size(bytes.len() as u64);
        header.set_mode(mode);
        header.set_entry_type(kind);
        header.set_cksum();
        builder.append(&header, bytes).unwrap();
    }

    fn encoded(entries: &[(&str, u32, EntryType, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, mode, kind, bytes) in entries {
            append(&mut builder, name, *mode, *kind, bytes);
        }
        builder.into_inner().unwrap()
    }

    fn read(bytes: &[u8]) -> HostResult<BTreeMap<String, RuntimeArtifactFile>> {
        capture_files(bytes, || Ok(()))
    }

    fn pax_record(key: &str, value: &str) -> Vec<u8> {
        let payload = format!(" {key}={value}\n");
        let mut length = payload.len() + 1;
        loop {
            let revised = payload.len() + length.to_string().len();
            if revised == length {
                break;
            }
            length = revised;
        }
        format!("{length}{payload}").into_bytes()
    }

    #[test]
    fn preserves_binary_bytes_and_flags_without_filename_or_host_modes() {
        let bytes = encoded(&[
            ("manifest.json", 0o644, EntryType::Regular, b"{}"),
            ("data.exe", 0o644, EntryType::Regular, &[0, 255, 13, 10]),
            ("bin/tool.bin", 0o755, EntryType::Regular, b"not a program"),
        ]);
        let files = read(&bytes).unwrap();
        assert_eq!(files["data.exe"].bytes, [0, 255, 13, 10]);
        assert!(!files["data.exe"].executable);
        assert!(files["bin/tool.bin"].executable);
    }

    #[test]
    fn accepts_one_local_pax_path_for_the_following_regular_file() {
        let path = format!("{}/file.bin", "a".repeat(110));
        let pax = pax_record("path", &path);
        let bytes = encoded(&[
            ("manifest.json", 0o644, EntryType::Regular, b"{}"),
            ("././@PaxHeader", 0o644, EntryType::XHeader, &pax),
            ("placeholder", 0o755, EntryType::Regular, b"original"),
            ("plain.bin", 0o644, EntryType::Regular, b"next"),
        ]);
        let files = read(&bytes).unwrap();
        assert_eq!(files[&path].bytes, b"original");
        assert!(files[&path].executable);
        assert_eq!(files["plain.bin"].bytes, b"next");
    }

    #[test]
    fn refuses_hidden_duplicate_unknown_chained_and_dangling_extensions() {
        let valid = pax_record("path", "data.bin");
        let unknown = pax_record("size", "0");
        let mut blank_suffix = valid.clone();
        blank_suffix.extend_from_slice(b"\n20 GNU.sparse.size=0\n");
        let mut duplicate = valid.clone();
        duplicate.extend_from_slice(&valid);
        for pax in [
            &unknown,
            &blank_suffix,
            &duplicate,
            &valid[..valid.len() - 1].to_vec(),
        ] {
            let bytes = encoded(&[
                ("manifest.json", 0o644, EntryType::Regular, b"{}"),
                ("pax", 0o644, EntryType::XHeader, pax),
                ("placeholder", 0o644, EntryType::Regular, b"data"),
            ]);
            assert!(read(&bytes).is_err());
        }
        for tail in [
            vec![],
            vec![("pax2", 0o644, EntryType::XHeader, valid.as_slice())],
        ] {
            let mut entries = vec![
                ("manifest.json", 0o644, EntryType::Regular, b"{}".as_slice()),
                ("pax", 0o644, EntryType::XHeader, valid.as_slice()),
            ];
            entries.extend(tail);
            assert!(read(&encoded(&entries)).is_err());
        }
    }

    #[test]
    fn rejects_non_regular_members_and_unsupported_metadata() {
        for kind in [
            EntryType::Link,
            EntryType::Symlink,
            EntryType::Char,
            EntryType::Block,
            EntryType::Directory,
            EntryType::Fifo,
            EntryType::Continuous,
            EntryType::GNUSparse,
            EntryType::GNULongName,
            EntryType::GNULongLink,
            EntryType::XGlobalHeader,
        ] {
            assert!(
                read(&encoded(&[
                    ("manifest.json", 0o644, EntryType::Regular, b"{}"),
                    ("other", 0o644, kind, b"")
                ]))
                .is_err(),
                "{kind:?}"
            );
        }
        for (name, mode) in [
            ("manifest.json", 0o755),
            ("data.bin", 0o4644),
            ("MANIFEST.JSON", 0o644),
        ] {
            assert!(read(&encoded(&[(name, mode, EntryType::Regular, b"{}")])).is_err());
        }
    }

    #[test]
    fn rejects_duplicates_component_aliases_and_file_directory_collisions() {
        for pair in [
            ["data.bin", "data.bin"],
            ["A/x", "a/y"],
            ["data", "data/x"],
            ["data/x", "data"],
        ] {
            assert!(
                read(&encoded(&[
                    ("manifest.json", 0o644, EntryType::Regular, b"{}"),
                    (pair[0], 0o644, EntryType::Regular, b"one"),
                    (pair[1], 0o644, EntryType::Regular, b"two")
                ]))
                .is_err(),
                "{pair:?}"
            );
        }
        for name in [
            "/escape",
            "../escape",
            "a/../escape",
            "a\\escape",
            "a//escape",
            "NUL",
            "data:stream",
        ] {
            let pax = pax_record("path", name);
            assert!(
                read(&encoded(&[
                    ("manifest.json", 0o644, EntryType::Regular, b"{}"),
                    ("pax", 0o644, EntryType::XHeader, &pax),
                    ("placeholder", 0o644, EntryType::Regular, b"data")
                ]))
                .is_err()
            );
        }
    }

    #[test]
    fn requires_complete_terminators_and_refuses_trailing_or_concatenated_bytes() {
        let bytes = encoded(&[("manifest.json", 0o644, EntryType::Regular, b"{}")]);
        for missing in [1, 512, 1024] {
            assert!(read(&bytes[..bytes.len() - missing]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.extend_from_slice(&[1; 512]);
        assert!(read(&trailing).is_err());
        let mut concatenated = bytes.clone();
        concatenated.extend_from_slice(&bytes);
        assert!(read(&concatenated).is_err());
        let mut checksum = bytes.clone();
        checksum[0] ^= 1;
        assert!(read(&checksum).is_err());
        let mut padding = bytes;
        padding[514] = 1;
        assert!(read(&padding).is_err());
    }

    #[test]
    fn enforces_package_bounds_and_checks_revocation_during_reading() {
        let mut builder = tar::Builder::new(Vec::new());
        append(
            &mut builder,
            "manifest.json",
            0o644,
            EntryType::Regular,
            b"{}",
        );
        for index in 0..=MAX_FILES {
            append(
                &mut builder,
                &format!("file-{index}"),
                0o644,
                EntryType::Regular,
                b"",
            );
        }
        assert_eq!(
            read(&builder.into_inner().unwrap()).err().unwrap(),
            HostError::PackageLimit
        );
        let metadata = vec![0; MAX_MANIFEST_BYTES + 1];
        assert_eq!(
            read(&encoded(&[(
                "manifest.json",
                0o644,
                EntryType::Regular,
                &metadata
            )]))
            .err()
            .unwrap(),
            HostError::PackageLimit
        );
        let bytes = encoded(&[
            ("manifest.json", 0o644, EntryType::Regular, b"{}"),
            ("data.bin", 0o644, EntryType::Regular, &vec![0; 128 * 1024]),
        ]);
        let calls = Cell::new(0);
        assert_eq!(
            capture_files(&bytes, || {
                calls.set(calls.get() + 1);
                if calls.get() > 5 {
                    Err(HostError::AuthorityRevoked)
                } else {
                    Ok(())
                }
            })
            .err()
            .unwrap(),
            HostError::AuthorityRevoked
        );
    }
}
