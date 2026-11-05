//! Bounded, explicit build choices captured in the existing configuration payloads.
use super::*;

fn label(value: &str) -> Result<(), ContractError> {
    if value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(invalid("build.configuration.displayName"));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildOptionChoice {
    pub id: String,
    pub display_name: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildOptionDeclaration {
    pub id: String,
    pub display_name: String,
    pub choices: Vec<BuildOptionChoice>,
}
/// All options require an explicit selection; neither source nor target locale
/// supplies a default. Values carry no file access or execution authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildConfigurationDeclaration {
    pub schema: ContractRef,
    pub display_name: String,
    pub options: Vec<BuildOptionDeclaration>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildOptionSelection {
    pub id: String,
    pub value: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildConfigurationSelection {
    pub schema: ContractRef,
    pub selections: Vec<BuildOptionSelection>,
}
/// JSON body of one declared EncodedPayload. IDs are package-owned opaque choices.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct BuildConfigurationValues {
    pub selections: Vec<BuildOptionSelection>,
}
impl BuildConfigurationDeclaration {
    pub fn validate(&self) -> Result<(), ContractError> {
        reference(&self.schema, "build.configuration.schema")?;
        label(&self.display_name)?;
        if self.options.is_empty() || self.options.len() > 32 {
            return Err(invalid("build.configuration.options"));
        }
        unique(
            self.options.iter().map(|option| &option.id),
            "build.configuration.options.id",
        )?;
        for option in &self.options {
            name(&option.id, "build.configuration.options.id")?;
            label(&option.display_name)?;
            if option.choices.is_empty() || option.choices.len() > 32 {
                return Err(invalid("build.configuration.choices"));
            }
            unique(
                option.choices.iter().map(|choice| &choice.id),
                "build.configuration.choices.id",
            )?;
            for choice in &option.choices {
                name(&choice.id, "build.configuration.choices.id")?;
                label(&choice.display_name)?;
            }
        }
        Ok(())
    }
    fn ordered(
        &self,
        selections: &[BuildOptionSelection],
    ) -> Result<Vec<BuildOptionSelection>, ContractError> {
        self.validate()?;
        if selections.len() != self.options.len() {
            return Err(invalid("build.configuration.selections"));
        }
        unique(
            selections.iter().map(|selection| &selection.id),
            "build.configuration.selections.id",
        )?;
        self.options
            .iter()
            .map(|option| {
                let selection = selections
                    .iter()
                    .find(|selection| selection.id == option.id)
                    .ok_or_else(|| invalid("build.configuration.selections.id"))?;
                if !option
                    .choices
                    .iter()
                    .any(|choice| choice.id == selection.value)
                {
                    return Err(invalid("build.configuration.selections.value"));
                }
                Ok(selection.clone())
            })
            .collect()
    }
    pub fn capture(
        &self,
        selections: &[BuildOptionSelection],
    ) -> Result<EncodedPayload, ContractError> {
        let values = BuildConfigurationValues {
            selections: self.ordered(selections)?,
        };
        let utf8 = serde_json::to_string(&values).map_err(|_| invalid("build.configuration"))?;
        EncodedPayload::capture(self.schema.clone(), utf8)
    }
    pub fn read(
        &self,
        payload: &EncodedPayload,
    ) -> Result<BuildConfigurationValues, ContractError> {
        payload.validate()?;
        if payload.schema != self.schema || payload.utf8.len() > MAX_BUILD_DECLARATION_BYTES {
            return Err(invalid("build.configuration.payload"));
        }
        let values: BuildConfigurationValues = serde_json::from_str(&payload.utf8)
            .map_err(|_| invalid("build.configuration.payload"))?;
        self.ordered(&values.selections)?;
        Ok(values)
    }
}
impl BuildDeclaration {
    pub fn capture_configuration(
        &self,
        selections: &[BuildConfigurationSelection],
    ) -> Result<Vec<EncodedPayload>, ContractError> {
        self.validate()?;
        let declared = self.configuration.as_deref().unwrap_or(&[]);
        if selections.len() != declared.len() {
            return Err(invalid("build.configuration"));
        }
        unique(
            selections.iter().map(|selection| &selection.schema),
            "build.configuration.schema",
        )?;
        declared
            .iter()
            .map(|declaration| {
                let selected = selections
                    .iter()
                    .find(|selection| selection.schema == declaration.schema)
                    .ok_or_else(|| invalid("build.configuration.schema"))?;
                declaration.capture(&selected.selections)
            })
            .collect()
    }
    pub fn validate_configuration(&self, payloads: &[EncodedPayload]) -> Result<(), ContractError> {
        self.validate()?;
        if payloads.len() > 32 {
            return Err(invalid("build.configuration"));
        }
        unique(
            payloads.iter().map(|payload| &payload.schema),
            "build.configuration.schema",
        )?;
        for payload in payloads {
            payload.validate()?;
        }
        // Exact historical resources retain their opaque configuration meaning.
        let Some(declared) = &self.configuration else {
            return Ok(());
        };
        if payloads.len() != declared.len() {
            return Err(invalid("build.configuration"));
        }

        for declaration in declared {
            let payload = payloads
                .iter()
                .find(|payload| payload.schema == declaration.schema)
                .ok_or_else(|| invalid("build.configuration.schema"))?;
            declaration.read(payload)?;
        }
        Ok(())
    }
}
