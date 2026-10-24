//! Repository metadata uses the same held root and exclusive Store lock as
//! installations. Only opaque, already serialized TUF metadata crosses this
//! boundary; signature and rollback policy remain in the verifier.
use super::super::repository::{
    FORMAT_VERSION, MAX_INPUT_BYTES, MAX_REQUEST_BYTES, MAX_STATE_BYTES, ROOT_ROTATION_CONTEXT,
    StoredRequest, TrustState, freeze, parse_root, restore, source_directory, validate_cache_entry,
};
use super::*;
use crate::repository::{
    CapturedOfflineRepository, RepositoryError, RepositoryResult, RepositoryStorageFuture,
    RepositoryTrustStorage, VerifiedOfflineRepository,
};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tough::schema::Role;

const NAMESPACE: &str = "repositories";
const REQUEST: &str = "request.json";
const INPUT: &str = "input.bin";
const STATE: &str = "state.json";
const NEXT: &str = "progress.next";
const CANDIDATE_PREFIX: &str = ".candidate-";
type Authority = Arc<dyn Fn() -> bool + Send + Sync>;

fn with_deadline<T>(
    authorized: Authority,
    operation: impl FnOnce(Authority) -> InstallResult<T>,
) -> InstallResult<T> {
    let deadline = Instant::now() + OPERATION_TIMEOUT;
    let timed_out = Arc::new(AtomicBool::new(false));
    let observed = timed_out.clone();
    let checked: Authority = Arc::new(move || {
        if !authorized() {
            return false;
        }
        if Instant::now() >= deadline {
            observed.store(true, Ordering::Release);
            return false;
        }
        true
    });
    let result = operation(checked);
    if matches!(
        &result,
        Err(InstallError::UnknownCommit
            | InstallError::Repository(RepositoryError::WorkingStateOutcomeUnknown))
    ) {
        return result;
    }
    if timed_out.load(Ordering::Acquire) {
        return Err(InstallError::Host(HostError::Timeout));
    }
    result
}

struct Action {
    name: String,
    directory: File,
    request: StoredRequest,
    request_bytes: Vec<u8>,
    state: TrustState,
    state_bytes: Vec<u8>,
    candidate: bool,
    next: bool,
}

struct Source {
    name: String,
    directory: File,
    actions: Vec<ActionSummary>,
    latest: Option<Action>,
    initial_root_fingerprint: Option<String>,
}

struct ActionSummary {
    action_id: String,
    revision: u64,
    complete: bool,
    candidate: bool,
    next: bool,
    root_version: u64,
    root_content_digest: Vec<u8>,
}

fn clone_file(file: &File) -> InstallResult<File> {
    file.try_clone().map_err(|_| InstallError::Io)
}

fn json<T: Serialize>(value: &T, limit: usize) -> InstallResult<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| InstallError::CorruptStore)?;
    if bytes.len() > limit {
        return Err(InstallError::LimitExceeded);
    }
    Ok(bytes)
}

fn optional_directory(parent: &File, name: &str) -> InstallResult<Option<File>> {
    filesystem::open_optional_directory(parent, OsStr::new(name))
        .map_err(|_| InstallError::CorruptStore)
}

fn optional_file(parent: &File, name: &str) -> InstallResult<Option<File>> {
    filesystem::open_optional_file(parent, OsStr::new(name)).map_err(|_| InstallError::CorruptStore)
}

fn required_file(parent: &File, name: &str, limit: usize) -> InstallResult<(File, Vec<u8>)> {
    let file = optional_file(parent, name)?.ok_or(InstallError::CorruptStore)?;
    let bytes = read_immutable(&file, limit, InstallError::CorruptStore)?;
    Ok((file, bytes))
}

fn names(
    parent: &File,
    limit: usize,
    check: &impl Fn() -> InstallResult<()>,
) -> InstallResult<Vec<String>> {
    check()?;
    let before = Stamp::read(parent)?;
    let failure = Cell::new(None);
    let result = filesystem::directory_names(
        parent,
        || {
            check().map_err(|error| {
                failure.set(Some(error));
                HostError::AuthorityRevoked
            })
        },
        limit,
    );
    let result = result.map_err(|error| {
        failure
            .get()
            .unwrap_or(if error == HostError::PackageLimit {
                InstallError::LimitExceeded
            } else {
                InstallError::CorruptStore
            })
    })?;
    unchanged(parent, &before)?;
    check()?;
    Ok(result)
}

fn read_action(directory: File, name: String, candidate: bool) -> InstallResult<Option<Action>> {
    private(&directory, true, 0o700)?;
    let entries = names(&directory, 4, &|| private(&directory, true, 0o700))?;
    if entries
        .iter()
        .any(|entry| ![INPUT, REQUEST, STATE, NEXT].contains(&entry.as_str()))
    {
        return Err(InstallError::CorruptStore);
    }
    let Some(state_file) = optional_file(&directory, STATE)? else {
        // No metadata operation can start before a complete initial envelope
        // is promoted. An interrupted unpublished preparation has no authority.
        return if candidate {
            Ok(None)
        } else {
            Err(InstallError::CorruptStore)
        };
    };
    if candidate && permission_mode(&state_file)? == 0o600 {
        private(&state_file, false, 0o600)?;
        return Ok(None);
    }
    let state_bytes = read_immutable(&state_file, MAX_STATE_BYTES, InstallError::CorruptStore)?;
    let (_, request_bytes) = required_file(&directory, REQUEST, MAX_REQUEST_BYTES)?;
    let request: StoredRequest =
        serde_json::from_slice(&request_bytes).map_err(|_| InstallError::CorruptStore)?;
    request
        .request
        .validate()
        .map_err(|_| InstallError::CorruptStore)?;
    if request.format_version != FORMAT_VERSION
        || !valid_digest(&request.input_digest)
        || request.request.action_id != name.strip_prefix(CANDIDATE_PREFIX).unwrap_or(&name)
    {
        return Err(InstallError::CorruptStore);
    }
    let state: TrustState =
        serde_json::from_slice(&state_bytes).map_err(|_| InstallError::CorruptStore)?;
    state.validate(&request)?;
    let input = optional_file(&directory, INPUT)?.ok_or(InstallError::CorruptStore)?;
    private(&input, false, 0o400)?;
    if Stamp::read(&input)?.length > MAX_INPUT_BYTES as u64 {
        return Err(InstallError::CorruptStore);
    }
    let next = optional_file(&directory, NEXT)?.is_some();
    Ok(Some(Action {
        name,
        directory,
        request,
        request_bytes,
        state,
        state_bytes,
        candidate,
        next,
    }))
}

impl Store {
    fn repository_inventory(
        &self,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<(Option<File>, Vec<Source>, usize)> {
        self.check(authorized)?;
        let Some(namespace) = optional_directory(&self.root, NAMESPACE)? else {
            return Ok((None, Vec::new(), 0));
        };
        private(&namespace, true, 0o700)?;
        let namespace_id = filesystem::identity(&namespace)?;
        let check = || {
            self.check(authorized)?;
            private(&namespace, true, 0o700)?;
            same_file(&self.root, OsStr::new(NAMESPACE), true, namespace_id)
        };
        let mut result = Vec::new();
        let mut count = 0usize;
        let mut actions = BTreeSet::new();
        for name in names(&namespace, MAX_REPOSITORY_SOURCES, &check)? {
            if !valid_digest(&name) {
                return Err(InstallError::CorruptStore);
            }
            let directory = filesystem::open_child(&namespace, OsStr::new(&name), true)?;
            private(&directory, true, 0o700)?;
            let id = filesystem::identity(&directory)?;
            let source_check = || {
                check()?;
                private(&directory, true, 0o700)?;
                same_file(&namespace, OsStr::new(&name), true, id)
            };
            let mut source = Source {
                name: name.clone(),
                directory: clone_file(&directory)?,
                actions: Vec::new(),
                latest: None,
                initial_root_fingerprint: None,
            };
            for action_name in names(&directory, MAX_REPOSITORY_TRUST_ACTIONS * 2, &source_check)? {
                count += 1;
                if count > MAX_REPOSITORY_TRUST_ACTIONS * 2 {
                    return Err(InstallError::LimitExceeded);
                }
                let candidate = action_name.starts_with(CANDIDATE_PREFIX);
                let action_id = action_name
                    .strip_prefix(CANDIDATE_PREFIX)
                    .unwrap_or(&action_name);
                validate_action(action_id).map_err(|_| InstallError::CorruptStore)?;
                let action_dir =
                    filesystem::open_child(&directory, OsStr::new(&action_name), true)?;
                if let Some(action) = read_action(action_dir, action_name, candidate)? {
                    if source_directory(&action.request.request.source_id)? != source.name
                        || !actions.insert(action.request.request.action_id.clone())
                    {
                        return Err(InstallError::CorruptStore);
                    }
                    let root = parse_root(&action.state.latest_root)?;
                    source.actions.push(ActionSummary {
                        action_id: action.request.request.action_id.clone(),
                        revision: action.state.revision,
                        complete: action.state.complete,
                        candidate: action.candidate,
                        next: action.next,
                        root_version: root.signed.version.get(),
                        root_content_digest: Sha256::digest(
                            root.signed
                                .canonical_form()
                                .map_err(|_| InstallError::CorruptStore)?,
                        )
                        .to_vec(),
                    });
                    if action.request.request.expected_revision == 0 {
                        source.initial_root_fingerprint = Some(format!(
                            "{:x}",
                            Sha256::digest(&action.request.request.initial_root)
                        ));
                    }
                    // Retain only one full cache per source. Historical
                    // envelopes are checked one at a time, rather than loading
                    // every retained role generation into memory together.
                    if source
                        .latest
                        .as_ref()
                        .is_none_or(|latest| action.state.revision > latest.state.revision)
                    {
                        source.latest = Some(action);
                    }
                }
                source_check()?;
            }
            source.actions.sort_by_key(|action| action.revision);
            for (index, action) in source.actions.iter().enumerate() {
                if action.revision != index as u64 + 1
                    || (index + 1 < source.actions.len()
                        && (!action.complete || action.next || action.candidate))
                {
                    return Err(InstallError::CorruptStore);
                }
                if index > 0 {
                    let previous = &source.actions[index - 1];
                    if action.root_version < previous.root_version
                        || (action.root_version == previous.root_version
                            && action.root_content_digest != previous.root_content_digest)
                    {
                        return Err(InstallError::CorruptStore);
                    }
                }
            }
            if source.actions.len() > MAX_REPOSITORY_TRUST_ACTIONS {
                return Err(InstallError::LimitExceeded);
            }
            result.push(source);
        }
        if actions.len() > MAX_REPOSITORY_TRUST_ACTIONS {
            return Err(InstallError::LimitExceeded);
        }
        check()?;
        Ok((Some(namespace), result, count))
    }

    pub(in crate::package::installation) fn repository_sources(
        &self,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<Vec<RepositorySourceRecord>> {
        let guard = OperationGuard::new(authorized);
        let result = (|| {
            let (_, sources, _) = self.repository_inventory(&|| guard.allowed())?;
            let mut records = Vec::new();
            for source in sources {
                let Some(action) = source.latest.as_ref() else {
                    continue;
                };
                let request = &action.request.request;
                let confirmed =
                    self.repository_confirmed.get(&request.source_id) == Some(&request.action_id);
                records.push(RepositorySourceRecord {
                    source_id: request.source_id.clone(),
                    display_name: action.state.display_name.clone(),
                    initial_root_fingerprint: source
                        .initial_root_fingerprint
                        .clone()
                        .ok_or(InstallError::CorruptStore)?,
                    latest_root_version: parse_root(&action.state.latest_root)?
                        .signed
                        .version
                        .get(),
                    revision: action.state.revision,
                    last_action_id: Some(request.action_id.clone()),
                    pending: (!action.state.complete
                        || action.next
                        || action.candidate
                        || !confirmed)
                        .then(|| request.pending()),
                    last_error: action.state.error,
                });
            }
            self.check(&|| guard.allowed())?;
            Ok(records)
        })();
        guard.finish(result)
    }

    pub(in crate::package::installation) fn refresh_repository(
        &mut self,
        request: &RepositoryRefreshRequest,
        captured: &CapturedOfflineRepository,
        authorized: Authority,
    ) -> InstallResult<VerifiedOfflineRepository> {
        with_deadline(authorized, |authorized| {
            self.refresh_repository_inner(request, captured, authorized)
        })
    }

    fn refresh_repository_inner(
        &mut self,
        request: &RepositoryRefreshRequest,
        captured: &CapturedOfflineRepository,
        authorized: Authority,
    ) -> InstallResult<VerifiedOfflineRepository> {
        request.validate()?;
        self.check(&|| authorized())?;
        if captured.capture_digest() != request.capture_digest {
            return Err(InstallError::ApprovalMismatch);
        }
        let input = freeze(captured)?;
        self.check(&|| authorized())?;
        let input_digest = format!("{:x}", Sha256::digest(&input));
        let (namespace, sources, directory_count) = self.repository_inventory(&|| authorized())?;
        let source_name = source_directory(&request.source_id)?.to_owned();
        for source in &sources {
            for action in &source.actions {
                if action.action_id == request.action_id {
                    let latest = source.latest.as_ref().ok_or(InstallError::CorruptStore)?;
                    if latest.request.request.action_id != request.action_id {
                        return Err(InstallError::ActionConflict);
                    }
                    if latest.request.request != *request
                        || latest.request.input_digest != input_digest
                    {
                        return Err(InstallError::ActionConflict);
                    }
                    return self.resume_repository_inner(
                        &request.source_id,
                        request.expected_revision,
                        &request.action_id,
                        authorized,
                    );
                }
            }
        }
        let total: usize = sources.iter().map(|source| source.actions.len()).sum();
        if total >= MAX_REPOSITORY_TRUST_ACTIONS {
            return Err(InstallError::LimitExceeded);
        }
        let previous = sources.iter().find(|source| source.name == source_name);
        if let Some(source) = &previous {
            if let Some(action) = source.latest.as_ref() {
                if !action.state.complete
                    || action.next
                    || action.candidate
                    || self.repository_confirmed.get(&request.source_id)
                        != Some(&action.request.request.action_id)
                {
                    return Err(InstallError::RecoveryRequired);
                }
                if action.state.revision != request.expected_revision {
                    return Err(InstallError::RevisionConflict);
                }
            } else if request.expected_revision != 0 {
                return Err(InstallError::RevisionConflict);
            }
        } else if request.expected_revision != 0 {
            return Err(InstallError::RevisionConflict);
        }
        let (latest_root, cache, display_name) = previous
            .as_ref()
            .and_then(|source| source.latest.as_ref())
            .map(|action| {
                (
                    action.state.latest_root.clone(),
                    action.state.cache.clone(),
                    action.state.display_name.clone(),
                )
            })
            .unwrap_or_else(|| (request.initial_root.clone(), BTreeMap::new(), None));
        let namespace = match namespace {
            Some(namespace) => namespace,
            None => {
                let namespace = mkdir(&self.root, OsStr::new(NAMESPACE))?;
                self.sync_parents(&namespace, &|| authorized())?;
                namespace
            }
        };
        let source = if let Some(source) = previous {
            clone_file(&source.directory)?
        } else {
            if sources.len() >= MAX_REPOSITORY_SOURCES {
                return Err(InstallError::LimitExceeded);
            }
            let directory = mkdir(&namespace, OsStr::new(&source_name))?;
            sync(&directory)?;
            sync(&namespace)?;
            self.sync_parents(&namespace, &|| authorized())?;
            directory
        };
        let stored = StoredRequest {
            format_version: FORMAT_VERSION,
            request: request.clone(),
            input_digest,
        };
        let state = TrustState {
            format_version: FORMAT_VERSION,
            revision: request.expected_revision + 1,
            source_id: request.source_id.clone(),
            action_id: request.action_id.clone(),
            input_digest: stored.input_digest.clone(),
            latest_root,
            display_name,
            cache,
            complete: false,
            error: None,
        };
        state.validate(&stored)?;
        let candidate_name = format!("{CANDIDATE_PREFIX}{}", request.action_id);
        // Only an unpublished, incomplete preparation of this exact action may
        // be discarded. Promoted or complete candidates always go through resume.
        if let Some(partial) = optional_directory(&source, &candidate_name)? {
            if read_action(clone_file(&partial)?, candidate_name.clone(), true)?.is_some() {
                return Err(InstallError::RecoveryRequired);
            }
            self.remove_repository_preparation(
                &namespace,
                &source,
                &source_name,
                &partial,
                &candidate_name,
                &authorized,
            )?;
        } else if directory_count >= MAX_REPOSITORY_TRUST_ACTIONS * 2 {
            return Err(InstallError::LimitExceeded);
        }
        let candidate = mkdir(&source, OsStr::new(&candidate_name))?;
        let candidate_id = filesystem::identity(&candidate)?;
        let check = || {
            self.check(&|| authorized())?;
            same_file(
                &self.root,
                OsStr::new(NAMESPACE),
                true,
                filesystem::identity(&namespace)?,
            )?;
            same_file(
                &namespace,
                OsStr::new(&source_name),
                true,
                filesystem::identity(&source)?,
            )?;
            same_file(&source, OsStr::new(&candidate_name), true, candidate_id)
        };
        write_new(&candidate, INPUT, &input, &check)?;
        write_new(
            &candidate,
            REQUEST,
            &json(&stored, MAX_REQUEST_BYTES)?,
            &check,
        )?;
        write_new(&candidate, STATE, &json(&state, MAX_STATE_BYTES)?, &check)?;
        sync(&candidate)?;
        check()?;
        sync(&source)?;
        check()?;
        // From this point the complete candidate is a pending action even if
        // rename/fsync has an uncertain outcome. It must never be overwritten.
        promote(
            &source,
            OsStr::new(&candidate_name),
            &source,
            OsStr::new(&request.action_id),
        )?;
        self.repository_confirmed.remove(&request.source_id);
        if sync(&source)
            .and_then(|_| sync(&namespace))
            .and_then(|_| self.sync_parents(&namespace, &|| authorized()))
            .is_err()
        {
            return Err(InstallError::UnknownCommit);
        }
        self.resume_repository_inner(
            &request.source_id,
            request.expected_revision,
            &request.action_id,
            authorized,
        )
    }

    fn remove_repository_preparation(
        &self,
        namespace: &File,
        source: &File,
        source_name: &str,
        candidate: &File,
        candidate_name: &str,
        authorized: &Authority,
    ) -> InstallResult<()> {
        let candidate_id = filesystem::identity(candidate)?;
        let check = || {
            self.check(&|| authorized())?;
            same_file(
                &self.root,
                OsStr::new(NAMESPACE),
                true,
                filesystem::identity(namespace)?,
            )?;
            same_file(
                namespace,
                OsStr::new(source_name),
                true,
                filesystem::identity(source)?,
            )?;
            same_file(source, OsStr::new(candidate_name), true, candidate_id)
        };
        for name in names(candidate, 3, &check)? {
            if ![INPUT, REQUEST, STATE].contains(&name.as_str()) {
                return Err(InstallError::CorruptStore);
            }
            let file = optional_file(candidate, &name)?.ok_or(InstallError::StoreChanged)?;
            let mode = permission_mode(&file)?;
            if mode != 0o400 && mode != 0o600 {
                return Err(InstallError::CorruptStore);
            }
            private(&file, false, mode)?;
            check()?;
            filesystem::remove_child(candidate, OsStr::new(&name), false)
                .map_err(|_| InstallError::Io)?;
        }
        check()?;
        filesystem::remove_child(source, OsStr::new(candidate_name), true)
            .map_err(|_| InstallError::Io)?;
        sync(source)?;
        self.check(&|| authorized())
    }

    pub(in crate::package::installation) fn resume_repository(
        &mut self,
        source_id: &str,
        expected_revision: u64,
        action_id: &str,
        authorized: Authority,
    ) -> InstallResult<VerifiedOfflineRepository> {
        with_deadline(authorized, |authorized| {
            self.resume_repository_inner(source_id, expected_revision, action_id, authorized)
        })
    }

    fn resume_repository_inner(
        &mut self,
        source_id: &str,
        expected_revision: u64,
        action_id: &str,
        authorized: Authority,
    ) -> InstallResult<VerifiedOfflineRepository> {
        validate_action(action_id)?;
        let source_name = source_directory(source_id)?;
        let (namespace, sources, _) = self.repository_inventory(&|| authorized())?;
        let namespace = namespace.ok_or(InstallError::MissingPackage)?;
        let mut source = sources
            .into_iter()
            .find(|source| source.name == source_name)
            .ok_or(InstallError::MissingPackage)?;
        let action = source.latest.take().ok_or(InstallError::MissingPackage)?;
        if action.request.request.action_id != action_id {
            return Err(InstallError::ActionConflict);
        }
        if action.request.request.expected_revision != expected_revision {
            return Err(InstallError::RevisionConflict);
        }
        self.repository_confirmed.remove(source_id);
        let action = if action.candidate {
            promote(
                &source.directory,
                OsStr::new(&action.name),
                &source.directory,
                OsStr::new(action_id),
            )?;
            sync(&source.directory).map_err(|_| InstallError::UnknownCommit)?;
            Action {
                name: action_id.into(),
                candidate: false,
                ..action
            }
        } else {
            action
        };
        let capability = Arc::new(Capability::new(
            self,
            namespace,
            source.directory,
            source_name,
            action,
            authorized.clone(),
        )?);
        capability.reconcile()?;
        let (request, state) = capability.snapshot()?;
        let (_, input) = required_file(&capability.action, INPUT, MAX_INPUT_BYTES)?;
        let captured = restore(&input, &request, || authorized())?;
        capability.confirm()?;
        if state.complete {
            if let Some(error) = state.error {
                self.repository_confirmed
                    .insert(source_id.into(), action_id.into());
                return Err(InstallError::Repository(error));
            }
            // Reissuing a witness is an explicitly authorized trust mutation:
            // even a completed action must retain the verifier's newer time
            // sample. Its original complete/error result remains unchanged.
            let result = verify(
                &captured,
                source_id,
                &state.latest_root,
                capability.clone(),
                authorized,
            )?;
            if let Some(error) = capability.failure()? {
                return Err(error);
            }
            capability.confirm()?;
            self.repository_confirmed
                .insert(source_id.into(), action_id.into());
            return result.map_err(InstallError::Repository);
        }
        let result = verify(
            &captured,
            source_id,
            &state.latest_root,
            capability.clone(),
            authorized,
        )?;
        if let Some(error) = capability.failure()? {
            return Err(error);
        }
        match result {
            Ok(verified) => {
                capability.finish(None, Some(&verified.catalog().display_name))?;
                self.repository_confirmed
                    .insert(source_id.into(), action_id.into());
                Ok(verified)
            }
            Err(error) => {
                // Authorization and storage failures leave the original action
                // pending. A deterministic metadata rejection completes it,
                // retaining every earlier successful root/role/time callback.
                if matches!(
                    error,
                    RepositoryError::AuthorityRevoked
                        | RepositoryError::Timeout
                        | RepositoryError::WorkingStateOutcomeUnknown
                        | RepositoryError::WorkingStateUnavailable
                ) {
                    return Err(InstallError::Repository(error));
                }
                capability.finish(Some(error), None)?;
                self.repository_confirmed
                    .insert(source_id.into(), action_id.into());
                Err(InstallError::Repository(error))
            }
        }
    }
}

fn write_new(
    parent: &File,
    name: &str,
    bytes: &[u8],
    check: &impl Fn() -> InstallResult<()>,
) -> InstallResult<()> {
    check()?;
    let mut file = new_file(parent, OsStr::new(name))?;
    let id = filesystem::identity(&file)?;
    for chunk in bytes.chunks(64 * 1024) {
        check()?;
        file.write_all(chunk).map_err(|_| InstallError::Io)?;
    }
    check()?;
    sync(&file)?;
    chmod(&file, 0o400)?;
    sync(&file)?;
    same_file(parent, OsStr::new(name), false, id)?;
    check()
}

struct Working {
    state: TrustState,
    bytes: Vec<u8>,
    failure: Option<InstallError>,
}

// This is an action-scoped capability minted by the one Store owner. Cloned
// descriptors refer to that owner's same held lock, never a second lock/Store.
struct Capability {
    path: PathBuf,
    root: File,
    root_id: Identity,
    lock: File,
    lock_id: Identity,
    namespace: File,
    namespace_id: Identity,
    source: File,
    source_id: Identity,
    source_name: String,
    action: File,
    action_id: Identity,
    action_name: String,
    input: File,
    input_id: Identity,
    input_stamp: Stamp,
    request: StoredRequest,
    request_bytes: Vec<u8>,
    authorized: Authority,
    deadline: Instant,
    working: Mutex<Working>,
}

impl Capability {
    fn new(
        store: &Store,
        namespace: File,
        source: File,
        source_name: &str,
        action: Action,
        authorized: Authority,
    ) -> InstallResult<Self> {
        let input = optional_file(&action.directory, INPUT)?.ok_or(InstallError::CorruptStore)?;
        private(&input, false, 0o400)?;
        let input_id = filesystem::identity(&input)?;
        let input_stamp = Stamp::read(&input)?;
        Ok(Self {
            path: store.path.clone(),
            root: clone_file(&store.root)?,
            root_id: store.root_id,
            lock: clone_file(&store.lock)?,
            lock_id: store.lock_id,
            namespace_id: filesystem::identity(&namespace)?,
            namespace,
            source_id: filesystem::identity(&source)?,
            source,
            source_name: source_name.into(),
            action_id: filesystem::identity(&action.directory)?,
            action: action.directory,
            action_name: action.name,
            input,
            input_id,
            input_stamp,
            request: action.request,
            request_bytes: action.request_bytes,
            authorized,
            deadline: Instant::now() + OPERATION_TIMEOUT,
            working: Mutex::new(Working {
                state: action.state,
                bytes: action.state_bytes,
                failure: None,
            }),
        })
    }

    fn check(&self) -> InstallResult<()> {
        if !(self.authorized)() {
            return Err(InstallError::AuthorityRevoked);
        }
        if Instant::now() >= self.deadline {
            return Err(InstallError::Host(HostError::Timeout));
        }
        private(&self.root, true, 0o700)?;
        private(&self.lock, false, 0o600)?;
        private(&self.namespace, true, 0o700)?;
        private(&self.source, true, 0o700)?;
        private(&self.action, true, 0o700)?;
        same_root(&self.path, self.root_id)?;
        same_file(&self.root, OsStr::new(".lock"), false, self.lock_id)?;
        same_file(&self.root, OsStr::new(NAMESPACE), true, self.namespace_id)?;
        same_file(
            &self.namespace,
            OsStr::new(&self.source_name),
            true,
            self.source_id,
        )?;
        same_file(
            &self.source,
            OsStr::new(&self.action_name),
            true,
            self.action_id,
        )?;
        same_file(&self.action, OsStr::new(INPUT), false, self.input_id)?;
        private(&self.input, false, 0o400)?;
        unchanged(&self.input, &self.input_stamp)?;
        let (_, request) = required_file(&self.action, REQUEST, MAX_REQUEST_BYTES)?;
        if request != self.request_bytes {
            return Err(InstallError::StoreChanged);
        }
        if !(self.authorized)() {
            return Err(InstallError::AuthorityRevoked);
        }
        Ok(())
    }

    fn check_state(&self, working: &Working) -> InstallResult<()> {
        if let Some(error) = working.failure {
            return Err(error);
        }
        self.check()?;
        let (_, bytes) = required_file(&self.action, STATE, MAX_STATE_BYTES)?;
        if bytes != working.bytes {
            return Err(InstallError::StoreChanged);
        }
        Ok(())
    }

    fn sync_chain(&self) -> InstallResult<()> {
        self.check()?;
        for file in [&self.action, &self.source, &self.namespace, &self.root] {
            sync(file)?;
            self.check()?;
        }
        Ok(())
    }

    fn confirm(&self) -> InstallResult<()> {
        let mut working = self
            .working
            .lock()
            .map_err(|_| InstallError::CorruptStore)?;
        let result = (|| {
            self.check_state(&working)?;
            for (name, limit) in [
                (INPUT, MAX_INPUT_BYTES),
                (REQUEST, MAX_REQUEST_BYTES),
                (STATE, MAX_STATE_BYTES),
            ] {
                let file = optional_file(&self.action, name)?.ok_or(InstallError::CorruptStore)?;
                private(&file, false, 0o400)?;
                if Stamp::read(&file)?.length > limit as u64 {
                    return Err(InstallError::CorruptStore);
                }
                sync(&file)?;
                self.check_state(&working)?;
            }
            self.sync_chain()
        })();
        if result.is_err() {
            working.failure = Some(InstallError::UnknownCommit);
            return Err(InstallError::UnknownCommit);
        }
        Ok(())
    }

    fn snapshot(&self) -> InstallResult<(StoredRequest, TrustState)> {
        let working = self
            .working
            .lock()
            .map_err(|_| InstallError::CorruptStore)?;
        self.check_state(&working)?;
        Ok((self.request.clone(), working.state.clone()))
    }

    fn failure(&self) -> InstallResult<Option<InstallError>> {
        Ok(self
            .working
            .lock()
            .map_err(|_| InstallError::CorruptStore)?
            .failure)
    }

    fn reconcile(&self) -> InstallResult<()> {
        let mut working = self
            .working
            .lock()
            .map_err(|_| InstallError::CorruptStore)?;
        self.check_state(&working)?;
        if let Some(next) = optional_file(&self.action, NEXT)? {
            let mode = permission_mode(&next)?;
            if mode == 0o600 {
                // The candidate was never handed to rename. No trusted state
                // could have been acknowledged from its incomplete bytes.
                private(&next, false, 0o600)?;
                self.check_state(&working)?;
                filesystem::remove_child(&self.action, OsStr::new(NEXT), false)
                    .map_err(|_| InstallError::Io)?;
                self.sync_chain().map_err(|_| InstallError::UnknownCommit)?;
            } else {
                let bytes = read_immutable(&next, MAX_STATE_BYTES, InstallError::CorruptStore)?;
                let state: TrustState =
                    serde_json::from_slice(&bytes).map_err(|_| InstallError::CorruptStore)?;
                state.validate(&self.request)?;
                let previous_root = parse_root(&working.state.latest_root)?;
                let next_root = parse_root(&state.latest_root)?;
                if (working.state.complete
                    && (!state.complete
                        || state.error != working.state.error
                        || state.display_name != working.state.display_name))
                    || next_root.signed.version < previous_root.signed.version
                    || (next_root.signed.version == previous_root.signed.version
                        && next_root
                            .signed
                            .canonical_form()
                            .map_err(|_| InstallError::CorruptStore)?
                            != previous_root
                                .signed
                                .canonical_form()
                                .map_err(|_| InstallError::CorruptStore)?)
                {
                    return Err(InstallError::CorruptStore);
                }
                self.check_state(&working)?;
                sync(&next)?;
                self.promote_progress(&mut working, state, bytes)?;
            }
        }
        Ok(())
    }

    fn promote_progress(
        &self,
        working: &mut Working,
        state: TrustState,
        bytes: Vec<u8>,
    ) -> InstallResult<()> {
        if let Err(error) = replace_file(&self.action, OsStr::new(NEXT), OsStr::new(STATE)) {
            working.failure = Some(error);
            return Err(error);
        }
        // Namespace promotion is the point beyond which *every* failure is
        // Unknown, including a revoked authorization or a failed binding check.
        working.state = state;
        working.bytes = bytes;
        if self
            .sync_chain()
            .and_then(|_| self.check_state(working))
            .is_err()
        {
            working.failure = Some(InstallError::UnknownCommit);
            return Err(InstallError::UnknownCommit);
        }
        Ok(())
    }

    fn commit(&self, working: &mut Working, state: TrustState) -> InstallResult<()> {
        self.check_state(working)?;
        state.validate(&self.request)?;
        let bytes = json(&state, MAX_STATE_BYTES)?;
        if optional_file(&self.action, NEXT)?.is_some() {
            return Err(InstallError::RecoveryRequired);
        }
        write_new(&self.action, NEXT, &bytes, &|| self.check_state(working))?;
        self.check_state(working)?;
        self.promote_progress(working, state, bytes)
    }

    fn finish(
        &self,
        error: Option<RepositoryError>,
        display_name: Option<&str>,
    ) -> InstallResult<()> {
        let mut working = self
            .working
            .lock()
            .map_err(|_| InstallError::CorruptStore)?;
        let mut state = working.state.clone();
        state.complete = true;
        state.error = error;
        if let Some(name) = display_name {
            state.display_name = Some(name.into());
        }
        let result = self.commit(&mut working, state);
        if let Err(error) = result {
            working.failure = Some(error);
        }
        result
    }

    fn mutate(&self, key: &str, bytes: Option<&[u8]>) -> InstallResult<()> {
        let mut working = self
            .working
            .lock()
            .map_err(|_| InstallError::CorruptStore)?;
        let result = (|| {
            self.check_state(&working)?;
            if working.state.error.is_some() {
                return Err(InstallError::ActionConflict);
            }
            // Removal validates the key independently of whether it exists.
            if ![
                "root.json",
                "timestamp.json",
                "snapshot.json",
                "targets.json",
                "latest_known_time.json",
                ROOT_ROTATION_CONTEXT,
            ]
            .contains(&key)
            {
                return Err(InstallError::CorruptStore);
            }
            let mut state = working.state.clone();
            if let Some(bytes) = bytes {
                validate_cache_entry(key, bytes)?;
                if key == "root.json" {
                    let previous = parse_root(&state.latest_root)?;
                    let next = parse_root(bytes)?;
                    if next.signed.version < previous.signed.version
                        || (next.signed.version == previous.signed.version
                            && next
                                .signed
                                .canonical_form()
                                .map_err(|_| InstallError::CorruptStore)?
                                != previous
                                    .signed
                                    .canonical_form()
                                    .map_err(|_| InstallError::CorruptStore)?)
                    {
                        return Err(InstallError::CorruptStore);
                    }
                    state.latest_root = bytes.to_vec();
                }
                state.cache.insert(key.into(), bytes.to_vec());
            } else {
                // tough legitimately clears cached root/roles during rotation.
                // The independently retained latest root must survive that gap.
                state.cache.remove(key);
            }
            self.commit(&mut working, state)
        })();
        if let Err(error) = result {
            working.failure = Some(error);
        }
        result
    }
}

fn storage_error(error: InstallError) -> RepositoryError {
    if error == InstallError::UnknownCommit {
        RepositoryError::WorkingStateOutcomeUnknown
    } else {
        RepositoryError::WorkingStateUnavailable
    }
}

impl RepositoryTrustStorage for Capability {
    fn read<'a>(&'a self, key: &'a str) -> RepositoryStorageFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            let mut working = self
                .working
                .lock()
                .map_err(|_| RepositoryError::WorkingStateUnavailable)?;
            if let Err(error) = self.check_state(&working) {
                working.failure = Some(error);
                return Err(storage_error(error));
            }
            if ![
                "root.json",
                "timestamp.json",
                "snapshot.json",
                "targets.json",
                "latest_known_time.json",
                ROOT_ROTATION_CONTEXT,
            ]
            .contains(&key)
            {
                working.failure = Some(InstallError::CorruptStore);
                return Err(RepositoryError::WorkingStateUnavailable);
            }
            Ok(working.state.cache.get(key).cloned())
        })
    }
    fn write<'a>(&'a self, key: &'a str, bytes: &'a [u8]) -> RepositoryStorageFuture<'a, ()> {
        Box::pin(async move { self.mutate(key, Some(bytes)).map_err(storage_error) })
    }
    fn remove<'a>(&'a self, key: &'a str) -> RepositoryStorageFuture<'a, ()> {
        Box::pin(async move { self.mutate(key, None).map_err(storage_error) })
    }
    fn check_durability(&self) -> RepositoryResult<()> {
        let mut working = self
            .working
            .lock()
            .map_err(|_| RepositoryError::WorkingStateUnavailable)?;
        match self.check_state(&working) {
            Ok(()) => Ok(()),
            Err(error) => {
                working.failure = Some(error);
                Err(storage_error(error))
            }
        }
    }
}

fn verify(
    captured: &CapturedOfflineRepository,
    source_id: &str,
    root: &[u8],
    storage: Arc<dyn RepositoryTrustStorage>,
    authorized: Authority,
) -> InstallResult<RepositoryResult<VerifiedOfflineRepository>> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .map_err(|_| InstallError::Io)?;
    Ok(runtime.block_on(captured.verify(source_id, root, storage, move || authorized())))
}
