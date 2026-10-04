//! Human-facing work-plan commands share the ordinary project session and runtime.
use super::{ai_wire::AiPreviewView, *};
use tsumugi_core::{
    ai::{self, AiConfig, AiPreview},
    application::{
        AuthorizeWorkPlan, AutomationEffect, AutomationLease, ControlWorkPlan, PlanOptions,
        PlanSelectionBasis, SetWorkProtection, WorkPlan, WorkPlanCommand, WorkPlanReceipt,
        WorkPlanState, WorkPlanStatus, WorkProtection,
    },
};

#[derive(Default)]
pub(super) struct WorkPlanSession {
    prepared: Option<WorkPlan>,
}

request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanPrepareRequest {
        config: Option<AiConfig>,
        locale: String,
        unit_ids: Vec<ExecutionId>,
        options: PlanOptions
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanAuthorizeRequest {
        plan_id: ExecutionId,
        digest: String,
        action_id: ExecutionId,
        confirmed: bool,
        effects: Vec<AutomationEffect>,
        expires_at: UnsignedDecimal
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanStartRequest {
        plan_id: ExecutionId,
        action_id: ExecutionId,
        expected_generation: Revision
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanControlRequest {
        action_id: ExecutionId,
        plan_id: ExecutionId,
        expected_generation: Revision,
        command: WorkPlanCommand,
        confirmed: bool,
        expires_at: Option<UnsignedDecimal>
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanStatusRequest {
        plan_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkPlanActionRequest {
        action_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkProtectionReadRequest {
        unit_id: ExecutionId,
        locale: String
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    WorkProtectionSetRequest {
        action_id: ExecutionId,
        unit_id: ExecutionId,
        locale: String,
        source_revision_id: ExecutionId,
        selection_id: Option<ExecutionId>,
        expected_revision: Revision,
        protected: bool,
        confirmed_release: bool
    }
);

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanView {
    pub plan_id: ExecutionId,
    pub digest: String,
    pub locale: String,
    pub options: PlanOptions,
    pub scope: Vec<PlanSelectionBasis>,
    pub preview: Option<AiPreviewView>,
    pub attempt_id: Option<ExecutionId>,
}

impl TryFrom<&WorkPlan> for WorkPlanView {
    type Error = ExecutionError;

    fn try_from(plan: &WorkPlan) -> Result<Self, Self::Error> {
        plan.validate()?;
        let preview = if plan.input.is_some() {
            let input = plan.fixed_input()?;
            let settings = ai::settings(&input)?;
            let items = input
                .envelope()
                .items
                .iter()
                .map(|item| ai::item_payload(&input, item.item_id))
                .collect::<Result<Vec<_>, _>>()?;
            let digest = ai::preview_digest(&settings.config, &items)?;
            Some(AiPreviewView::from(AiPreview {
                config: settings.config,
                recipe: settings.recipe,
                items,
                digest,
            }))
        } else {
            None
        };
        Ok(Self {
            plan_id: plan.plan_id,
            digest: plan.digest.clone(),
            locale: plan.locale.clone(),
            options: plan.options.clone(),
            scope: plan.selection_basis.clone(),
            preview,
            attempt_id: plan.input.as_ref().map(|input| input.attempt_id),
        })
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanReceiptView {
    pub action_id: ExecutionId,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub attempt_id: Option<ExecutionId>,
    pub parent_task: Option<ExecutionId>,
}

impl From<WorkPlanReceipt> for WorkPlanReceiptView {
    fn from(receipt: WorkPlanReceipt) -> Self {
        Self {
            action_id: receipt.action_id,
            lease: receipt.lease,
            state: receipt.state,
            attempt_id: receipt.input.as_ref().map(|input| input.attempt_id),
            parent_task: receipt.parent_task,
        }
    }
}

#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkPlanStatusView {
    pub plan: WorkPlanView,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub effects: Vec<AutomationEffect>,
    pub expires_at: UnsignedDecimal,
}

impl WorkPlanStatusView {
    fn capture(plan: &WorkPlan, status: WorkPlanStatus) -> Result<Self, ExecutionError> {
        Ok(Self {
            plan: plan.try_into()?,
            lease: status.lease,
            state: status.state,
            effects: status.effects,
            expires_at: status.expires_at.into(),
        })
    }
}

#[tauri::command]
pub async fn prepare_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanPrepareRequest,
) -> Result<WorkPlanView, CommandError> {
    state
        .sessions
        .run(
            "prepare_work_plan",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let plan = store
                    .prepare_work_plan(
                        request.config,
                        &request.locale,
                        &request.unit_ids,
                        request.options,
                    )
                    .map_err(map_read)?;
                let view = WorkPlanView::try_from(&plan).map_err(map_read)?;
                host.work_plans.prepared = Some(plan);
                Ok(view)
            },
        )
        .await
}

#[tauri::command]
pub async fn authorize_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanAuthorizeRequest,
) -> Result<WorkPlanReceiptView, CommandError> {
    state
        .sessions
        .run(
            "authorize_work_plan",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let plan = if let Some(plan) =
                    host.work_plans.prepared.as_ref().filter(|plan| {
                        plan.plan_id == request.plan_id && plan.digest == request.digest
                    }) {
                    plan.clone()
                } else {
                    // Reconcile an already committed action after a lost response or
                    // session reopen. A new grant still requires this session's preview.
                    let receipt = store
                        .work_plan_receipt(request.action_id)
                        .map_err(map_recover)?
                        .filter(|receipt| receipt.lease.plan_id == request.plan_id)
                        .ok_or_else(|| {
                            map_recover(ExecutionError::new(
                                ErrorCode::DependencyConflict,
                                "work-plan-preview",
                            ))
                        })?;
                    store
                        .work_plan(receipt.lease.plan_id)
                        .map_err(map_recover)?
                };
                let receipt = store
                    .authorize_work_plan(
                        &plan,
                        &AuthorizeWorkPlan {
                            action_id: request.action_id,
                            plan_digest: request.digest,
                            confirmed: request.confirmed,
                            effects: request.effects,
                            expires_at: request.expires_at.get(),
                        },
                    )
                    .map_err(map_recover)?;
                Ok(receipt.into())
            },
        )
        .await
}

#[tauri::command]
pub async fn start_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanStartRequest,
) -> Result<ExecutionId, CommandError> {
    state
        .sessions
        .run(
            "start_work_plan",
            CommandStage::ExecutionRecover,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRecover,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                let receipt = store
                    .work_plan_receipt(request.action_id)
                    .map_err(map_recover)?
                    .ok_or_else(|| {
                        map_recover(ExecutionError::new(
                            ErrorCode::Unauthorized,
                            "work-plan-authorization",
                        ))
                    })?;
                let status = store
                    .work_plan_status(request.plan_id)
                    .map_err(map_recover)?;
                if receipt.lease.plan_id != request.plan_id
                    || receipt.lease.generation != request.expected_generation
                    || receipt.lease != status.lease
                    || receipt.cancellation_revision != status.cancellation_revision
                    || receipt.state != WorkPlanState::Active
                    || status.state != WorkPlanState::Active
                {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "work-plan-generation",
                    )));
                }
                let envelope = receipt.input.ok_or_else(|| {
                    map_recover(ExecutionError::new(
                        ErrorCode::Unauthorized,
                        "work-plan-manual",
                    ))
                })?;
                if envelope.automation != Some(receipt.lease)
                    || envelope.project_id != request.project_id
                {
                    return Err(map_recover(ExecutionError::new(
                        ErrorCode::CorruptLedger,
                        "work-plan-receipt",
                    )));
                }
                // These IDs and settings are from the durable receipt. Capturing
                // their fixed bytes never previews work or allocates new identities.
                let input = FixedInput::capture(envelope).map_err(map_recover)?;
                match store.execution_input(input.envelope().attempt_id) {
                    Ok(existing) => {
                        if existing.bytes() != input.bytes() {
                            return Err(map_recover(ExecutionError::new(
                                ErrorCode::ResultMismatch,
                                "work-plan-start",
                            )));
                        }
                        store
                            .check_work_plan_input(&existing)
                            .map_err(map_recover)?;
                    }
                    Err(error)
                        if error.code == ErrorCode::InvalidInput
                            && error.stage == "execution-storage" => {}
                    Err(error) => return Err(map_recover(error)),
                }
                if let Some(parent) = receipt.parent_task {
                    host.runtime
                        .submit_child(store, &input, parent)
                        .map_err(map_recover)?;
                } else {
                    host.runtime.submit(store, &input).map_err(map_recover)?;
                }
                Ok(input.envelope().attempt_id)
            },
        )
        .await
}

#[tauri::command]
pub async fn control_work_plan(
    state: State<'_, AppState>,
    request: WorkPlanControlRequest,
) -> Result<WorkPlanReceiptView, CommandError> {
    state
        .sessions
        .run(
            "control_work_plan",
            CommandStage::ExecutionCancel,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionCancel,
                )?;
                if request.command == WorkPlanCommand::Continue {
                    let (host, _) = active.execution_parts()?;
                    host.allow_mutation()?;
                }
                let receipt = active
                    .store
                    .control_work_plan(&ControlWorkPlan {
                        action_id: request.action_id,
                        plan_id: request.plan_id,
                        expected_generation: request.expected_generation,
                        command: request.command,
                        confirmed: request.confirmed,
                        expires_at: request.expires_at.map(UnsignedDecimal::get),
                    })
                    .map_err(|error| map_execution(error, CommandStage::ExecutionCancel))?;
                // The regular host clock observes the committed generation and
                // cancels workers. A later tick failure cannot reject this receipt.
                Ok(receipt.into())
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_status(
    state: State<'_, AppState>,
    request: WorkPlanStatusRequest,
) -> Result<WorkPlanStatusView, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_status",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                let plan = active.store.work_plan(request.plan_id).map_err(map_read)?;
                let status = active
                    .store
                    .work_plan_status(request.plan_id)
                    .map_err(map_read)?;
                WorkPlanStatusView::capture(&plan, status).map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_plan_action(
    state: State<'_, AppState>,
    request: WorkPlanActionRequest,
) -> Result<Option<WorkPlanReceiptView>, CommandError> {
    state
        .sessions
        .run(
            "read_work_plan_action",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .work_plan_receipt(request.action_id)
                    .map(|receipt| receipt.map(Into::into))
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn read_work_protection(
    state: State<'_, AppState>,
    request: WorkProtectionReadRequest,
) -> Result<WorkProtection, CommandError> {
    state
        .sessions
        .run(
            "read_work_protection",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                active
                    .store
                    .work_protection(request.unit_id, &request.locale)
                    .map_err(map_read)
            },
        )
        .await
}

#[tauri::command]
pub async fn set_work_protection(
    state: State<'_, AppState>,
    request: WorkProtectionSetRequest,
) -> Result<WorkProtection, CommandError> {
    state
        .sessions
        .run(
            "set_work_protection",
            CommandStage::ExecutionAdopt,
            move |sessions| {
                let active = authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionAdopt,
                )?;
                let (host, store) = active.execution_parts()?;
                host.allow_mutation()?;
                store
                    .set_work_protection(&SetWorkProtection {
                        action_id: request.action_id,
                        project_id: request.project_id,
                        unit_id: request.unit_id,
                        locale: request.locale,
                        source_revision_id: request.source_revision_id,
                        selection_id: request.selection_id,
                        expected_revision: request.expected_revision,
                        protected: request.protected,
                        confirmed_release: request.confirmed_release,
                    })
                    .map_err(map_adopt)
            },
        )
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{net::TcpListener, time::SystemTime};
    use tauri::{
        Manager,
        ipc::{CallbackFn, InvokeBody},
        webview::InvokeRequest,
    };
    use tsumugi_core::application::{StageChoice, StageMode, WorkStage};

    #[test]
    fn shared_work_plan_fixture_round_trips_through_serde() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/workPlanCommands.contract.json"
        ))
        .unwrap();
        macro_rules! round_trip {
            ($group:literal, $key:literal, $ty:ty) => {{
                let value = fixture[$group][$key].clone();
                let decoded: $ty = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(decoded).unwrap(), value, "{}", $key);
            }};
        }
        round_trip!("requests", "prepare", WorkPlanPrepareRequest);
        round_trip!("requests", "authorize", WorkPlanAuthorizeRequest);
        round_trip!("requests", "start", WorkPlanStartRequest);
        round_trip!("requests", "control", WorkPlanControlRequest);
        round_trip!("requests", "status", WorkPlanStatusRequest);
        round_trip!("requests", "action", WorkPlanActionRequest);
        round_trip!("requests", "protectionRead", WorkProtectionReadRequest);
        round_trip!("requests", "protectionSet", WorkProtectionSetRequest);
        round_trip!("responses", "plan", WorkPlanView);
        round_trip!("responses", "receipt", WorkPlanReceiptView);
        round_trip!("responses", "control", WorkPlanReceiptView);
        round_trip!("responses", "status", WorkPlanStatusView);
        round_trip!("responses", "action", Option<WorkPlanReceiptView>);
        round_trip!("responses", "protection", WorkProtection);
        let mut invalid = fixture["requests"]["authorize"].clone();
        invalid["expiresAt"] = json!(9007199254740993u64);
        assert!(serde_json::from_value::<WorkPlanAuthorizeRequest>(invalid).is_err());
        let mut invalid = fixture["requests"]["control"].clone();
        invalid["expectedGeneration"] = json!("9223372036854775808");
        assert!(serde_json::from_value::<WorkPlanControlRequest>(invalid).is_err());
    }

    type MockWebview = tauri::WebviewWindow<tauri::test::MockRuntime>;

    struct Fixture {
        directory: tempfile::TempDir,
        app: tauri::App<tauri::test::MockRuntime>,
        webview: MockWebview,
        context: Value,
        unit: ExecutionId,
        source_revision: ExecutionId,
        snapshot: ExecutionId,
    }

    fn call(webview: &MockWebview, command: &str, request: Value) -> Result<Value, Value> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let response = tauri::test::get_ipc_response(
                webview,
                InvokeRequest {
                    cmd: command.into(),
                    callback: CallbackFn(0),
                    error: CallbackFn(1),
                    url: crate::ipc_test_url().parse().unwrap(),
                    body: InvokeBody::Json(json!({"request":request.clone()})),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
            .map(|response| response.deserialize::<Value>().unwrap());
            match response {
                Err(error) if error["code"] == "busy" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                response => return response,
            }
        }
    }

    fn request(context: &Value, extra: Value) -> Value {
        let mut request = context.clone();
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        request
    }

    impl Fixture {
        fn create() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let app = crate::commands::register_commands(tauri::test::mock_builder())
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .unwrap();
            let webview = tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .build()
            .unwrap();
            let view = call(
                &webview,
                "create_project",
                json!({
                    "destination":directory.path().join("project"), "displayName":"Work plan test",
                    "sourceLocale":"en-US", "targetLocales":["zh-CN"]
                }),
            )
            .unwrap();
            let context = json!({
                "sessionToken":view["sessionToken"], "projectId":view["metadata"]["projectId"]
            });
            let (unit, source_revision, snapshot) = app.state::<AppState>().sessions.with(|sessions| {
                let (host, store) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
                let source = tsumugi_core::content::SourceBundle::capture(
                    br#"{"UniqueID":"Example.Mod","Name":"Example","Version":"1.0.0","EntryDll":"Example.dll"}"#,
                    br#"{"first":"Hello"}"#,
                    "en-US",
                ).unwrap();
                let input = source.fixed_input(store.metadata().unwrap().project_id()).unwrap();
                host.runtime.submit(store, &input).unwrap();
                let deadline = Instant::now() + Duration::from_secs(5);
                while host.active(store).unwrap() {
                    host.tick(store).unwrap();
                    assert!(Instant::now() < deadline);
                    std::thread::yield_now();
                }
                let result = store.execution_current_result(
                    input.envelope().attempt_id, input.envelope().items[0].item_id,
                ).unwrap().unwrap();
                let preview = store.source_preview(input.envelope().attempt_id, result, 0, 1).unwrap();
                let action = store.prepare_adoption_with_id(
                    ExecutionId::new(), input.envelope().attempt_id, input.envelope().units[0].unit_id,
                    vec![result], serde_json::to_value(preview.confirmation).unwrap(),
                ).unwrap();
                store.adopt_execution(&action, &tsumugi_core::content::SourceAdoptionHandler).unwrap();
                let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
                let row = store.source_content(snapshot, 0, 1).unwrap().rows.remove(0);
                (row.unit_id.unwrap(), row.source_revision_id.unwrap(), snapshot)
            });
            Self {
                directory,
                app,
                webview,
                context,
                unit,
                source_revision,
                snapshot,
            }
        }

        fn call(&self, command: &str, extra: Value) -> Result<Value, Value> {
            call(&self.webview, command, request(&self.context, extra))
        }

        fn bytes(&self) -> Vec<u8> {
            std::fs::read(self.directory.path().join("project/project.sqlite3")).unwrap()
        }

        fn attempt_count(&self) -> i64 {
            let connection = rusqlite::Connection::open_with_flags(
                self.directory.path().join("project/project.sqlite3"),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            connection
                .query_row("SELECT COUNT(*) FROM execution_attempts", [], |row| {
                    row.get(0)
                })
                .unwrap()
        }

        fn assert_fixed_input(&self, receipt: &Value) {
            let action: ExecutionId = serde_json::from_value(receipt["actionId"].clone()).unwrap();
            self.app.state::<AppState>().sessions.with(move |sessions| {
                let store = &sessions.active.as_ref().unwrap().store;
                let durable = store.work_plan_receipt(action).unwrap().unwrap();
                let fixed = FixedInput::capture(durable.input.unwrap()).unwrap();
                assert_eq!(
                    store
                        .execution_input(fixed.envelope().attempt_id)
                        .unwrap()
                        .bytes(),
                    fixed.bytes()
                );
            });
        }

        fn reopen(&mut self) {
            call(
                &self.webview,
                "close_project",
                json!({
                    "sessionToken":self.context["sessionToken"]
                }),
            )
            .unwrap();
            let view = call(
                &self.webview,
                "open_project",
                json!({
                    "locator":self.directory.path().join("project")
                }),
            )
            .unwrap();
            self.context = json!({
                "sessionToken":view["sessionToken"], "projectId":view["metadata"]["projectId"]
            });
        }
    }

    fn manual_options() -> PlanOptions {
        PlanOptions {
            stages: vec![StageChoice {
                stage: WorkStage::Generation,
                mode: StageMode::Manual,
            }],
            ..PlanOptions::default()
        }
    }

    fn expiry() -> String {
        (SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 300)
            .to_string()
    }

    #[test]
    fn manual_preparation_is_read_only_and_rejects_untrusted_wire_inputs() {
        let fixture = Fixture::create();
        let before = fixture.bytes();
        let prepared = fixture.call("prepare_work_plan", json!({
            "config":null, "locale":"zh-CN", "unitIds":[fixture.unit], "options":manual_options()
        })).unwrap();
        assert_eq!(prepared["locale"], "zh-CN");
        assert_eq!(prepared["scope"][0]["unitId"], json!(fixture.unit));
        assert_eq!(
            prepared["scope"][0]["sourceSnapshotId"],
            json!(fixture.snapshot)
        );
        assert_eq!(
            prepared["scope"][0]["sourceRevisionId"],
            json!(fixture.source_revision)
        );
        assert_eq!(prepared["scope"][0]["nativeKey"], "first");
        assert!(prepared["preview"].is_null() && prepared["attemptId"].is_null());
        assert!(prepared.get("input").is_none());
        assert_eq!(fixture.bytes(), before);
        assert!(fixture.call("prepare_work_plan", json!({
            "config":null, "locale":"zh-CN", "unitIds":[fixture.unit], "options":PlanOptions::default()
        })).is_err());
        assert!(fixture.call("authorize_work_plan", json!({
            "planId":prepared["planId"], "digest":prepared["digest"], "actionId":ExecutionId::new(),
            "confirmed":true, "effects":["save-candidate"], "expiresAt":expiry(),
            "semanticAnswer":"yes"
        })).is_err());
        assert!(fixture.call("authorize_work_plan", json!({
            "planId":prepared["planId"], "digest":prepared["digest"], "actionId":ExecutionId::new(),
            "confirmed":true, "effects":["save-candidate"], "expiresAt":expiry()
        })).is_err());
        assert!(fixture.call("prepare_work_plan", json!({
            "config":null, "locale":"zh-CN", "unitIds":[fixture.unit], "options":manual_options(),
            "input":{}
        })).is_err());
        assert!(
            fixture
                .call(
                    "read_work_plan_action",
                    json!({
                        "sessionToken":"inactive-session", "actionId":ExecutionId::new()
                    })
                )
                .is_err()
        );
        assert!(
            fixture
                .call(
                    "read_work_protection",
                    json!({
                        "projectId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN"
                    })
                )
                .is_err()
        );
        assert_eq!(
            fixture
                .call(
                    "read_work_plan_action",
                    json!({"actionId":ExecutionId::new()})
                )
                .unwrap(),
            Value::Null
        );
        assert_eq!(fixture.bytes(), before);
        assert!(fixture.app.state::<AppState>().sessions.with(|sessions| {
            sessions
                .active
                .as_ref()
                .unwrap()
                .execution
                .as_ref()
                .unwrap()
                .work_plans
                .prepared
                .is_some()
        }));
    }

    #[test]
    fn authorization_start_and_controls_reconcile_fixed_receipts_across_reopen() {
        let mut fixture = Fixture::create();
        // Own the only permitted endpoint. No external provider or credentials
        // are used; a dispatched request can only reach this local listener.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = AiConfig {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            model: "synthetic".into(),
            credential_env: String::new(),
            max_requests: 4,
            timeout_seconds: 1,
            ..AiConfig::default()
        };
        let count = fixture.attempt_count();
        let before = fixture.bytes();
        let prepared = fixture.call("prepare_work_plan", json!({
            "config":config, "locale":"zh-CN", "unitIds":[fixture.unit], "options":PlanOptions::default()
        })).unwrap();
        assert!(prepared["preview"].is_object());
        assert!(prepared["preview"]["items"][0]["resourceBaseline"].is_string());
        assert_eq!(fixture.bytes(), before);
        let grant = json!({
            "planId":prepared["planId"], "digest":prepared["digest"], "actionId":ExecutionId::new(),
            "confirmed":true, "effects":["save-candidate"], "expiresAt":expiry()
        });
        let mut unconfirmed = grant.clone();
        unconfirmed["confirmed"] = json!(false);
        assert!(fixture.call("authorize_work_plan", unconfirmed).is_err());
        let mut integer_expiry = grant.clone();
        integer_expiry["expiresAt"] = json!(300);
        assert!(fixture.call("authorize_work_plan", integer_expiry).is_err());
        assert_eq!(fixture.bytes(), before);
        let receipt = fixture.call("authorize_work_plan", grant.clone()).unwrap();
        assert_eq!(receipt["attemptId"], prepared["attemptId"]);
        assert!(receipt.get("input").is_none() && receipt.get("cancellationRevision").is_none());
        assert_eq!(fixture.attempt_count(), count);
        assert_eq!(
            fixture.call("authorize_work_plan", grant.clone()).unwrap(),
            receipt
        );
        let status = fixture
            .call(
                "read_work_plan_status",
                json!({"planId":prepared["planId"]}),
            )
            .unwrap();
        assert_eq!(status["plan"], prepared);
        assert_eq!(status["expiresAt"], grant["expiresAt"]);
        assert_eq!(status["effects"], json!(["save-candidate"]));
        assert!(status.get("cancellationRevision").is_none());
        let start = json!({
            "planId":prepared["planId"], "actionId":receipt["actionId"],
            "expectedGeneration":receipt["lease"]["generation"]
        });
        assert_eq!(
            fixture.call("start_work_plan", start.clone()).unwrap(),
            prepared["attemptId"]
        );
        assert_eq!(
            fixture.call("start_work_plan", start.clone()).unwrap(),
            prepared["attemptId"]
        );
        assert_eq!(fixture.attempt_count(), count + 1);
        fixture.assert_fixed_input(&receipt);
        let paused = fixture
            .call(
                "control_work_plan",
                json!({
                    "planId":prepared["planId"], "actionId":ExecutionId::new(),
                    "expectedGeneration":receipt["lease"]["generation"], "command":"pause",
                    "confirmed":false, "expiresAt":null
                }),
            )
            .unwrap();
        assert_eq!(paused["state"], "paused");
        assert!(fixture.call("start_work_plan", start).is_err());
        let resume = json!({
            "planId":prepared["planId"], "actionId":ExecutionId::new(),
            "expectedGeneration":paused["lease"]["generation"], "command":"continue",
            "confirmed":true, "expiresAt":expiry()
        });
        let resumed = fixture.call("control_work_plan", resume.clone()).unwrap();
        assert_eq!(resumed["state"], "active");
        assert!(resumed["parentTask"].is_string());
        assert_ne!(resumed["attemptId"], prepared["attemptId"]);
        assert_eq!(fixture.attempt_count(), count + 1);
        assert_eq!(fixture.call("control_work_plan", resume).unwrap(), resumed);
        let restart = json!({
            "planId":prepared["planId"], "actionId":resumed["actionId"],
            "expectedGeneration":resumed["lease"]["generation"]
        });
        assert_eq!(
            fixture.call("start_work_plan", restart.clone()).unwrap(),
            resumed["attemptId"]
        );
        assert_eq!(
            fixture.call("start_work_plan", restart.clone()).unwrap(),
            resumed["attemptId"]
        );
        assert_eq!(fixture.attempt_count(), count + 2);
        fixture.assert_fixed_input(&resumed);
        let taken_over = fixture
            .call(
                "control_work_plan",
                json!({
                    "planId":prepared["planId"], "actionId":ExecutionId::new(),
                    "expectedGeneration":resumed["lease"]["generation"], "command":"take-over",
                    "confirmed":false, "expiresAt":null
                }),
            )
            .unwrap();
        assert_eq!(taken_over["state"], "taken-over");
        fixture.reopen();
        assert_eq!(
            fixture
                .call(
                    "read_work_plan_action",
                    json!({"actionId":resumed["actionId"]})
                )
                .unwrap(),
            resumed
        );
        let reopened = fixture
            .call(
                "read_work_plan_status",
                json!({"planId":prepared["planId"]}),
            )
            .unwrap();
        assert_eq!(reopened["plan"], prepared);
        assert_eq!(reopened["lease"], taken_over["lease"]);
        assert_eq!(reopened["state"], "taken-over");
        assert!(fixture.call("start_work_plan", restart).is_err());
        assert_eq!(
            fixture.call("authorize_work_plan", grant.clone()).unwrap(),
            receipt
        );
        let mut uncaptured = grant;
        uncaptured["actionId"] = json!(ExecutionId::new());
        assert!(fixture.call("authorize_work_plan", uncaptured).is_err());
        assert_eq!(fixture.attempt_count(), count + 2);
        call(
            &fixture.webview,
            "close_project",
            json!({"sessionToken":fixture.context["sessionToken"]}),
        )
        .unwrap();
    }

    #[test]
    fn protection_release_checks_current_evidence_and_preserves_new_manual_work() {
        let mut fixture = Fixture::create();
        let initial = fixture
            .call(
                "read_work_protection",
                json!({
                    "unitId":fixture.unit, "locale":"zh-CN"
                }),
            )
            .unwrap();
        assert_eq!(initial["revision"], "0");
        assert_eq!(initial["protected"], false);
        let saved = fixture.call("save_translation_revision", json!({
            "actionId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN",
            "sourceRevisionId":fixture.source_revision, "expectedSelectionId":null, "text":"Human translation"
        })).unwrap();
        let protected = fixture
            .call(
                "read_work_protection",
                json!({
                    "unitId":fixture.unit, "locale":"zh-CN"
                }),
            )
            .unwrap();
        assert_eq!(protected["protected"], true);
        let release = json!({
            "actionId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN",
            "sourceRevisionId":fixture.source_revision, "selectionId":saved["selection"]["eventId"],
            "expectedRevision":protected["revision"], "protected":false, "confirmedRelease":true
        });
        let before = fixture.bytes();
        let mut unconfirmed = release.clone();
        unconfirmed["confirmedRelease"] = json!(false);
        assert!(fixture.call("set_work_protection", unconfirmed).is_err());
        let mut stale = release.clone();
        stale["expectedRevision"] = json!("0");
        assert!(fixture.call("set_work_protection", stale).is_err());
        let mut forged = release.clone();
        forged["sourceRevisionId"] = json!(ExecutionId::new());
        assert!(fixture.call("set_work_protection", forged).is_err());
        assert_eq!(fixture.bytes(), before);
        let released = fixture
            .call("set_work_protection", release.clone())
            .unwrap();
        assert_eq!(released["protected"], false);
        fixture.call("save_translation_revision", json!({
            "actionId":ExecutionId::new(), "unitId":fixture.unit, "locale":"zh-CN",
            "sourceRevisionId":fixture.source_revision,
            "expectedSelectionId":saved["selection"]["eventId"], "text":"Newer human translation"
        })).unwrap();
        let current = fixture
            .call(
                "read_work_protection",
                json!({
                    "unitId":fixture.unit, "locale":"zh-CN"
                }),
            )
            .unwrap();
        assert_eq!(current["protected"], true);
        assert_ne!(current["revision"], released["revision"]);
        assert_eq!(
            fixture.call("set_work_protection", release).unwrap(),
            released
        );
        fixture.reopen();
        assert_eq!(
            fixture
                .call(
                    "read_work_protection",
                    json!({
                        "unitId":fixture.unit, "locale":"zh-CN"
                    })
                )
                .unwrap(),
            current
        );
    }
}
