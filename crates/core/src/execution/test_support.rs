//! Synthetic operations compiled only for an explicitly selected test host.
use super::*;
use crate::ProjectStore;
use serde_json::json;
use std::time::Duration;

pub const TARGET_SCHEMA: &str = "CREATE TABLE fixture_targets(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)";

/// One-shot native acceptance barriers, available only in the explicit test host.
/// A competing source uses the ordinary fixed runner and atomic adoption path.
pub fn source_fixture_hook(store: &mut ProjectStore, stage: &str) -> Result<(), ExecutionError> {
    let executable = std::env::current_exe()
        .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "fixture-control"))?;
    let directory = executable
        .parent()
        .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "fixture-control"))?
        .join("source-fixture-control");
    let control = directory.join(format!("{stage}.json"));
    if !control.is_file() {
        return Ok(());
    }
    let settings: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&control)
            .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "fixture-control"))?,
    )
    .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "fixture-control"))?;
    std::fs::rename(&control, directory.join(format!("{stage}.consumed")))
        .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "fixture-control"))?;
    if settings["wait"].as_bool() == Some(true) {
        let reached = directory.join(format!("{stage}.reached"));
        std::fs::write(reached, stage)
            .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "fixture-control"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while !directory.join(format!("{stage}.release")).is_file() {
            if std::time::Instant::now() > deadline {
                return Err(ExecutionError::new(ErrorCode::Busy, "fixture-timeout"));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    if let Some(bundle) = settings.get("source") {
        let text = |field: &str| {
            bundle[field]
                .as_str()
                .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "fixture-source"))
        };
        let bundle = crate::content::SourceBundle::capture(
            text("manifest")?.as_bytes(),
            text("strings")?.as_bytes(),
            text("language")?,
        )?;
        let input = bundle.fixed_input(
            store
                .metadata()
                .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "fixture-source"))?
                .project_id(),
        )?;
        let mut runtime = ExecutionRuntime::new(store)?;
        runtime.register(std::sync::Arc::new(crate::content::SourceRunner))?;
        runtime.submit(store, &input)?;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let result = loop {
            runtime.tick(store)?;
            if let Some(result) = store.execution_current_result(
                input.envelope().attempt_id,
                input.envelope().items[0].item_id,
            )? {
                break result;
            }
            if std::time::Instant::now() > deadline {
                return Err(ExecutionError::new(ErrorCode::Busy, "fixture-source"));
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        let confirmation = store
            .source_comparison(input.envelope().attempt_id, result, 0, 1)?
            .confirmation;
        let action = store.prepare_adoption(
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::to_value(confirmation)
                .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "fixture-source"))?,
        )?;
        store.adopt_execution(&action, &crate::content::SourceAdoptionHandler)?;
    }
    if settings["fail"].as_bool() == Some(true) {
        return Err(ExecutionError::new(
            ErrorCode::StorageFailed,
            "fixture-response",
        ));
    }
    Ok(())
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FixtureMode {
    Success,
    Partial,
    Hold,
    Unknown,
}

pub fn input(
    store: &mut ProjectStore,
    mode: FixtureMode,
    delay_ms: u32,
    grouped: bool,
) -> Result<FixedInput, ExecutionError> {
    if delay_ms > 5000 {
        return Err(ExecutionError::new(
            ErrorCode::LimitExceeded,
            "fixture-delay",
        ));
    }
    let prefix = ExecutionId::new();
    let ids: Vec<_> = ["A", "B", "C"]
        .iter()
        .map(|label| format!("Sample {label} {prefix}"))
        .collect();
    let items = ids
        .iter()
        .enumerate()
        .map(|(index, id)| {
            InputItem::new(
                Scope {
                    kind: "sample".into(),
                    id: id.clone(),
                    locale: None,
                },
                json!({"index":index}),
                vec![Dependency {
                    kind: "fixture".into(),
                    id: id.clone(),
                    expected_revision: Revision::new(1).expect("valid revision"),
                }],
            )
        })
        .collect();
    let metadata = store
        .metadata()
        .map_err(|_| ExecutionError::new(ErrorCode::StorageFailed, "fixture"))?;
    let mut envelope = InputEnvelope::new(
        metadata.project_id(),
        "sample-update",
        "controlled",
        "1",
        items,
    )?;
    envelope.settings = json!({"mode":mode,"delayMs":delay_ms});
    if grouped {
        envelope.units = vec![AdoptionUnit::new(
            envelope.items.iter().map(|item| item.item_id).collect(),
        )];
    }
    let input = FixedInput::capture(envelope)?;
    store.install_execution_fixture(&ids)?;
    Ok(input)
}

pub struct ControlledRunner;
fn result(
    request: &DispatchRequest,
    outcome: ExecutionState,
) -> Result<FixedResult, ExecutionError> {
    FixedResult::capture(
        ResultEnvelope {
            project_id: request.input.envelope().project_id,
            attempt_id: request.input.envelope().attempt_id,
            item_id: request.item_id,
            result_id: ExecutionId::new(),
            supersedes: None,
            dispatch_token: request.dispatch_token,
            capability_id: "controlled".into(),
            capability_version: "1".into(),
            outcome,
            output: (outcome == ExecutionState::Succeeded)
                .then(|| json!({"text":"Updated sample"})),
            diagnostic: (outcome == ExecutionState::Failed).then(|| Diagnostic {
                code: "temporary".into(),
                retry_safe: true,
            }),
        },
        &request.input,
        request.dispatch_token,
    )
}
impl Runner for ControlledRunner {
    fn capability_id(&self) -> &str {
        "controlled"
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancellation: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let settings = &request.input.envelope().settings;
        let mode: FixtureMode = serde_json::from_value(settings["mode"].clone())
            .map_err(|_| ExecutionError::new(ErrorCode::InvalidInput, "fixture"))?;
        let delay = settings["delayMs"]
            .as_u64()
            .filter(|n| *n <= 5000)
            .ok_or_else(|| ExecutionError::new(ErrorCode::InvalidInput, "fixture"))?;
        if matches!(mode, FixtureMode::Hold) {
            while !cancellation.is_requested() {
                std::thread::sleep(Duration::from_millis(10));
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(delay));
        if matches!(mode, FixtureMode::Unknown) {
            return Ok(());
        }
        let index = request.input.item(request.item_id)?.payload["index"].as_u64();
        let failure = matches!(mode, FixtureMode::Partial)
            && index == Some(1)
            && request.input.envelope().previous_attempt_id.is_none();
        results.send(result(
            &request,
            if failure {
                ExecutionState::Failed
            } else {
                ExecutionState::Succeeded
            },
        )?)
    }
    fn query(&self, request: &DispatchRequest) -> Result<QueryOutcome, ExecutionError> {
        Ok(QueryOutcome::Known(result(
            request,
            ExecutionState::Succeeded,
        )?))
    }
}
pub struct SampleHandler;
impl AdoptionHandler for SampleHandler {
    fn operation(&self) -> &str {
        "sample-update"
    }
    fn prepare(
        &self,
        input: &FixedInput,
        action: &AdoptionAction,
        results: &[FixedResult],
    ) -> Result<PreparedMutation, ExecutionError> {
        let input = input.clone();
        let results = results.to_vec();
        let action = action.clone();
        Ok(Box::new(move |tx| {
            let mut changes = Vec::new();
            for result in &results {
                let item = input.item(result.envelope().item_id)?;
                let dependency = item.dependencies.first().ok_or_else(|| {
                    ExecutionError::new(ErrorCode::InvalidInput, "fixture-dependency")
                })?;
                let changed=tx.execute("UPDATE fixture_targets SET value='Updated sample',revision=revision+1 WHERE id=?1 AND revision=?2",rusqlite::params![item.scope.id,dependency.expected_revision.get() as i64])?;
                if changed != 1 {
                    return Err(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "fixture-dependency",
                    )
                    .for_item(item.item_id));
                }
                changes.push(ChangeReference {
                    kind: action.operation.clone(),
                    id: item.scope.id.clone(),
                    revision: dependency.expected_revision.next()?,
                });
            }
            Ok(changes)
        }))
    }
}
