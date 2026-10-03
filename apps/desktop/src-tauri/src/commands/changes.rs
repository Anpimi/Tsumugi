//! Best-effort invalidation hints. Snapshots, not event delivery, own recovery.
use super::*;
use tsumugi_core::{
    ChangeScope,
    execution::{ExecutionId, Revision},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChangeNotification {
    pub project_id: String,
    pub session_token: String,
    pub epoch: String,
    pub kind: NotificationKind,
    pub after_sequence: Revision,
    pub sequence: Revision,
    pub scopes: Vec<ChangeScope>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum NotificationKind {
    Change,
    Progress,
    Resync,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChangesRequest {
    session_token: String,
    project_id: ExecutionId,
    after_sequence: Revision,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectChanges {
    project_id: ExecutionId,
    session_token: String,
    #[serde(flatten)]
    changes: tsumugi_core::ChangeSnapshot,
    runtime: execution::RuntimeStatus,
}

#[tauri::command]
pub(super) async fn read_project_changes(
    state: State<'_, AppState>,
    request: ChangesRequest,
) -> Result<ProjectChanges, CommandError> {
    state
        .sessions
        .run(
            "read_project_changes",
            CommandStage::ExecutionRead,
            move |sessions| {
                let active = execution::authorized(
                    sessions,
                    &request.session_token,
                    request.project_id,
                    CommandStage::ExecutionRead,
                )?;
                if active.store.is_reconciling() {
                    return Err(CommandError::unknown(CommandStage::ExecutionRead));
                }
                let changes = active.store.changes_since(request.after_sequence);
                let runtime = active.execution_status_view()?;
                Ok(ProjectChanges {
                    project_id: request.project_id,
                    session_token: request.session_token,
                    changes,
                    runtime,
                })
            },
        )
        .await
}

pub(super) type ChangeSink = Arc<dyn Fn(ChangeNotification) + Send + Sync>;
pub(super) struct Notifications {
    token: Option<String>,
    epoch: Option<String>,
    sequence: Revision,
    progress: Revision,
    last_progress: std::time::Instant,
}
impl Default for Notifications {
    fn default() -> Self {
        Self {
            token: None,
            epoch: None,
            sequence: Revision::new(0).unwrap(),
            progress: Revision::new(0).unwrap(),
            last_progress: std::time::Instant::now(),
        }
    }
}
impl Notifications {
    pub(super) fn publish(&mut self, sessions: &SessionManager, sink: &ChangeSink) {
        let Some(active) = &sessions.active else {
            self.token = None;
            return;
        };
        let snapshot = active.store.changes_since(self.sequence);
        let reset = self.epoch.as_ref() != Some(&snapshot.epoch)
            || self.token.as_ref() != Some(&active.token)
            || snapshot.sequence < self.sequence
            || snapshot.progress_sequence < self.progress;
        let progress_due = self.last_progress.elapsed() >= std::time::Duration::from_millis(250);
        if !reset
            && snapshot.sequence == self.sequence
            && (!progress_due || snapshot.progress_sequence == self.progress)
        {
            return;
        }
        // Reconciliation can temporarily make the project unreadable. Keep the
        // cursor so the same invalidations are sent after reconciliation succeeds.
        let Ok(metadata) = active.store.metadata() else {
            return;
        };
        let notification = |kind, after_sequence, sequence, scopes| ChangeNotification {
            project_id: metadata.project_id().to_string(),
            session_token: active.token.clone(),
            epoch: snapshot.epoch.clone(),
            kind,
            after_sequence,
            sequence,
            scopes,
        };
        if reset {
            sink(notification(
                NotificationKind::Resync,
                self.sequence,
                snapshot.sequence,
                vec![ChangeScope::Project],
            ));
            self.token = Some(active.token.clone());
            self.epoch = Some(snapshot.epoch.clone());
            self.sequence = snapshot.sequence;
            self.progress = snapshot.progress_sequence;
            self.last_progress = std::time::Instant::now();
            return;
        }
        if snapshot.sequence != self.sequence {
            sink(notification(
                NotificationKind::Change,
                self.sequence,
                snapshot.sequence,
                snapshot.scopes,
            ));
            self.sequence = snapshot.sequence;
        }
        if progress_due && snapshot.progress_sequence != self.progress {
            sink(notification(
                NotificationKind::Progress,
                self.progress,
                snapshot.progress_sequence,
                vec![ChangeScope::Execution],
            ));
            self.progress = snapshot.progress_sequence;
            self.last_progress = std::time::Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn change_wire_fixture_preserves_decimal_versions_and_scopes() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/projectChanges.contract.json"
        ))
        .unwrap();
        let request: ChangesRequest = serde_json::from_value(fixture["request"].clone()).unwrap();
        assert_eq!(request.after_sequence.get(), 9_007_199_254_740_992);
        let snapshot: ProjectChanges = serde_json::from_value(fixture["snapshot"].clone()).unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap(), fixture["snapshot"]);
        let event: ChangeNotification =
            serde_json::from_value(fixture["notification"].clone()).unwrap();
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            fixture["notification"]
        );
        let mut invalid = fixture["request"].clone();
        invalid["afterSequence"] = serde_json::json!(9_007_199_254_740_992_u64);
        assert!(serde_json::from_value::<ChangesRequest>(invalid).is_err());
    }
}
