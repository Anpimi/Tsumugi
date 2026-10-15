//! Bounded maintenance intent, captured by the ordinary immutable work plan.
use super::*;

/// Ordinary plans must serialize an explicit null, rather than omit the field.
pub fn required_maintenance<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<MaintenancePlanBasis>, D::Error> {
    Option::deserialize(deserializer)
}

// A custom schema keeps this field required and nullable. Schemars' `required`
// validation instead removes null from an Option's schema.
#[cfg(feature = "wire-schema")]
pub fn maintenance_schema(generator: &mut schemars::SchemaGenerator) -> schemars::Schema {
    <Option<MaintenancePlanBasis> as schemars::JsonSchema>::json_schema(generator)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub enum MaintenanceAction {
    Keep,
    Recheck,
    Repair,
    Unresolved,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct MaintenanceRow {
    pub unit_id: ExecutionId,
    pub source_revision_id: ExecutionId,
    pub native_key: String,
    pub source_text: String,
    pub translation_text: Option<String>,
    pub selection_id: Option<ExecutionId>,
    pub translation_revision_id: Option<ExecutionId>,
    pub review_basis: String,
    pub protection: WorkProtection,
    pub mapping_unresolved: bool,
    pub reasons: Vec<String>,
    pub suggested: MaintenanceAction,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct MaintenanceAssessment {
    pub project_id: ExecutionId,
    pub source_snapshot_id: ExecutionId,
    pub locale: String,
    pub after: u32,
    pub limit: u32,
    pub next_ordinal: Option<u32>,
    pub rows: Vec<MaintenanceRow>,
    pub coverage: String,
    pub digest: String,
}
impl MaintenanceAssessment {
    pub(crate) fn computed_digest(&self) -> Result<String, ExecutionError> {
        let mut value = self.clone();
        value.digest.clear();
        Ok(codec::digest(&codec::encode(&value, MAX_INPUT_BYTES)?))
    }

    pub fn validate(&self) -> Result<(), ExecutionError> {
        if self.limit == 0
            || self.limit > 100
            || self.rows.len() > self.limit as usize
            || self
                .rows
                .iter()
                .map(|row| row.unit_id)
                .collect::<BTreeSet<_>>()
                .len()
                != self.rows.len()
            || self.digest != self.computed_digest()?
            || self.rows.iter().any(|row| {
                row.protection.unit_id != row.unit_id || row.protection.locale != self.locale
            })
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "maintenance-assessment",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct MaintenanceChoice {
    pub unit_id: ExecutionId,
    pub action: MaintenanceAction,
    pub excluded: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct MaintenancePlanBasis {
    pub assessment: MaintenanceAssessment,
    pub choices: Vec<MaintenanceChoice>,
}
impl MaintenancePlanBasis {
    pub fn repair_units(&self) -> Result<Vec<ExecutionId>, ExecutionError> {
        self.assessment.validate()?;
        let members: BTreeSet<_> = self.assessment.rows.iter().map(|row| row.unit_id).collect();
        if self.choices.len() != members.len()
            || self
                .choices
                .iter()
                .map(|choice| choice.unit_id)
                .collect::<BTreeSet<_>>()
                != members
        {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "maintenance-choices",
            ));
        }
        let mut units = Vec::new();
        for choice in &self.choices {
            // Exact membership and uniqueness above make this lookup total.
            let row = self
                .assessment
                .rows
                .iter()
                .find(|row| row.unit_id == choice.unit_id)
                .unwrap();
            if !choice.excluded && choice.action == MaintenanceAction::Repair {
                if row.protection.protected || row.mapping_unresolved {
                    return Err(ExecutionError::new(
                        ErrorCode::DependencyConflict,
                        "maintenance-excluded",
                    ));
                }
                units.push(row.unit_id);
            }
        }
        units.sort();
        if units.is_empty() {
            return Err(ExecutionError::new(
                ErrorCode::InvalidInput,
                "maintenance-empty",
            ));
        }
        Ok(units)
    }
}
