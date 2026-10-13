//! Session-owned cleanup controls. These lifetime guards grant no execution or
//! installation authority; the original Core ledger and Store remain owners.
use super::*;
use crate::commands::plugins::PluginPackageRequest;
use std::sync::Weak;

const MAX_PACKAGE_CONTROLS: usize = 128;
const MAX_PACKAGE_WORK: usize = 128;

#[derive(Clone)]
pub(super) struct PackageWork(Arc<PackageWorkState>);
pub(super) struct PackageWorkState {
    packages: Vec<PluginPackageRequest>,
    cancellation: Cancellation,
}
impl PackageWorkState {
    pub(super) fn stop(&self) {
        self.cancellation.request();
    }
}
impl PackageWork {
    pub(super) fn check(&self) -> Result<(), CommandError> {
        if self.0.cancellation.is_requested() {
            Err(map_recover(ExecutionError::new(
                ErrorCode::Cancelled,
                "package-work-stopped",
            )))
        } else {
            Ok(())
        }
    }
}
pub(super) struct PackageControl {
    package: PluginPackageRequest,
    token: Option<PackageQuiescence>,
    drained: bool,
    complete: bool,
}
pub(super) struct RetiredQuery {
    package: Option<PluginPackageRequest>,
    pub(super) thread: JoinHandle<()>,
}
impl RetiredQuery {
    pub(super) fn new(job: QueryJob) -> Self {
        Self {
            package: request_package(&job.query.request),
            thread: job.thread,
        }
    }
}
pub(super) fn input_package(input: &FixedInput) -> Option<PluginPackageRequest> {
    input
        .envelope()
        .plugin
        .as_ref()
        .map(|binding| binding_package(binding))
}
fn request_package(request: &DispatchRequest) -> Option<PluginPackageRequest> {
    input_package(&request.input).or_else(|| {
        request
            .originating_service_package()
            .map(|(plugin, digest)| PluginPackageRequest {
                plugin: plugin.clone(),
                package_digest: digest.into(),
            })
    })
}
pub(super) fn binding_package(binding: &PluginExecutionBinding) -> PluginPackageRequest {
    provider_package(&binding.capability.provider)
}
pub(super) fn provider_package(
    provider: &tsumugi_plugin_sdk::ProviderSelectionBinding,
) -> PluginPackageRequest {
    PluginPackageRequest {
        plugin: provider.plugin.clone(),
        package_digest: provider.package_digest.clone(),
    }
}
pub(super) fn matches_input(package: &PluginPackageRequest, input: &FixedInput) -> bool {
    input_package(input).as_ref() == Some(package)
}
fn busy() -> ExecutionError {
    ExecutionError::new(ErrorCode::Busy, "package-lifecycle-active")
}

impl ExecutionHost {
    pub(super) fn package_lifecycle_active(&self) -> bool {
        self.package_controls
            .values()
            .any(|control| !control.complete)
    }
    pub(super) fn package_work_active(&self) -> bool {
        self.package_work
            .iter()
            .any(|work| work.strong_count() != 0)
    }
    pub(super) fn allow_package(
        &self,
        package: &PluginPackageRequest,
    ) -> Result<(), ExecutionError> {
        if self.quiescing
            || self
                .package_controls
                .values()
                .any(|control| !control.complete && control.package == *package)
        {
            Err(busy())
        } else {
            Ok(())
        }
    }
    /// The guard lives through accepted IO and its session continuation, even
    /// if the IPC waiter disappears. Dropping only the waiter cannot drain it.
    pub(super) fn begin_package_work(
        &mut self,
        packages: Vec<PluginPackageRequest>,
    ) -> Result<PackageWork, CommandError> {
        self.allow_mutation()?;
        for package in &packages {
            self.allow_package(package).map_err(map_recover)?;
        }
        self.package_work.retain(|work| work.strong_count() != 0);
        if packages.len() > MAX_PACKAGE_WORK || self.package_work.len() >= MAX_PACKAGE_WORK {
            return Err(map_recover(ExecutionError::new(
                ErrorCode::LimitExceeded,
                "package-work-limit",
            )));
        }
        let work = Arc::new(PackageWorkState {
            packages,
            cancellation: Cancellation::default(),
        });
        self.package_work.push(Arc::downgrade(&work));
        Ok(PackageWork(work))
    }
    pub(super) fn begin_package_cleanup(
        &mut self,
        store: &mut ProjectStore,
        action: ExecutionId,
        package: PluginPackageRequest,
    ) -> Result<(), CommandError> {
        package
            .plugin
            .validate()
            .and_then(|_| tsumugi_plugin_sdk::validate_package_digest(&package.package_digest))
            .map_err(|_| {
                map_recover(ExecutionError::new(
                    ErrorCode::InvalidInput,
                    "package-cleanup",
                ))
            })?;
        if self.quiescing {
            return Err(map_recover(busy()));
        }
        if let Some(control) = self.package_controls.get(&action) {
            if control.package != package {
                return Err(map_recover(ExecutionError::new(
                    ErrorCode::ResultMismatch,
                    "package-cleanup-action",
                )));
            }
            if control.complete || control.drained {
                return Ok(());
            }
        } else {
            self.allow_package(&package).map_err(map_recover)?;
            if self.package_controls.len() >= MAX_PACKAGE_CONTROLS {
                return Err(map_recover(ExecutionError::new(
                    ErrorCode::LimitExceeded,
                    "package-cleanup-limit",
                )));
            }
            // Admission and callback publication are fenced before any fallible
            // Core transition. The same action retains this slot on failure.
            self.package_controls.insert(
                action,
                PackageControl {
                    package: package.clone(),
                    token: None,
                    drained: false,
                    complete: false,
                },
            );
        }
        for work in self
            .package_work
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|work| work.packages.contains(&package))
        {
            work.cancellation.request();
        }
        self.source.stop_package(&package);
        self.tools.stop_package(&package);
        self.release.stop_package(&package);
        self.review.stop_package(&package);
        self.ai.stop_package(&package);
        self.work_plans.stop_package(&package);
        let mut remaining = Vec::new();
        for job in self.queries.drain(..) {
            if request_package(&job.query.request).as_ref() == Some(&package) {
                // No delivery path remains, but the actual thread is still owned.
                self.retired_queries.push(RetiredQuery::new(job));
            } else {
                remaining.push(job);
            }
        }
        self.queries = remaining;
        let token = self
            .runtime
            .begin_package_quiesce(store, action, &package.plugin, &package.package_digest)
            .map_err(map_recover)?;
        self.package_controls
            .get_mut(&action)
            .expect("control inserted")
            .token = Some(token);
        Ok(())
    }
    pub(super) fn finish_package_cleanup(
        &mut self,
        store: &mut ProjectStore,
        action: ExecutionId,
    ) -> Result<(), CommandError> {
        let control = self.package_controls.get(&action).ok_or_else(|| {
            map_recover(ExecutionError::new(
                ErrorCode::InvalidInput,
                "package-cleanup-action",
            ))
        })?;
        if control.complete || control.drained {
            return Ok(());
        }
        let package = control.package.clone();
        // Retrying begin drives the original Core grant/cancellation receipts.
        self.begin_package_cleanup(store, action, package.clone())?;
        self.tick(store)?;
        if self
            .package_work
            .iter()
            .filter_map(Weak::upgrade)
            .any(|work| work.packages.contains(&package))
            || self
                .retired_queries
                .iter()
                .any(|query| query.package.as_ref() == Some(&package))
            || self.review.package_active(&package)
            || self.ai.package_active(&package)
        {
            return Err(map_recover(busy()));
        }
        let token = self.package_controls[&action]
            .token
            .as_ref()
            .expect("begin succeeded");
        self.runtime
            .finish_package_quiesce(store, token)
            .map_err(map_recover)?;
        self.plugin_registrations
            .retain(|binding| binding_package(binding) != package);
        self.package_controls
            .get_mut(&action)
            .expect("control checked")
            .drained = true;
        // Hold admission and project lifecycle until the installation owner has
        // verified the original Store result, including uncertain commit recovery.
        Ok(())
    }
    pub(super) fn complete_package_cleanup_if_present(
        &mut self,
        action: ExecutionId,
        package: &PluginPackageRequest,
    ) -> Result<(), CommandError> {
        if let Some(control) = self.package_controls.get(&action) {
            if control.package != *package {
                return Err(map_recover(ExecutionError::new(
                    ErrorCode::ResultMismatch,
                    "package-cleanup-action",
                )));
            }
            self.complete_package_cleanup(action)?;
        }
        Ok(())
    }
    pub(super) fn complete_package_cleanup(
        &mut self,
        action: ExecutionId,
    ) -> Result<(), CommandError> {
        let control = self.package_controls.get_mut(&action).ok_or_else(|| {
            map_recover(ExecutionError::new(
                ErrorCode::InvalidInput,
                "package-cleanup-action",
            ))
        })?;
        if !control.drained {
            return Err(map_recover(busy()));
        }
        control.complete = true;
        Ok(())
    }
}
