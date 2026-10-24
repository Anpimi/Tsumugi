//! Strict uncompressed artifact archives, read without extracting files.
use crate::{
    HostError, HostResult,
    package_profile::{MAX_DEPTH, MAX_DIRECTORIES, MAX_FILES, MAX_PACKAGE_BYTES, portable_path},
};
use std::{
    cell::Cell,
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read, Seek, SeekFrom},
};
use tar::{Archive, EntryType};
use tsumugi_plugin_sdk::{
    MAX_MANIFEST_BYTES, MAX_RUNTIME_ARTIFACT_BYTES, MAX_RUNTIME_ARTIFACT_FILES, RuntimeArtifactFile,
};

/// Encoded candidate limit: the original payload budget plus bounded tar overhead.
pub const MAX_PACKAGE_ARCHIVE_BYTES: usize = MAX_PACKAGE_BYTES + 1024 * 1024;
pub(crate) const MAX_RUNTIME_ARCHIVE_BYTES: usize = MAX_RUNTIME_ARTIFACT_BYTES + 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Profile {
    Package,
    Runtime,
}

impl Profile {
    fn max_files(self) -> usize {
        match self {
            Self::Package => MAX_FILES + 1,
            Self::Runtime => MAX_RUNTIME_ARTIFACT_FILES,
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Package => MAX_PACKAGE_BYTES,
            Self::Runtime => MAX_RUNTIME_ARTIFACT_BYTES,
        }
    }

    fn max_encoded(self) -> usize {
        match self {
            Self::Package => MAX_PACKAGE_ARCHIVE_BYTES,
            Self::Runtime => MAX_RUNTIME_ARCHIVE_BYTES,
        }
    }

    fn max_depth(self) -> usize {
        match self {
            Self::Package => MAX_DEPTH,
            Self::Runtime => 32,
        }
    }

    fn max_directories(self) -> usize {
        match self {
            Self::Package => MAX_DIRECTORIES,
            Self::Runtime => 1024,
        }
    }
}

/// A structural index is never proof of the skipped members' contents. Counts
/// include every regular member, including the package manifest when present.
#[derive(Debug)]
pub(crate) struct ArchiveIndex {
    pub manifest: Option<Vec<u8>>,
    pub file_count: usize,
    pub byte_count: usize,
}

struct Namespace {
    profile: Profile,
    directories: BTreeSet<String>,
    spellings: BTreeMap<String, String>,
    names: BTreeSet<String>,
}

impl Namespace {
    fn new(profile: Profile) -> Self {
        Self {
            profile,
            directories: BTreeSet::from([String::new()]),
            spellings: BTreeMap::new(),
            names: BTreeSet::new(),
        }
    }

    fn admit(&mut self, path: &str) -> HostResult<()> {
        portable_path(path)?;
        let folded = path.to_ascii_lowercase();
        if (self.profile == Profile::Package
            && ((folded == "manifest.json" && path != "manifest.json")
                || folded.starts_with("manifest.json/")))
            || self.names.iter().any(|old| {
                old == &folded
                    || old.starts_with(&(folded.clone() + "/"))
                    || folded.starts_with(&(old.clone() + "/"))
            })
        {
            return Err(HostError::PackagePath);
        }
        self.names.insert(folded);
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() - 1 > self.profile.max_depth() {
            return Err(HostError::PackageLimit);
        }
        let mut prefix = String::new();
        for (index, part) in parts.iter().enumerate() {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            if self
                .spellings
                .insert(prefix.to_ascii_lowercase(), prefix.clone())
                .is_some_and(|old| old != prefix)
            {
                return Err(HostError::PackagePath);
            }
            if index + 1 < parts.len() {
                self.directories.insert(prefix.clone());
            }
        }
        if self.directories.len() > self.profile.max_directories()
            || self.names.len() > self.profile.max_files()
        {
            return Err(HostError::PackageLimit);
        }
        Ok(())
    }
}

struct CheckedBytes<'a, F> {
    remaining: &'a [u8],
    check: &'a F,
    failure: Option<HostError>,
}

impl<F: Fn() -> HostResult<()>> Read for CheckedBytes<'_, F> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if let Err(error) = (self.check)() {
            self.failure = Some(error);
            return Err(std::io::Error::other(error));
        }
        let count = output.len().min(self.remaining.len()).min(64 * 1024);
        output[..count].copy_from_slice(&self.remaining[..count]);
        self.remaining = &self.remaining[count..];
        Ok(count)
    }
}

/// Encode the same transport profile from captured facts, without filesystem IO.
pub(crate) fn encode_files(
    manifest: &[u8],
    files: &BTreeMap<String, RuntimeArtifactFile>,
    check: impl Fn() -> HostResult<()>,
) -> HostResult<Vec<u8>> {
    check()?;
    if manifest.len() > MAX_MANIFEST_BYTES || files.is_empty() {
        return Err(HostError::PackageLimit);
    }
    encode_members(
        std::iter::once(("manifest.json", manifest, false)).chain(
            files
                .iter()
                .map(|(path, file)| (path.as_str(), file.bytes.as_slice(), file.executable)),
        ),
        Profile::Package,
        &check,
    )
}

pub(crate) fn encode_runtime_files(
    files: &BTreeMap<String, RuntimeArtifactFile>,
    check: impl Fn() -> HostResult<()>,
) -> HostResult<Vec<u8>> {
    check()?;
    if files.is_empty() {
        return Err(HostError::MissingArtifact);
    }
    encode_members(
        files
            .iter()
            .map(|(path, file)| (path.as_str(), file.bytes.as_slice(), file.executable)),
        Profile::Runtime,
        &check,
    )
}

fn encode_members<'a>(
    members: impl Iterator<Item = (&'a str, &'a [u8], bool)> + Clone,
    profile: Profile,
    check: &impl Fn() -> HostResult<()>,
) -> HostResult<Vec<u8>> {
    let mut namespace = Namespace::new(profile);
    let mut total = 0usize;
    for (path, bytes, _) in members.clone() {
        check()?;
        namespace.admit(path)?;
        total = total
            .checked_add(bytes.len())
            .ok_or(HostError::PackageLimit)?;
        if total > profile.max_bytes() {
            return Err(HostError::PackageLimit);
        }
    }
    let mut output = Vec::new();
    output
        .try_reserve_exact(total + profile.max_encoded() - profile.max_bytes())
        .map_err(|_| HostError::PackageLimit)?;
    let mut builder = tar::Builder::new(output);
    for (path, bytes, executable) in members {
        check()?;
        let mut header = tar::Header::new_ustar();
        if header.set_path(path).is_err() {
            builder
                .append_pax_extensions([("path", path.as_bytes())])
                .map_err(|_| HostError::CaptureFailed)?;
            header = tar::Header::new_ustar();
            header
                .set_path("artifact-file")
                .map_err(|_| HostError::CaptureFailed)?;
        }
        header.set_uid(0);
        header.set_gid(0);
        header.set_mtime(0);
        header.set_size(bytes.len() as u64);
        header.set_mode(if executable { 0o755 } else { 0o644 });
        header.set_entry_type(EntryType::Regular);
        header.set_cksum();
        let mut reader = CheckedBytes {
            remaining: bytes,
            check: &check,
            failure: None,
        };
        builder
            .append(&header, &mut reader)
            .map_err(|_| reader.failure.unwrap_or(HostError::CaptureFailed))?;
        check()?;
    }
    let output = builder.into_inner().map_err(|_| HostError::CaptureFailed)?;
    if output.len() > profile.max_encoded() {
        return Err(HostError::PackageLimit);
    }
    check()?;
    Ok(output)
}

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
    capture_reader(&mut Cursor::new(bytes), Profile::Package, check)
}

pub(crate) fn capture_reader(
    reader: &mut (impl Read + Seek),
    profile: Profile,
    check: impl Fn() -> HostResult<()>,
) -> HostResult<BTreeMap<String, RuntimeArtifactFile>> {
    visit_reader(
        reader,
        profile,
        Bodies::Capture,
        profile.max_files(),
        profile.max_bytes(),
        &check,
    )
    .map(|captured| captured.0)
}

/// The second runtime artifact consumes the remainder of a shared snapshot
/// budget. Enforce it before allocating or reading each member's contents.
pub(crate) fn capture_runtime_reader(
    reader: &mut (impl Read + Seek),
    max_files: usize,
    max_bytes: usize,
    check: impl Fn() -> HostResult<()>,
) -> HostResult<BTreeMap<String, RuntimeArtifactFile>> {
    visit_reader(
        reader,
        Profile::Runtime,
        Bodies::Capture,
        max_files.min(MAX_RUNTIME_ARTIFACT_FILES),
        max_bytes.min(MAX_RUNTIME_ARTIFACT_BYTES),
        &check,
    )
    .map(|captured| captured.0)
}

/// Read structural metadata only. Runtime bodies are skipped with Seek;
/// packages additionally retain their bounded manifest metadata. No buffering
/// may read ahead into an unselected member's ordinary body.
pub(crate) fn inspect_reader(
    reader: &mut (impl Read + Seek),
    profile: Profile,
    check: impl Fn() -> HostResult<()>,
) -> HostResult<ArchiveIndex> {
    visit_reader(
        reader,
        profile,
        Bodies::PackageManifest,
        profile.max_files(),
        profile.max_bytes(),
        &check,
    )
    .map(|captured| captured.1)
}

/// Recovery indexing preserves package metadata rules without reading even its
/// manifest body. This does not produce a package image or approve any bytes.
pub(crate) fn inspect_headers(
    reader: &mut (impl Read + Seek),
    profile: Profile,
    check: impl Fn() -> HostResult<()>,
) -> HostResult<ArchiveIndex> {
    visit_reader(
        reader,
        profile,
        Bodies::Headers,
        profile.max_files(),
        profile.max_bytes(),
        &check,
    )
    .map(|captured| captured.1)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Bodies {
    Capture,
    PackageManifest,
    Headers,
}

struct CheckedReader<'a, R, F> {
    inner: &'a mut R,
    check: &'a F,
    failure: &'a Cell<Option<HostError>>,
}

impl<R, F: Fn() -> HostResult<()>> CheckedReader<'_, R, F> {
    fn allowed(&self) -> std::io::Result<()> {
        (self.check)().map_err(|error| {
            self.failure.set(Some(error));
            std::io::Error::other(error)
        })
    }
}

impl<R: Read, F: Fn() -> HostResult<()>> Read for CheckedReader<'_, R, F> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        self.allowed()?;
        let length = output.len().min(64 * 1024);
        self.inner.read(&mut output[..length])
    }
}

impl<R: Seek, F: Fn() -> HostResult<()>> Seek for CheckedReader<'_, R, F> {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.allowed()?;
        self.inner.seek(position)
    }
}

fn read_contents(
    reader: &mut impl Read,
    size: usize,
    check: &impl Fn() -> HostResult<()>,
    failure: &Cell<Option<HostError>>,
) -> HostResult<Vec<u8>> {
    let mut contents = Vec::new();
    contents
        .try_reserve_exact(size)
        .map_err(|_| HostError::PackageLimit)?;
    let mut buffer = [0; 64 * 1024];
    while contents.len() < size {
        check()?;
        let remaining = (size - contents.len()).min(buffer.len());
        let count = reader
            .read(&mut buffer[..remaining])
            .map_err(|_| failure.get().unwrap_or(HostError::CaptureFailed))?;
        if count == 0 {
            return Err(HostError::CaptureFailed);
        }
        contents.extend_from_slice(&buffer[..count]);
    }
    check()?;
    Ok(contents)
}

fn zero_range(
    reader: &mut (impl Read + Seek),
    start: u64,
    mut length: u64,
    check: &impl Fn() -> HostResult<()>,
    failure: &Cell<Option<HostError>>,
) -> HostResult<()> {
    check()?;
    reader
        .seek(SeekFrom::Start(start))
        .map_err(|_| failure.get().unwrap_or(HostError::CaptureFailed))?;
    let mut buffer = [0; 64 * 1024];
    while length != 0 {
        check()?;
        let count = usize::try_from(length.min(buffer.len() as u64))
            .map_err(|_| HostError::PackageLimit)?;
        reader
            .read_exact(&mut buffer[..count])
            .map_err(|_| failure.get().unwrap_or(HostError::CaptureFailed))?;
        if buffer[..count].iter().any(|byte| *byte != 0) {
            return Err(HostError::CaptureFailed);
        }
        length -= count as u64;
    }
    Ok(())
}

fn visit_reader(
    reader: &mut (impl Read + Seek),
    profile: Profile,
    bodies: Bodies,
    max_files: usize,
    max_bytes: usize,
    check: &impl Fn() -> HostResult<()>,
) -> HostResult<(BTreeMap<String, RuntimeArtifactFile>, ArchiveIndex)> {
    check()?;
    let length = reader
        .seek(SeekFrom::End(0))
        .map_err(|_| HostError::CaptureFailed)?;
    check()?;
    if length > profile.max_encoded() as u64 {
        return Err(HostError::PackageLimit);
    }
    if length < 1024 || length % 512 != 0 {
        return Err(HostError::CaptureFailed);
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| HostError::CaptureFailed)?;
    let failure = Cell::new(None);
    let checked = CheckedReader {
        inner: reader,
        check,
        failure: &failure,
    };
    let mut archive = Archive::new(checked);
    let mut files = BTreeMap::new();
    let mut namespace = Namespace::new(profile);
    let mut pending_path = None;
    let mut index = ArchiveIndex {
        manifest: None,
        file_count: 0,
        byte_count: 0,
    };
    let mut manifest_seen = false;
    let mut padding = Vec::new();
    let mut end = 0u64;
    for (ordinal, entry) in archive
        .entries_with_seek()
        .map_err(|_| failure.get().unwrap_or(HostError::CaptureFailed))?
        .raw(true)
        .enumerate()
    {
        check()?;
        if ordinal >= 2 * profile.max_files() {
            return Err(HostError::PackageLimit);
        }
        let mut entry = entry.map_err(|_| failure.get().unwrap_or(HostError::CaptureFailed))?;
        if entry.raw_header_position() != end {
            return Err(HostError::CaptureFailed);
        }
        let header = entry.header();
        let ustar = header.as_ustar().ok_or(HostError::PackagePath)?;
        field(&ustar.name)?;
        field(&ustar.prefix)?;
        if !field(&ustar.linkname)?.is_empty() {
            return Err(HostError::PackagePath);
        }
        let size = usize::try_from(entry.size()).map_err(|_| HostError::PackageLimit)?;
        let payload = entry.raw_file_position();
        end = payload
            .checked_add(
                (size as u64)
                    .div_ceil(512)
                    .checked_mul(512)
                    .ok_or(HostError::PackageLimit)?,
            )
            .ok_or(HostError::PackageLimit)?;
        if end > length - 1024 {
            return Err(HostError::CaptureFailed);
        }
        padding.push((payload + size as u64, end));
        match header.entry_type() {
            EntryType::XHeader => {
                if pending_path.is_some() || size > 2048 {
                    return Err(HostError::PackagePath);
                }
                let pax = read_contents(&mut entry, size, check, &failure)?;
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
        if profile == Profile::Package && path == "manifest.json" && mode & 0o111 != 0 {
            return Err(HostError::PackagePath);
        }
        namespace.admit(&path)?;
        let is_manifest = profile == Profile::Package && path == "manifest.json";
        manifest_seen |= is_manifest;
        index.file_count += 1;
        index.byte_count = index
            .byte_count
            .checked_add(size)
            .ok_or(HostError::PackageLimit)?;
        if index.file_count > max_files || index.byte_count > max_bytes {
            return Err(HostError::PackageLimit);
        }
        if is_manifest && size > MAX_MANIFEST_BYTES {
            return Err(HostError::PackageLimit);
        }
        if bodies == Bodies::Capture || (is_manifest && bodies == Bodies::PackageManifest) {
            let contents = read_contents(&mut entry, size, check, &failure)?;
            if bodies == Bodies::Capture {
                files.insert(
                    path,
                    RuntimeArtifactFile {
                        bytes: contents,
                        executable: mode & 0o111 != 0,
                    },
                );
            } else {
                index.manifest = Some(contents);
            }
        }
    }
    if pending_path.is_some() {
        return Err(HostError::PackagePath);
    }
    // The tar iterator normally stops at the first zero header. Require both
    // terminators and only zero padding, rejecting concatenated/trailing input.
    if length - end < 1024 {
        return Err(HostError::CaptureFailed);
    }
    let mut checked = archive.into_inner();
    for (start, finish) in padding {
        zero_range(&mut checked, start, finish - start, check, &failure)?;
    }
    zero_range(&mut checked, end, length - end, check, &failure)?;
    if profile == Profile::Package && !manifest_seen {
        return Err(HostError::MissingArtifact);
    }
    if index.file_count == 0 {
        return Err(HostError::MissingArtifact);
    }
    check()?;
    Ok((files, index))
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

    #[test]
    fn encoding_is_deterministic_and_round_trips_long_paths_binary_and_flags() {
        let path = format!("data/{}.bin", "a".repeat(160));
        let files = BTreeMap::from([
            (
                path.clone(),
                RuntimeArtifactFile {
                    bytes: vec![0, 255, 13, 10],
                    executable: true,
                },
            ),
            (
                "read-only.exe".into(),
                RuntimeArtifactFile {
                    bytes: b"data".to_vec(),
                    executable: false,
                },
            ),
        ]);
        let encoded = encode_files(b"{}", &files, || Ok(())).unwrap();
        assert_eq!(encoded, encode_files(b"{}", &files, || Ok(())).unwrap());
        let captured = read(&encoded).unwrap();
        assert_eq!(captured[&path].bytes, files[&path].bytes);
        assert!(captured[&path].executable);
        assert!(!captured["read-only.exe"].executable);
        let mut archive = Archive::new(encoded.as_slice());
        assert!(
            archive
                .entries()
                .unwrap()
                .raw(true)
                .any(|entry| entry.unwrap().header().entry_type() == EntryType::XHeader)
        );
    }

    #[test]
    fn encoder_preserves_mid_file_authority_and_timeout_failures() {
        let files = BTreeMap::from([(
            "data.bin".into(),
            RuntimeArtifactFile {
                bytes: vec![0; 128 * 1024],
                executable: false,
            },
        )]);
        for error in [HostError::AuthorityRevoked, HostError::Timeout] {
            let calls = Cell::new(0);
            let result = encode_files(b"{}", &files, || {
                calls.set(calls.get() + 1);
                if calls.get() > 8 { Err(error) } else { Ok(()) }
            });
            assert_eq!(result.err(), Some(error));
        }
    }

    #[test]
    fn encoder_and_decoder_share_namespace_and_materialization_bounds() {
        for paths in [
            ["A/x", "a/y"],
            ["manifest.json", "data"],
            ["data", "data/x"],
        ] {
            let files = paths
                .into_iter()
                .map(|path| {
                    (
                        path.to_owned(),
                        RuntimeArtifactFile {
                            bytes: b"data".to_vec(),
                            executable: false,
                        },
                    )
                })
                .collect();
            assert_eq!(
                encode_files(b"{}", &files, || Ok(())).err(),
                Some(HostError::PackagePath)
            );
        }
        let path = format!("{}file", "directory/".repeat(MAX_DEPTH + 1));
        let files = BTreeMap::from([(
            path,
            RuntimeArtifactFile {
                bytes: b"data".to_vec(),
                executable: false,
            },
        )]);
        assert_eq!(
            encode_files(b"{}", &files, || Ok(())).err(),
            Some(HostError::PackageLimit)
        );
    }

    struct BoundaryReader {
        cursor: Cursor<Vec<u8>>,
        forbidden: Vec<std::ops::Range<u64>>,
        reads: Vec<std::ops::Range<u64>>,
    }

    impl BoundaryReader {
        fn new(bytes: Vec<u8>, forbid_manifest: bool) -> Self {
            let mut archive = Archive::new(bytes.as_slice());
            let forbidden = archive
                .entries()
                .unwrap()
                .raw(true)
                .filter_map(|entry| {
                    let entry = entry.unwrap();
                    if entry.header().entry_type() != EntryType::Regular
                        || (!forbid_manifest
                            && &entry.header().path_bytes()[..] == b"manifest.json")
                    {
                        return None;
                    }
                    let start = entry.raw_file_position();
                    Some(start..start + entry.size())
                })
                .collect();
            drop(archive);
            Self {
                cursor: Cursor::new(bytes),
                forbidden,
                reads: Vec::new(),
            }
        }
    }

    impl Read for BoundaryReader {
        fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
            if output.is_empty() {
                return Ok(0);
            }
            let start = self.cursor.position();
            let available = (self.cursor.get_ref().len() as u64).saturating_sub(start);
            let end = start + available.min(output.len() as u64);
            if self
                .forbidden
                .iter()
                .any(|range| start < range.end && range.start < end)
            {
                return Err(std::io::Error::other("ordinary artifact body was read"));
            }
            self.reads.push(start..end);
            self.cursor.read(output)
        }
    }

    impl Seek for BoundaryReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.cursor.seek(position)
        }
    }

    #[test]
    fn runtime_index_seeks_every_body_including_an_executable_manifest() {
        let files = BTreeMap::from([
            (
                "manifest.json".into(),
                RuntimeArtifactFile {
                    bytes: b"ordinary runtime data".to_vec(),
                    executable: true,
                },
            ),
            (
                "data.exe".into(),
                RuntimeArtifactFile {
                    bytes: vec![1; 128 * 1024],
                    executable: false,
                },
            ),
        ]);
        let bytes = encode_runtime_files(&files, || Ok(())).unwrap();
        let mut reader = BoundaryReader::new(bytes.clone(), true);
        let index = inspect_reader(&mut reader, Profile::Runtime, || Ok(())).unwrap();
        assert!(index.manifest.is_none());
        assert_eq!(index.file_count, 2);
        assert_eq!(
            index.byte_count,
            files.values().map(|file| file.bytes.len()).sum::<usize>()
        );
        assert!(capture_reader(&mut reader, Profile::Runtime, || Ok(())).is_err());
        let captured =
            capture_reader(&mut Cursor::new(bytes), Profile::Runtime, || Ok(())).unwrap();
        assert_eq!(
            tsumugi_plugin_sdk::runtime_artifact_digest(&captured).unwrap(),
            tsumugi_plugin_sdk::runtime_artifact_digest(&files).unwrap(),
        );
        assert!(captured["manifest.json"].executable);
        assert!(!captured["data.exe"].executable);
    }

    #[test]
    fn package_index_reads_only_manifest_and_recovery_index_skips_it() {
        let long_path = format!("data/{}.bin", "x".repeat(160));
        let files = BTreeMap::from([(
            long_path,
            RuntimeArtifactFile {
                bytes: vec![3; 128 * 1024],
                executable: true,
            },
        )]);
        let bytes = encode_files(b"{\"metadata\":true}", &files, || Ok(())).unwrap();
        let mut reader = BoundaryReader::new(bytes.clone(), false);
        let index = inspect_reader(&mut reader, Profile::Package, || Ok(())).unwrap();
        assert_eq!(
            index.manifest.as_deref(),
            Some(b"{\"metadata\":true}".as_slice())
        );
        assert_eq!(index.file_count, 2);
        let mut recovery = BoundaryReader::new(bytes.clone(), true);
        let recovered_index = inspect_headers(&mut recovery, Profile::Package, || Ok(())).unwrap();
        assert!(recovered_index.manifest.is_none());
        assert_eq!(recovered_index.byte_count, index.byte_count);
        assert!(inspect_reader(&mut recovery, Profile::Package, || Ok(())).is_err());
        assert!(capture_reader(&mut reader, Profile::Package, || Ok(())).is_err());
    }

    #[test]
    fn every_index_mode_retains_strict_header_padding_tail_and_authority_checks() {
        let valid = encoded(&[
            ("manifest.json", 0o644, EntryType::Regular, b"{}"),
            ("file", 0o644, EntryType::Regular, b"data"),
        ]);
        let link = encoded(&[
            ("manifest.json", 0o644, EntryType::Regular, b"{}"),
            ("file", 0o644, EntryType::Symlink, b""),
        ]);
        let alias = encoded(&[
            ("manifest.json", 0o644, EntryType::Regular, b"{}"),
            ("A/x", 0o644, EntryType::Regular, b""),
            ("a/y", 0o644, EntryType::Regular, b""),
        ]);
        let mut padding = valid.clone();
        padding[514] = 1;
        let mut trailing = valid.clone();
        trailing.extend_from_slice(&[1; 512]);
        for profile in [Profile::Package, Profile::Runtime] {
            for bytes in [
                &valid[..valid.len() - 512],
                &link,
                &alias,
                &padding,
                &trailing,
            ] {
                assert!(inspect_reader(&mut Cursor::new(bytes), profile, || Ok(())).is_err());
                assert!(inspect_headers(&mut Cursor::new(bytes), profile, || Ok(())).is_err());
            }
            let calls = Cell::new(0);
            let result = inspect_headers(&mut Cursor::new(&valid), profile, || {
                calls.set(calls.get() + 1);
                if calls.get() > 5 {
                    Err(HostError::AuthorityRevoked)
                } else {
                    Ok(())
                }
            });
            assert_eq!(result.err(), Some(HostError::AuthorityRevoked));
        }
        let missing = encoded(&[("data", 0o644, EntryType::Regular, b"")]);
        assert_eq!(
            inspect_headers(&mut Cursor::new(missing), Profile::Package, || Ok(())).err(),
            Some(HostError::MissingArtifact),
        );
    }

    #[test]
    fn runtime_profile_keeps_its_own_depth_file_and_directory_limits() {
        let path = format!("{}file", "directory/".repeat(32));
        let mut files = BTreeMap::from([(
            path,
            RuntimeArtifactFile {
                bytes: vec![],
                executable: false,
            },
        )]);
        for ordinal in 0..MAX_FILES + 1 {
            files.insert(
                format!("file-{ordinal}"),
                RuntimeArtifactFile {
                    bytes: vec![],
                    executable: false,
                },
            );
        }
        let bytes = encode_runtime_files(&files, || Ok(())).unwrap();
        let index = inspect_headers(&mut Cursor::new(bytes), Profile::Runtime, || Ok(())).unwrap();
        assert_eq!(index.file_count, MAX_FILES + 2);
        assert_eq!(
            encode_files(b"{}", &files, || Ok(())).err(),
            Some(HostError::PackageLimit)
        );
        files.insert(
            format!("{}file", "other/".repeat(33)),
            RuntimeArtifactFile {
                bytes: vec![],
                executable: false,
            },
        );
        assert_eq!(
            encode_runtime_files(&files, || Ok(())).err(),
            Some(HostError::PackageLimit)
        );

        let directories = (0..1024)
            .map(|ordinal| {
                (
                    format!("directory-{ordinal}/file"),
                    RuntimeArtifactFile {
                        bytes: vec![],
                        executable: false,
                    },
                )
            })
            .collect();
        assert_eq!(
            encode_runtime_files(&directories, || Ok(())).err(),
            Some(HostError::PackageLimit)
        );
    }
}
