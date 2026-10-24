//! Descriptor-relative retirement with a durable original-action journal.
use super::*;

const NAMESPACE: &str = "uninstalls";

struct Transaction {
    directory: File,
    id: Identity,
    mode: u32,
    receipt_file: File,
    bytes: Vec<u8>,
    receipt: UninstallReceipt,
}

struct Journal {
    directory: File,
    id: Identity,
    entries: Vec<Transaction>,
}

impl Store {
    fn check_journal(
        &self,
        journal: &Journal,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<()> {
        self.check(authorized)?;
        private(&journal.directory, true, 0o700)?;
        same_file(&self.root, OsStr::new(NAMESPACE), true, journal.id)?;
        self.check(authorized)
    }

    fn check_transaction(
        &self,
        journal: &Journal,
        tx: &Transaction,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<()> {
        self.check_journal(journal, authorized)?;
        self.check_envelope(
            &journal.directory,
            &tx.receipt.action_id,
            &tx.directory,
            tx.id,
            tx.mode,
            &tx.receipt_file,
            authorized,
        )?;
        let receipt = filesystem::open_child(&tx.directory, OsStr::new("receipt.json"), false)?;
        if read_receipt(&receipt)? != tx.bytes {
            return Err(InstallError::StoreChanged);
        }
        self.check_journal(journal, authorized)
    }

    fn journal(&self, authorized: &impl Fn() -> bool) -> InstallResult<Option<Journal>> {
        self.check(authorized)?;
        let Some(directory) =
            filesystem::open_optional_directory(&self.root, OsStr::new(NAMESPACE))
                .map_err(|_| InstallError::CorruptStore)?
        else {
            return Ok(None);
        };
        private(&directory, true, 0o700)?;
        let id = filesystem::identity(&directory)?;
        if !same_volume(id, self.root_id) {
            return Err(InstallError::CorruptStore);
        }
        let before = Stamp::read(&directory)?;
        let mut journal = Journal {
            directory,
            id,
            entries: vec![],
        };
        self.check_journal(&journal, authorized)?;
        let names = filesystem::directory_names(
            &journal.directory,
            || {
                self.check_journal(&journal, authorized)
                    .map_err(|_| HostError::AuthorityRevoked)
            },
            MAX_INSTALLED_PACKAGES,
        )?;
        let mut actions = BTreeSet::new();
        for action in names {
            validate_action(&action).map_err(|_| InstallError::CorruptStore)?;
            let directory = filesystem::open_child(&journal.directory, OsStr::new(&action), true)?;
            let names = filesystem::directory_names(
                &directory,
                || {
                    self.check_journal(&journal, authorized)
                        .map_err(|_| HostError::AuthorityRevoked)
                },
                2,
            )?;
            if names != ["receipt.json"] && names != ["object", "receipt.json"] {
                return Err(InstallError::CorruptStore);
            }
            let expected: Vec<_> = names.iter().map(String::as_str).collect();
            let (directory, id, mode, receipt_file, bytes) =
                self.open_envelope(&journal.directory, &action, &expected, authorized)?;
            let receipt: UninstallReceipt =
                serde_json::from_slice(&bytes).map_err(|_| InstallError::CorruptReceipt)?;
            receipt.installation.validate()?;
            let mut approvals = crate::catalog::PackageApprovalIndex::default();
            approvals
                .insert(&receipt.installation.approval())
                .map_err(|_| InstallError::CorruptReceipt)?;
            if receipt.format_version != RECEIPT_VERSION
                || receipt.action_id != action
                || !actions.insert(action)
                || !actions.insert(receipt.installation.action_id.clone())
            {
                return Err(InstallError::CorruptReceipt);
            }
            let tx = Transaction {
                directory,
                id,
                mode,
                receipt_file,
                bytes,
                receipt,
            };
            self.check_transaction(&journal, &tx, authorized)?;
            self.retired_image(&journal, &tx, false, authorized)?;
            journal.entries.push(tx);
        }
        unchanged(&journal.directory, &before)?;
        self.check_journal(&journal, authorized)?;
        Ok(Some(journal))
    }

    // Recovery cache is never registered, enabled, or used as a load fallback.
    // A selected retry verifies all original bytes; ordinary indexing checks
    // strict receipts, ownership, immutable archive bounds and original identities.
    fn retired_image(
        &self,
        journal: &Journal,
        tx: &Transaction,
        capture: bool,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<Option<PackageImage>> {
        self.check_transaction(journal, tx, authorized)?;
        let Some(_object) =
            filesystem::open_optional_directory(&tx.directory, OsStr::new("object"))
                .map_err(|_| InstallError::CorruptStore)?
        else {
            return if tx.mode == 0o500 {
                Err(InstallError::CorruptStore)
            } else {
                Ok(None)
            };
        };
        let (object, object_id, mode, receipt_file, bytes) = self.open_envelope(
            &tx.directory,
            "object",
            &["package.tar", "receipt.json"],
            authorized,
        )?;
        if tx.mode == 0o500 && mode != 0o500 {
            return Err(InstallError::CorruptStore);
        }
        let receipt: InstallReceipt =
            serde_json::from_slice(&bytes).map_err(|_| InstallError::CorruptReceipt)?;
        if receipt != tx.receipt.installation {
            return Err(InstallError::CorruptReceipt);
        }
        let package = filesystem::open_child(&object, OsStr::new("package.tar"), false)?;
        private(&package, false, 0o400)?;
        let package_stamp = Stamp::read(&package)?;
        let package_id = filesystem::identity(&package)?;
        let check = || -> InstallResult<()> {
            self.check_transaction(journal, tx, authorized)?;
            self.check_envelope(
                &tx.directory,
                "object",
                &object,
                object_id,
                mode,
                &receipt_file,
                authorized,
            )?;
            same_file(&object, OsStr::new("package.tar"), false, package_id)?;
            private(&package, false, 0o400)?;
            unchanged(&package, &package_stamp)?;
            let reopened = filesystem::open_child(&object, OsStr::new("receipt.json"), false)?;
            if read_receipt(&reopened)? != bytes {
                return Err(InstallError::StoreChanged);
            }
            Ok(())
        };
        if capture {
            let image = self.read_package_archive(&package, &receipt.package_digest, &check)?;
            let mut catalog = PackageCatalog::new();
            catalog.register(image.clone(), receipt.approval())?;
            check()?;
            Ok(Some(image))
        } else {
            // Retirement indexing preserves its original metadata-only read
            // boundary; payload corruption is checked by the selected retry.
            self.inspect_archive(&package, Profile::Package, false, authorized, &check)?;
            Ok(None)
        }
    }

    pub(super) fn uninstall_actions(
        &self,
        action: &str,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<BTreeSet<String>> {
        let mut seen = BTreeSet::new();
        if let Some(journal) = self.journal(authorized)? {
            for tx in journal.entries {
                if tx.receipt.action_id == action || tx.receipt.installation.action_id == action {
                    return Err(InstallError::ActionConflict);
                }
                if tx.mode != 0o500 {
                    return Err(InstallError::RecoveryRequired);
                }
                seen.insert(tx.receipt.action_id);
                seen.insert(tx.receipt.installation.action_id);
            }
        }
        Ok(seen)
    }

    pub(super) fn check_uninstall_settings(
        &self,
        update: &PluginSettingsUpdate,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<()> {
        if let Some(journal) = self.journal(authorized)? {
            for tx in journal.entries.iter().filter(|tx| tx.mode != 0o500) {
                if update.packages.iter().any(|p| {
                    p.approval.package_digest == tx.receipt.installation.package_digest
                        || p.approval.plugin == tx.receipt.installation.plugin
                }) {
                    return Err(InstallError::RecoveryRequired);
                }
            }
        }
        Ok(())
    }

    pub(super) fn retained_package_origins(
        &self,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<crate::catalog::PackageApprovalIndex> {
        let mut origins = crate::catalog::PackageApprovalIndex::default();
        if let Some(journal) = self.journal(authorized)? {
            for tx in journal.entries {
                // A completed removal retires bytes, not the independently
                // recorded source. Repeated same-origin installations are legal.
                origins
                    .observe_origin(&tx.receipt.installation.approval())
                    .map_err(|_| InstallError::CorruptStore)?;
            }
        }
        Ok(origins)
    }

    pub(super) fn check_uninstall_load(
        &self,
        approval: &PackageApproval,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<()> {
        if let Some(journal) = self.journal(authorized)? {
            if journal.entries.iter().any(|tx| {
                tx.mode != 0o500
                    && tx.receipt.installation.package_digest == approval.package_digest
            }) {
                return Err(InstallError::RecoveryRequired);
            }
        }
        Ok(())
    }

    pub(in super::super) fn uninstallations(
        &self,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<Vec<UninstallRecord>> {
        let guard = OperationGuard::new(authorized);
        guard.finish(self.journal(&|| guard.allowed()).map(|journal| {
            journal.map_or_else(Vec::new, |j| {
                j.entries
                    .into_iter()
                    .map(|tx| UninstallRecord {
                        receipt: tx.receipt,
                        state: if tx.mode == 0o500 {
                            InstalledObjectState::Sealed
                        } else {
                            InstalledObjectState::RecoveryRequired
                        },
                    })
                    .collect()
            })
        }))
    }

    pub(in super::super) fn uninstall(
        &mut self,
        expected: u64,
        action: &str,
        approval: &PackageApproval,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<UninstallReceipt> {
        let guard = OperationGuard::new(authorized);
        guard.finish(self.uninstall_inner(expected, action, approval, &|| guard.allowed()))
    }

    fn uninstall_inner(
        &mut self,
        expected: u64,
        action: &str,
        approval: &PackageApproval,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<UninstallReceipt> {
        self.check(authorized)?;
        let mut index = crate::catalog::PackageApprovalIndex::default();
        index.insert(approval)?;
        if let Some(journal) = self.journal(authorized)? {
            if let Some(tx) = journal
                .entries
                .iter()
                .find(|tx| tx.receipt.action_id == action)
            {
                if tx.receipt.settings_revision != expected
                    || tx.receipt.installation.approval() != *approval
                {
                    return Err(InstallError::ActionConflict);
                }
                if tx.mode == 0o500 {
                    self.retired_image(&journal, tx, true, authorized)?;
                    sync(&tx.directory).map_err(|_| InstallError::UnknownCommit)?;
                    self.sync_parents(&journal.directory, authorized)
                        .map_err(|_| InstallError::UnknownCommit)?;
                    return Ok(tx.receipt.clone());
                }
                return self
                    .finish_uninstall(&journal, tx, authorized)
                    .map_err(|_| InstallError::UnknownCommit);
            }
        }
        // Starting a new action cannot reuse any original install/runtime/
        // removal UUID or advance past another incomplete removal.
        self.runtime_actions(action, authorized)?;
        self.package_actions(action, authorized)?;
        let settings = self.removal_settings(approval, authorized)?;
        if settings.settings.revision() != expected {
            return Err(InstallError::RevisionConflict);
        }
        if !self.names(authorized)?.contains(&approval.package_digest) {
            return Err(InstallError::MissingPackage);
        }
        let object = self.open_object(&approval.package_digest, authorized)?;
        if object.receipt.approval() != *approval {
            return Err(InstallError::ApprovalMismatch);
        }
        if object.directory_mode != 0o500 {
            return Err(InstallError::RecoveryRequired);
        }
        self.capture_object(&approval.package_digest, &object, authorized)?;
        let receipt = UninstallReceipt {
            format_version: RECEIPT_VERSION,
            action_id: action.into(),
            settings_revision: expected,
            installation: object.receipt.clone(),
        };
        let mut journal = match self.journal(authorized)? {
            Some(journal) => journal,
            None => {
                self.check_settings_snapshot(&settings, authorized)?;
                let directory = mkdir(&self.root, OsStr::new(NAMESPACE))?;
                let journal = Journal {
                    id: filesystem::identity(&directory)?,
                    directory,
                    entries: vec![],
                };
                self.check_journal(&journal, authorized)?;
                sync(&journal.directory)?;
                sync(&self.root)?;
                journal
            }
        };
        if journal.entries.len() >= MAX_INSTALLED_PACKAGES {
            return Err(InstallError::LimitExceeded);
        }
        let candidate_name = format!(".candidate-{}", uuid::Uuid::new_v4());
        self.check_settings_snapshot(&settings, authorized)?;
        let candidate = mkdir(&self.root, OsStr::new(&candidate_name))?;
        let candidate_id = filesystem::identity(&candidate)?;
        let bytes = serde_json::to_vec(&receipt).map_err(|_| InstallError::CorruptReceipt)?;
        if bytes.len() > MAX_RECEIPT_BYTES {
            return Err(InstallError::CorruptReceipt);
        }
        self.write_immutable(
            &candidate,
            "receipt.json",
            &bytes,
            &candidate_name,
            candidate_id,
            authorized,
        )?;
        sync(&candidate)?;
        sync(&self.root)?;
        self.check_candidate(&candidate_name, candidate_id, authorized)?;
        self.check_journal(&journal, authorized)?;
        self.check_settings_snapshot(&settings, authorized)?;
        self.check_object(&approval.package_digest, &object, authorized)?;
        promote(
            &self.root,
            OsStr::new(&candidate_name),
            &journal.directory,
            OsStr::new(action),
        )?;
        // An original-action intent is now visible. Every later failure is
        // uncertain; leave all bytes intact and require an exact retry.
        let confirmed = (|| {
            #[cfg(test)]
            if self.fail_commit_checkpoint == Some(CommitCheckpoint::UninstallIntentSync) {
                return Err(InstallError::Io);
            }
            self.sync_parents(&journal.directory, authorized)?;
            journal = self
                .journal(authorized)?
                .ok_or(InstallError::StoreChanged)?;
            let tx = journal
                .entries
                .iter()
                .find(|tx| tx.receipt.action_id == action)
                .ok_or(InstallError::StoreChanged)?;
            self.finish_uninstall(&journal, tx, authorized)
        })();
        confirmed.map_err(|_| InstallError::UnknownCommit)
    }

    fn removal_settings(
        &self,
        approval: &PackageApproval,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<SettingsSnapshot> {
        let settings = self.settings_snapshot(authorized)?;
        if settings.settings.packages.iter().any(|p| {
            p.approval.plugin == approval.plugin
                || p.approval.package_digest == approval.package_digest
        }) {
            return Err(InstallError::Busy);
        }
        Ok(settings)
    }

    fn finish_uninstall(
        &self,
        journal: &Journal,
        tx: &Transaction,
        authorized: &impl Fn() -> bool,
    ) -> InstallResult<UninstallReceipt> {
        let settings = self.removal_settings(&tx.receipt.installation.approval(), authorized)?;
        self.check_transaction(journal, tx, authorized)?;
        let exists = filesystem::open_optional_directory(&tx.directory, OsStr::new("object"))
            .map_err(|_| InstallError::CorruptStore)?
            .is_some();
        if !exists {
            let digest = &tx.receipt.installation.package_digest;
            let object = self.open_object(digest, authorized)?;
            if object.receipt != tx.receipt.installation {
                return Err(InstallError::ActionConflict);
            }
            self.capture_object(digest, &object, authorized)?;
            self.sync_object(&object, authorized)?;
            self.check_settings_snapshot(&settings, authorized)?;
            self.check_transaction(journal, tx, authorized)?;
            self.check_object(digest, &object, authorized)?;
            // macOS can require the moved directory's write permission. Only
            // its envelope changes; all captured content stays immutable.
            chmod(&object.directory, 0o700)?;
            private(&object.directory, true, 0o700)?;
            self.check_settings_snapshot(&settings, authorized)?;
            same_file(&self.objects, OsStr::new(digest), true, object.directory_id)?;
            self.check_transaction(journal, tx, authorized)?;
            promote(
                &self.objects,
                OsStr::new(digest),
                &tx.directory,
                OsStr::new("object"),
            )?;
            #[cfg(test)]
            if self.fail_commit_checkpoint == Some(CommitCheckpoint::UninstallMove) {
                return Err(InstallError::Io);
            }
        }
        self.retired_image(journal, tx, true, authorized)?;
        let object = filesystem::open_child(&tx.directory, OsStr::new("object"), true)?;
        let object_id = filesystem::identity(&object)?;
        self.check_transaction(journal, tx, authorized)?;
        self.check_settings_snapshot(&settings, authorized)?;
        same_file(&tx.directory, OsStr::new("object"), true, object_id)?;
        chmod(&object, 0o500)?;
        private(&object, true, 0o500)?;
        sync(&object)?;
        self.check_transaction(journal, tx, authorized)?;
        self.sync_parents(&self.objects, authorized)?;
        sync(&tx.directory)?;
        #[cfg(test)]
        if self.fail_commit_checkpoint == Some(CommitCheckpoint::UninstallJournalSync) {
            return Err(InstallError::Io);
        }
        self.sync_parents(&journal.directory, authorized)?;
        self.check_settings_snapshot(&settings, authorized)?;
        self.check_transaction(journal, tx, authorized)?;
        let mut mode = tx.mode;
        self.seal_wrapper(&tx.directory, &mut mode, authorized)?;
        self.sync_parents(&journal.directory, authorized)?;
        let current = self
            .journal(authorized)?
            .ok_or(InstallError::StoreChanged)?;
        let confirmed = current
            .entries
            .iter()
            .find(|t| t.receipt == tx.receipt)
            .ok_or(InstallError::StoreChanged)?;
        if confirmed.mode != 0o500 {
            return Err(InstallError::RecoveryRequired);
        }
        self.retired_image(&current, confirmed, true, authorized)?;
        self.check_settings_snapshot(&settings, authorized)?;
        Ok(tx.receipt.clone())
    }
}
