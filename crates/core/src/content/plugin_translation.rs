//! Complete plugin translation evidence, before project-local entry projection.
//! Domain filenames, decoding and canonical native values belong to the plugin.
use super::*;

pub const TRANSLATION_EXTRACTION_OPERATION: &str = "translation-extract";
pub const MAX_TRANSLATION_INPUT_BYTES: usize = 1024 * 1024;
pub const MAX_TRANSLATION_RESULT_BYTES: usize = 2 * 1024 * 1024;

fn invalid(stage: &str) -> ExecutionError {
    ExecutionError::new(ErrorCode::InvalidInput, stage)
}
fn contract_error(error: sdk::ContractError) -> ExecutionError {
    ExecutionError::new(
        if error.code == sdk::ContractErrorCode::LimitExceeded {
            ErrorCode::LimitExceeded
        } else {
            ErrorCode::OutputInvalid
        },
        "translation-contract",
    )
}

/// Trusted application selection captured independently of the proposal.
/// This metadata grants neither execution nor translation adoption.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginTranslationSettings {
    pub declaration: sdk::TranslationImportDeclaration,
    pub checker: PluginExecutionBinding,
}
impl PluginTranslationSettings {
    fn binding(
        &self,
        producer: &PluginExecutionBinding,
    ) -> Result<sdk::TranslationImportBinding, ExecutionError> {
        producer.validate_project_or_attempt()?;
        self.checker.validate_project_or_attempt()?;
        if producer.profile.as_ref() != Some(&self.declaration.profile)
            || self.checker.profile.as_ref() != Some(&self.declaration.profile)
        {
            return Err(invalid("translation-profile"));
        }
        let binding = sdk::TranslationImportBinding {
            declaration: self.declaration.clone(),
            extractor: producer.capability.clone(),
            checker: self.checker.capability.clone(),
        };
        binding.validate().map_err(contract_error)?;
        Ok(binding)
    }

    pub fn fixed_input(
        &self,
        project: ProjectId,
        material: sdk::TranslationExtractionInput,
        producer: PluginExecutionBinding,
    ) -> Result<FixedInput, ExecutionError> {
        self.binding(&producer)?
            .validate_input(&material)
            .map_err(contract_error)?;
        let item = InputItem::new(
            Scope {
                kind: "translation-file".into(),
                id: material.import_id.clone(),
                locale: Some(material.target_language.clone()),
            },
            value(&material)?,
            vec![],
        );
        let mut envelope = InputEnvelope::new(
            project,
            TRANSLATION_EXTRACTION_OPERATION,
            &producer.capability.declaration.contract.id,
            &producer.capability_version(),
            vec![item],
        )?;
        envelope.settings = value(self)?;
        envelope.limits.max_result_bytes = MAX_TRANSLATION_RESULT_BYTES as u32;
        envelope.limits.timeout_ms = envelope
            .limits
            .timeout_ms
            .min(producer.capability.declaration.limits.timeout_ms);
        envelope.plugin = Some(producer);
        let fixed = FixedInput::capture(envelope)?;
        plugin_translation_input(&fixed)?;
        Ok(fixed)
    }
}

/// Structural input restoration is pure. The store separately checks the
/// current project/source and the live execution grant at its mutation boundary.
pub fn plugin_translation_input(
    input: &FixedInput,
) -> Result<(sdk::TranslationExtractionInput, PluginTranslationSettings), ExecutionError> {
    let envelope = input.envelope();
    if input.bytes().len() > MAX_TRANSLATION_INPUT_BYTES {
        return Err(ExecutionError::new(
            ErrorCode::LimitExceeded,
            "translation-input-budget",
        ));
    }
    let producer = envelope
        .plugin
        .as_ref()
        .ok_or_else(|| invalid("translation-producer"))?;
    if envelope.operation != TRANSLATION_EXTRACTION_OPERATION
        || envelope.capability_id != producer.capability.declaration.contract.id
        || envelope.capability_version != producer.capability_version()
        || envelope.items.len() != 1
        || envelope.units.len() != 1
        || envelope.units[0].item_ids != vec![envelope.items[0].item_id]
        || !envelope.items[0].dependencies.is_empty()
        || envelope.limits.max_result_bytes as usize > MAX_TRANSLATION_RESULT_BYTES
    {
        return Err(invalid("translation-input"));
    }
    let material: sdk::TranslationExtractionInput = from_value(&envelope.items[0].payload)?;
    let settings: PluginTranslationSettings = from_value(&envelope.settings)?;
    settings
        .binding(producer)?
        .validate_input(&material)
        .map_err(contract_error)?;
    let locale =
        Locale::parse(&material.target_language).map_err(|_| invalid("translation-language"))?;
    if locale.as_str() != material.target_language
        || envelope.items[0].scope.kind != "translation-file"
        || envelope.items[0].scope.id != material.import_id
        || envelope.items[0].scope.locale.as_deref() != Some(&material.target_language)
    {
        return Err(invalid("translation-scope"));
    }
    Ok((material, settings))
}

/// Receive the original channel-bound SDK bytes, rather than trusting a JSON
/// projection or allocating project units from operation-local plugin IDs.
pub fn validate_plugin_translation_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<sdk::TranslationExchange, ExecutionError> {
    let (material, _) = plugin_translation_input(input)?;
    FixedResult::restore(
        result.bytes(),
        result.digest(),
        input,
        result.envelope().dispatch_token,
    )?;
    let evidence = result
        .envelope()
        .plugin
        .as_ref()
        .ok_or_else(|| invalid("translation-result"))?;
    let sdk::InvocationOutcome::Succeeded { output } = &evidence.result.outcome else {
        return Err(invalid("translation-result"));
    };
    if result.envelope().item_id != input.envelope().items[0].item_id
        || result.envelope().outcome != ExecutionState::Succeeded
        || output.schema != sdk::translation_exchange_contract()
    {
        return Err(invalid("translation-result"));
    }
    let proposal =
        sdk::parse_translation_exchange(output.utf8.as_bytes()).map_err(contract_error)?;
    sdk::validate_translation_extraction(&material, &proposal).map_err(contract_error)?;
    Ok(proposal)
}
