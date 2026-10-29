//! Bounded observations of the original plan action ledger, never execution permits.
use super::*;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanHistoryBaseline {
    pub lease: AutomationLease,
    /// Includes a proven team recovery start. A late enqueue changes this basis
    /// even when no new control generation has been committed.
    pub last_start: Option<WorkPlanStartReceipt>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum WorkPlanHistoryAction {
    #[serde(rename_all = "camelCase")]
    Authorize {
        digest: String,
        confirmed: bool,
        effects: Vec<AutomationEffect>,
        expires_at: UnsignedDecimal,
    },
    #[serde(rename_all = "camelCase")]
    Control {
        expected_generation: Revision,
        command: WorkPlanCommand,
        confirmed: bool,
        expires_at: Option<UnsignedDecimal>,
    },
    #[serde(rename_all = "camelCase")]
    TeamRecovery {
        digest: String,
        confirmed: bool,
        effects: Vec<AutomationEffect>,
        base_lease: AutomationLease,
        base_effective_version: TeamEffectiveVersion,
        expires_at_ms: UnsignedDecimal,
        #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 8)))]
        members: Vec<TeamExecutionMember>,
        work: TeamHumanWork,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanHistoryInput {
    pub task_id: ExecutionId,
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub parent_task: Option<ExecutionId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanHistoryRow {
    pub action_id: ExecutionId,
    pub lease: AutomationLease,
    pub state: WorkPlanState,
    pub cancellation_revision: Revision,
    pub action: WorkPlanHistoryAction,
    /// An authorized input is distinct from a durable enqueue.
    pub input: Option<WorkPlanHistoryInput>,
    pub start: Option<WorkPlanStartReceipt>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct WorkPlanHistoryPage {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub plan_digest: String,
    pub locale: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(min = 1, max = 100)))]
    pub scope: Vec<PlanSelectionBasis>,
    pub baseline: WorkPlanHistoryBaseline,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub rows: Vec<WorkPlanHistoryRow>,
    pub next_after: Option<Revision>,
}
