//! Compact execution facts for the project-wide task dock. No input/result
//! frames, runtime permissions or adoption decisions are reconstructed here.
use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum TaskActivityPhase {
    Active,
    Attention,
    Saved,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TaskActivityRow {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub operation: String,
    pub sequence: Revision,
    pub phase: TaskActivityPhase,
    pub progress: Progress,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TaskActivity {
    pub total: Revision,
    pub active: Revision,
    pub attention: Revision,
    pub saved: Revision,
    pub rows: Vec<TaskActivityRow>,
}

// A continuation supersedes only its selected item identities. Other items may
// still be running or uncertain in an earlier attempt of the same task.
const ACTIVITY: &str = "WITH ranked_items AS (
    SELECT a.task_id,a.attempt_id,a.sequence AS attempt_sequence,i.item_id,i.validation,i.adoption,
      CASE WHEN i.execution='dispatched'
        AND NOT EXISTS(SELECT 1 FROM json_each(?2) live WHERE live.value=a.attempt_id)
        THEN 'unknown' ELSE i.execution END AS execution,
      ROW_NUMBER() OVER(PARTITION BY a.task_id,i.item_id ORDER BY a.sequence DESC) AS rank
    FROM execution_attempts a JOIN execution_items i ON i.attempt_id=a.attempt_id
), current_items AS (
    SELECT *,CASE
      WHEN execution IN ('queued','dispatched') THEN 0
      WHEN execution IN ('failed','cancelled-before-dispatch','unknown')
        OR validation IN ('pending','invalid') OR adoption IN ('conflict','rejected') THEN 1
      ELSE 2 END AS phase
    FROM ranked_items WHERE rank=1
), representative AS (
    SELECT task_id,attempt_id,ROW_NUMBER() OVER(
      PARTITION BY task_id ORDER BY phase,attempt_sequence DESC,item_id) AS rank
    FROM current_items
), states AS (
    SELECT t.task_id,t.operation,t.sequence,r.attempt_id,
      COUNT(i.item_id) AS total,
      COALESCE(SUM(i.execution='queued'),0) AS queued,
      COALESCE(SUM(i.execution='dispatched'),0) AS running,
      COALESCE(SUM(i.execution='succeeded'),0) AS succeeded,
      COALESCE(SUM(i.execution='failed'),0) AS failed,
      COALESCE(SUM(i.execution='cancelled-before-dispatch'),0) AS cancelled,
      COALESCE(SUM(i.execution='unknown'),0) AS unknown,
      COALESCE(SUM(i.adoption='committed'),0) AS adopted,
      MIN(i.phase) AS phase
    FROM execution_tasks t
    LEFT JOIN current_items i ON i.task_id=t.task_id
    LEFT JOIN representative r ON r.task_id=t.task_id AND r.rank=1
    GROUP BY t.task_id
)
SELECT *,COUNT(*) OVER() AS tasks,
    SUM(phase=0) OVER() AS active_tasks,
    SUM(phase=1) OVER() AS attention_tasks,
    SUM(phase=2) OVER() AS saved_tasks
FROM states
ORDER BY phase,sequence DESC LIMIT ?1";

fn count(row: &rusqlite::Row<'_>, name: &str) -> Result<u32, ExecutionError> {
    u32::try_from(row.get::<_, i64>(name).map_err(sql_error)?)
        .map_err(|_| error(ErrorCode::CorruptLedger, "task-activity-count"))
}
fn revision(row: &rusqlite::Row<'_>, name: &str) -> Result<Revision, ExecutionError> {
    let value = row.get::<_, i64>(name).map_err(sql_error)?;
    let value = u64::try_from(value)
        .map_err(|_| error(ErrorCode::CorruptLedger, "task-activity-revision"))?;
    Revision::new(value).map_err(|_| error(ErrorCode::CorruptLedger, "task-activity-revision"))
}

impl ProjectStore {
    /// All-task totals plus a bounded, prioritized view of current item states.
    /// Saved outputs say nothing about approval, adoption or delivery readiness.
    pub fn execution_task_activity(
        &self,
        limit: u32,
        active_attempts: &[ExecutionId],
    ) -> Result<TaskActivity, ExecutionError> {
        if !(1..=20).contains(&limit) {
            return Err(error(ErrorCode::LimitExceeded, "task-activity-page"));
        }
        let connection = self.execution_connection()?;
        let mut statement = connection.prepare(ACTIVITY).map_err(sql_error)?;
        let active = serde_json::to_string(active_attempts)
            .map_err(|_| error(ErrorCode::InvalidInput, "task-activity-runtime"))?;
        let mut rows = statement.query(params![limit, active]).map_err(sql_error)?;
        let mut activity = TaskActivity {
            total: Revision::new(0)?,
            active: Revision::new(0)?,
            attention: Revision::new(0)?,
            saved: Revision::new(0)?,
            rows: Vec::new(),
        };
        while let Some(row) = rows.next().map_err(sql_error)? {
            if activity.rows.is_empty() {
                activity.total = revision(row, "tasks")?;
                activity.active = revision(row, "active_tasks")?;
                activity.attention = revision(row, "attention_tasks")?;
                activity.saved = revision(row, "saved_tasks")?;
            }
            let progress = Progress {
                total: count(row, "total")?,
                queued: count(row, "queued")?,
                running: count(row, "running")?,
                succeeded: count(row, "succeeded")?,
                failed: count(row, "failed")?,
                cancelled: count(row, "cancelled")?,
                unknown: count(row, "unknown")?,
                adopted: count(row, "adopted")?,
            };
            if progress.total == 0 {
                return Err(error(ErrorCode::CorruptLedger, "task-activity-attempt"));
            }
            let phase = match row.get::<_, i64>("phase").map_err(sql_error)? {
                0 => TaskActivityPhase::Active,
                1 => TaskActivityPhase::Attention,
                2 => TaskActivityPhase::Saved,
                _ => return Err(error(ErrorCode::CorruptLedger, "task-activity-phase")),
            };
            activity.rows.push(TaskActivityRow {
                task_id: parse_id(row.get("task_id").map_err(sql_error)?)?,
                attempt_id: parse_id(row.get("attempt_id").map_err(sql_error)?)?,
                operation: row.get("operation").map_err(sql_error)?,
                sequence: revision(row, "sequence")?,
                phase,
                progress,
            });
        }
        Ok(activity)
    }
}
