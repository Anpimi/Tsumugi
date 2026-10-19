//! Historical tool attempts are execution references, never renewed authority.
use super::{MAX_TEAM_PAGE_BYTES, TeamWorkReference};
use crate::execution::{ExecutionId, Progress, Revision};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ReadTeamWorkTools {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub work: TeamWorkReference,
    pub after: Option<Revision>,
    #[cfg_attr(feature = "wire-schema", schemars(range(min = 1, max = 16)))]
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamWorkToolAttempt {
    pub sequence: Revision,
    /// An exact tool execution identity; it is not a team work or a scope.
    pub reference: TeamWorkReference,
    pub tool_handle: ExecutionId,
    /// The display title captured in the original tool declaration.
    pub name: String,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 100)))]
    pub unit_ids: Vec<ExecutionId>,
    /// The existing historical projection cannot confirm a live producer.
    pub progress: Progress,
    /// Items with a current result, not proof of validation, effect or drainage.
    pub stored_result_items: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TeamWorkToolHistory {
    pub project_id: ExecutionId,
    pub plan_id: ExecutionId,
    pub work: TeamWorkReference,
    #[cfg_attr(feature = "wire-schema", schemars(length(max = 16)))]
    pub attempts: Vec<TeamWorkToolAttempt>,
    pub next_after: Option<Revision>,
}
impl TeamWorkToolHistory {
    pub(crate) fn check_encoded_bound(&self) -> Result<(), crate::execution::ExecutionError> {
        crate::execution::codec::encode(self, MAX_TEAM_PAGE_BYTES)?;
        Ok(())
    }
}
