//! Multi-configuration translation uses the ordinary execution lifecycle.
use super::*;
use std::collections::BTreeSet;

pub const OPERATION: &str = "arena-translation";
pub const CAPABILITY: &str = "openai-compatible.arena";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct ArenaConfig {
    pub variants: Vec<AiConfig>,
    pub max_items: u32,
    pub max_requests: u32,
    pub concurrency: u32,
    pub blind: bool,
    pub parent_attempt_id: Option<ExecutionId>,
}
impl ArenaConfig {
    pub fn validate(&self, count: usize) -> Result<(), ExecutionError> {
        if !(2..=4).contains(&self.variants.len())
            || !(1..=100).contains(&self.max_items)
            || count == 0
            || count > self.max_items as usize
            || count * self.variants.len() > 100
            || !(1..=300).contains(&self.max_requests)
            || !(1..=2).contains(&self.concurrency)
            || count * self.variants.len() > self.max_requests as usize
        {
            return Err(error(ErrorCode::LimitExceeded, "arena-limits"));
        }
        for config in &self.variants {
            config.validate()?;
        }
        Ok(())
    }
    pub fn request_config(&self, slot: usize) -> Result<AiConfig, ExecutionError> {
        let mut config = self
            .variants
            .get(slot)
            .cloned()
            .ok_or_else(|| error(ErrorCode::InvalidInput, "arena-slot"))?;
        config.max_requests = self.max_requests;
        config.concurrency = self.concurrency;
        config.max_items = self.max_items;
        Ok(config)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArenaItem {
    pub slot: usize,
    pub source_order: usize,
    pub item: AiItem,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArenaPreview {
    pub config: ArenaConfig,
    pub items: Vec<ArenaItem>,
    pub digest: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArenaSettings {
    pub config: ArenaConfig,
    pub recipe: String,
    pub preview_digest: String,
    pub display_order: Vec<usize>,
}
pub fn digest(config: &ArenaConfig, items: &[ArenaItem]) -> Result<String, ExecutionError> {
    Ok(codec::digest(&codec::encode(
        &(RECIPE, config, items),
        MAX_INPUT_BYTES,
    )?))
}
pub fn shuffled_order(count: usize, blind: bool) -> Vec<usize> {
    let mut order: Vec<_> = (0..count).collect();
    if blind {
        // UUID v4 supplies OS randomness; the resulting mapping is fixed input.
        for i in (1..count).rev() {
            let random = uuid::Uuid::new_v4().as_u128();
            order.swap(i, (random % (i as u128 + 1)) as usize);
        }
    }
    order
}
impl ArenaPreview {
    pub fn fixed_input(&self, project: crate::ProjectId) -> Result<FixedInput, ExecutionError> {
        let mut items = Vec::new();
        // Execution normalizes by item ID. Consecutive suffixes retain the
        // declared source/variant order without changing other operations.
        let prefix = uuid::Uuid::new_v4().as_u128() & !0xffff;
        for (i, payload) in self.items.iter().enumerate() {
            let mut item = InputItem::new(
                Scope {
                    kind: "translation-unit".into(),
                    id: payload.item.unit_id.to_string(),
                    locale: Some(payload.item.target_locale.clone()),
                },
                serde_json::to_value(payload)
                    .map_err(|_| error(ErrorCode::InvalidInput, "arena-input"))?,
                vec![],
            );
            item.item_id =
                ExecutionId::parse(&uuid::Uuid::from_u128(prefix | i as u128).to_string())?;
            items.push(item);
        }
        let mut e = InputEnvelope::new(project, OPERATION, CAPABILITY, "1", items)?;
        e.settings = serde_json::to_value(ArenaSettings {
            config: self.config.clone(),
            recipe: RECIPE.into(),
            preview_digest: self.digest.clone(),
            display_order: shuffled_order(self.config.variants.len(), self.config.blind),
        })
        .map_err(|_| error(ErrorCode::InvalidInput, "arena-input"))?;
        e.limits.timeout_ms = self
            .config
            .variants
            .iter()
            .map(|c| ((c.timeout_seconds * 1000 + 1000) * (c.max_retries + 1)).min(600_000))
            .max()
            .ok_or_else(|| error(ErrorCode::InvalidInput, "arena-input"))?;
        let input = FixedInput::capture(e)?;
        settings(&input)?;
        Ok(input)
    }
}
pub fn item_payload(input: &FixedInput, id: ExecutionId) -> Result<ArenaItem, ExecutionError> {
    let raw = input.item(id)?;
    let p: ArenaItem = codec::decode(
        &codec::encode(&raw.payload, MAX_INPUT_BYTES)?,
        MAX_INPUT_BYTES,
    )?;
    if raw.scope.kind != "translation-unit"
        || raw.scope.id != p.item.unit_id.to_string()
        || raw.scope.locale.as_deref() != Some(p.item.target_locale.as_str())
        || Locale::parse(&p.item.target_locale)
            .ok()
            .as_ref()
            .map(Locale::as_str)
            != Some(p.item.target_locale.as_str())
    {
        return Err(error(ErrorCode::InvalidInput, "arena-scope"));
    }
    request_body(&AiConfig::default(), &p.item)?;
    Ok(p)
}
pub fn settings(input: &FixedInput) -> Result<ArenaSettings, ExecutionError> {
    let e = input.envelope();
    let s: ArenaSettings = codec::decode(
        &codec::encode(&e.settings, MAX_INPUT_BYTES)?,
        MAX_INPUT_BYTES,
    )?;
    if e.operation != OPERATION
        || e.capability_id != CAPABILITY
        || e.capability_version != "1"
        || s.recipe != RECIPE
        || e.previous_attempt_id.is_some()
        || !e.reused_results.is_empty()
        || e.items.len() != e.units.len()
        || s.config.parent_attempt_id == Some(e.attempt_id)
    {
        return Err(error(ErrorCode::InvalidInput, "arena-input"));
    }
    let slots = s.config.variants.len();
    if slots == 0 || e.items.len() % slots != 0 {
        return Err(error(ErrorCode::InvalidInput, "arena-input"));
    }
    let count = e.items.len() / slots;
    s.config.validate(count)?;
    if s.display_order.len() != slots
        || s.display_order.iter().copied().collect::<BTreeSet<_>>() != (0..slots).collect()
    {
        return Err(error(ErrorCode::InvalidInput, "arena-order"));
    }
    let mut payloads = Vec::new();
    let mut sources = BTreeSet::new();
    for (index, raw) in e.items.iter().enumerate() {
        let p = item_payload(input, raw.item_id)?;
        if p.source_order != index / slots || p.slot != index % slots {
            return Err(error(ErrorCode::InvalidInput, "arena-order"));
        }
        if p.slot == 0 {
            if !sources.insert(p.item.unit_id) {
                return Err(error(ErrorCode::InvalidInput, "arena-scope"));
            }
        } else {
            let first: &ArenaItem = &payloads[index - p.slot];
            if first.item.unit_id != p.item.unit_id
                || first.item.source_revision_id != p.item.source_revision_id
                || first.item.source_snapshot_id != p.item.source_snapshot_id
                || first.item.source_text != p.item.source_text
                || first.item.source_locale != p.item.source_locale
                || first.item.target_locale != p.item.target_locale
            {
                return Err(error(ErrorCode::InvalidInput, "arena-source"));
            }
        }
        if let Some(first) = payloads.first() {
            let first: &ArenaItem = first;
            if first.item.target_locale != p.item.target_locale
                || first.item.source_snapshot_id != p.item.source_snapshot_id
            {
                return Err(error(ErrorCode::InvalidInput, "arena-source"));
            }
        }
        payloads.push(p);
    }
    if digest(&s.config, &payloads)? != s.preview_digest {
        return Err(error(ErrorCode::InvalidInput, "arena-preview"));
    }
    Ok(s)
}
pub fn validate_output(
    input: &FixedInput,
    result: &FixedResult,
) -> Result<AiOutput, ExecutionError> {
    settings(input)?;
    super::validate_item_output(
        &item_payload(input, result.envelope().item_id)?.item,
        result,
    )
}
#[derive(Default)]
pub struct ArenaRunner {
    transport: AiRunner,
}
impl Runner for ArenaRunner {
    fn capability_id(&self) -> &str {
        CAPABILITY
    }
    fn capability_version(&self) -> &str {
        "1"
    }
    fn concurrency_limit(&self, input: &FixedInput) -> usize {
        settings(input)
            .map(|s| s.config.concurrency as usize)
            .unwrap_or(1)
    }
    fn run(
        &self,
        request: DispatchRequest,
        cancel: Cancellation,
        results: ResultSender,
    ) -> Result<(), ExecutionError> {
        let outcome = (|| {
            let s = settings(&request.input)?;
            let p = item_payload(&request.input, request.item_id)?;
            self.transport.execute_config(
                &request,
                &cancel,
                &s.config.request_config(p.slot)?,
                &p.item,
            )
        })();
        super::send_outcome(request, results, outcome)
    }
}
