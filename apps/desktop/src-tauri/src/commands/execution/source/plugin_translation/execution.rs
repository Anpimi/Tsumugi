//! Separate producer/checker consent and durable proof feed the existing EX
//! translation projection. Reads and reconciliation never start a Worker.
use super::*;
use tsumugi_core::execution::TranslationValidationCapture;
use tsumugi_plugin_host::{HostLimits, core::RunnerProxy};

pub(super) struct CheckReview {
    pub(super) request: TranslationCheckPrepareRequest,
    producer: FixedInput,
    capture: TranslationValidationCapture,
    view: TranslationCheckReview,
}
pub(super) struct ProjectionReview {
    request: TranslationProjectionPrepareRequest,
    input: FixedInput,
    view: TranslationProjectionReview,
}
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationCheckPrepareRequest {
        translation_attempt_id: ExecutionId,
        translation_result_id: ExecutionId,
        attempt_id: ExecutionId,
        translation: PluginTranslationRequest
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationCheckFinishRequest {
        translation_attempt_id: ExecutionId,
        translation_result_id: ExecutionId,
        attempt_id: ExecutionId,
        result_id: ExecutionId
    }
);
request!(
    #[derive(PartialEq, Eq)]
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationProjectionPrepareRequest {
        translation_attempt_id: ExecutionId,
        translation_result_id: ExecutionId,
        attempt_id: ExecutionId
    }
);
request!(
    #[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
    TranslationProjectionStartRequest {
        attempt_id: ExecutionId,
        input_digest: String
    }
);
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationCheckReview {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub translation_attempt_id: ExecutionId,
    pub translation_result_id: ExecutionId,
    pub source: TranslationSourceContext,
    pub translation: PluginTranslationView,
    pub rules: Vec<sdk::ContractRef>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "wire-schema", derive(schemars::JsonSchema))]
pub struct TranslationProjectionReview {
    pub attempt_id: ExecutionId,
    pub input_digest: String,
    pub translation_attempt_id: ExecutionId,
    pub translation_result_id: ExecutionId,
    pub source: TranslationSourceContext,
    pub target_locale: String,
    pub item_count: u32,
}

fn current_input(
    store: &ProjectStore,
    producer: &FixedInput,
) -> Result<TranslationSourceContext, CommandError> {
    let (input, _) = content::plugin_translation_input(producer).map_err(map_source)?;
    let source = store
        .translation_source_context(&input.target_language)
        .map_err(map_source)?;
    if source.source_snapshot_id.to_string() != input.source_snapshot_id
        || source.source_set_id.to_string() != input.source_set_id
        || source.profile != input.profile
        || !source.native_scopes.contains(&input.native_scope)
    {
        return Err(conflict("translation-source"));
    }
    Ok(source)
}
fn matches_producer(
    input: &FixedInput,
    environment: &TranslationEnvironment,
) -> Result<(), CommandError> {
    let (_, settings) = content::plugin_translation_input(input).map_err(map_source)?;
    if input.envelope().plugin.as_ref() != Some(&execution_binding(environment, false))
        || settings.declaration != environment.binding.declaration
        || settings.checker != execution_binding(environment, true)
    {
        return Err(stale());
    }
    Ok(())
}
fn proxies(environment: &TranslationEnvironment) -> Result<[Arc<RunnerProxy>; 2], CommandError> {
    let proxy = |id: &str| {
        RunnerProxy::new(
            environment.package.image().clone(),
            id,
            environment.runtime.clone(),
            environment.staging_parent.clone(),
            HostLimits::default(),
        )
        .map(Arc::new)
        .map_err(map_source)
    };
    Ok([
        proxy(&environment.binding.declaration.extractor)?,
        proxy(&environment.binding.declaration.checker)?,
    ])
}

async fn start(
    state: State<'_, AppState>,
    request: PluginStartRequest,
    checker: bool,
) -> Result<ExecutionId, CommandError> {
    if !request.unsandboxed_execution
        || sdk::validate_package_digest(&request.input_digest).is_err()
    {
        return Err(map_source(ExecutionError::new(
            ErrorCode::Unauthorized,
            "plugin-consent-required",
        )));
    }
    let lease = state.sessions.lease(CommandStage::ExecutionRecover)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "start_plugin_translation.begin",
        CommandStage::ExecutionRecover,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRecover,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let previous = if checker {
                &host.source.translation.last_check_start
            } else {
                &host.source.translation.last_start
            };
            if previous.as_ref() == Some(&initial) {
                match store.execution_input(initial.attempt_id) {
                    Ok(input) if input.digest() == initial.input_digest => return Ok(None),
                    Ok(_) => return Err(stale()),
                    Err(error) if error.code == ErrorCode::InvalidInput => {}
                    Err(error) => return Err(map_source(error)),
                }
            }
            if previous
                .as_ref()
                .is_some_and(|prior| prior.attempt_id == initial.attempt_id && prior != &initial)
            {
                return Err(stale());
            }
            let (input, producer, choice) = if checker {
                let review = host
                    .source
                    .translation
                    .check
                    .as_ref()
                    .filter(|review| review.view.attempt_id == initial.attempt_id)
                    .ok_or_else(stale)?;
                (
                    review.capture.check_input().clone(),
                    review.producer.clone(),
                    review.request.translation.clone(),
                )
            } else {
                let review = host
                    .source
                    .translation
                    .review
                    .as_ref()
                    .filter(|review| review.view.attempt_id == initial.attempt_id)
                    .ok_or_else(stale)?;
                current_choice(store, &review.choice)?;
                (
                    review.input.clone(),
                    review.input.clone(),
                    review.choice.request.translation.clone(),
                )
            };
            if input.digest() != initial.input_digest {
                return Err(stale());
            }
            current_input(store, &producer)?;
            let work = host.begin_package_work(vec![choice.package.clone()])?;
            let id = plugin::begin_job(active)?;
            Ok(Some((id, input, producer, choice, work)))
        },
    )?;
    let plugins = state.plugins.clone();
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        let Some((id, input, producer, choice, work)) = admitted.await? else {
            return Ok(request.attempt_id);
        };
        let captured = producer.clone();
        let fixed = input.clone();
        let accepted_work = work.clone();
        let loaded = io
            .run(CommandStage::ExecutionRecover, move || {
                accepted_work.check()?;
                let environment = plugins.capture_translation(&choice)?;
                matches_producer(&captured, &environment)?;
                if fixed.envelope().plugin.as_ref()
                    != Some(&execution_binding(&environment, checker))
                {
                    return Err(stale());
                }
                let runners = proxies(&environment)?;
                Ok((environment, runners))
            })
            .await;
        lease
            .run(
                "start_plugin_translation.finish",
                CommandStage::ExecutionRecover,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    work.check()?;
                    let (host, store) = active.execution_parts()?;
                    current_input(store, &producer)?;
                    let (environment, runners) = loaded?;
                    for (index, runner) in runners.into_iter().enumerate() {
                        host.register_plugin(runner, execution_binding(&environment, index == 1))
                            .map_err(map_source)?;
                    }
                    host.runtime
                        .authorize_plugin(
                            store,
                            request.grant_id,
                            &input,
                            request.expires_at_ms.get(),
                            PluginConsent {
                                unsandboxed_execution: request.unsandboxed_execution,
                            },
                        )
                        .map_err(map_source)?;
                    // Preserve consent before enqueue can have an uncertain durable outcome.
                    // Exact retries reconcile; they do not replace a grant or restart work.
                    if checker {
                        host.source.translation.last_check_start = Some(request.clone());
                    } else {
                        host.source.translation.last_start = Some(request.clone());
                    }
                    host.runtime.submit(store, &input).map_err(map_source)?;
                    Ok(request.attempt_id)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRecover))?
}
#[tauri::command]
pub async fn start_plugin_translation(
    state: State<'_, AppState>,
    request: PluginStartRequest,
) -> Result<ExecutionId, CommandError> {
    start(state, request, false).await
}
#[tauri::command]
pub async fn start_translation_check(
    state: State<'_, AppState>,
    request: PluginStartRequest,
) -> Result<ExecutionId, CommandError> {
    start(state, request, true).await
}

#[tauri::command]
pub async fn prepare_translation_check(
    state: State<'_, AppState>,
    request: TranslationCheckPrepareRequest,
) -> Result<TranslationCheckReview, CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionRead)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "prepare_translation_check.begin",
        CommandStage::ExecutionRead,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionRead,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let existing = host
                .source
                .translation
                .check
                .as_ref()
                .filter(|review| review.request.attempt_id == initial.attempt_id)
                .cloned();
            if existing
                .as_ref()
                .is_some_and(|review| review.request != initial)
            {
                return Err(stale());
            }
            let captured = store
                .capture_result_validation(
                    initial.translation_attempt_id,
                    initial.translation_result_id,
                )
                .map_err(map_source)?;
            let source = current_input(store, captured.input())?;
            let original = match store.execution_input(initial.attempt_id) {
                Ok(input) => Some(input),
                Err(error) if error.code == ErrorCode::InvalidInput => None,
                Err(error) => return Err(map_source(error)),
            };
            let work = host.begin_package_work(vec![initial.translation.package.clone()])?;
            let id = plugin::begin_job(active)?;
            Ok((id, captured, source, original, existing, work))
        },
    )?;
    let io = state.io.clone();
    let plugins = state.plugins.clone();
    tauri::async_runtime::spawn(async move {
        let (id, captured, source, original, existing, work) = admitted.await?;
        let preparing = request.clone();
        let accepted_work = work.clone();
        let prepared = io
            .run(CommandStage::ExecutionRead, move || {
                accepted_work.check()?;
                let environment = plugins.capture_translation(&preparing.translation)?;
                matches_producer(captured.input(), &environment)?;
                if let Some(review) = existing {
                    return Ok(review);
                }
                let producer = captured.input().clone();
                let capture = match original {
                    Some(input) => captured.restore_translation_check(input),
                    None => captured.prepare_translation_check(preparing.attempt_id),
                }
                .map_err(map_source)?;
                let view = TranslationCheckReview {
                    attempt_id: preparing.attempt_id,
                    input_digest: capture.check_input().digest().into(),
                    translation_attempt_id: preparing.translation_attempt_id,
                    translation_result_id: preparing.translation_result_id,
                    source,
                    translation: environment.view()?,
                    rules: environment.binding.declaration.semantic_rules.clone(),
                };
                Ok(Arc::new(CheckReview {
                    request: preparing,
                    producer,
                    capture,
                    view,
                }))
            })
            .await;
        lease
            .run(
                "prepare_translation_check.finish",
                CommandStage::ExecutionRead,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    work.check()?;
                    let (host, store) = active.execution_parts()?;
                    let review = prepared?;
                    current_input(store, &review.producer)?;
                    let view = review.view.clone();
                    host.source.translation.check = Some(review);
                    Ok(view)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionRead))?
}

#[tauri::command]
pub async fn finish_translation_check(
    state: State<'_, AppState>,
    request: TranslationCheckFinishRequest,
) -> Result<(), CommandError> {
    let lease = state.sessions.lease(CommandStage::ExecutionAdopt)?;
    let initial = request.clone();
    let admitted = lease.submit(
        "finish_translation_check.capture",
        CommandStage::ExecutionAdopt,
        move |sessions| {
            let active = authorized(
                sessions,
                &initial.session_token,
                initial.project_id,
                CommandStage::ExecutionAdopt,
            )?;
            let (host, store) = active.execution_parts()?;
            host.allow_mutation()?;
            let producer = store
                .capture_result_validation(
                    initial.translation_attempt_id,
                    initial.translation_result_id,
                )
                .map_err(map_source)?;
            current_input(store, producer.input())?;
            let checker = store
                .capture_result_validation(initial.attempt_id, initial.result_id)
                .map_err(map_source)?;
            let check_input = checker.input().clone();
            let result = store
                .execution_result(initial.attempt_id, initial.result_id)
                .map_err(map_source)?;
            let id = plugin::begin_job(active)?;
            Ok((id, producer, check_input, result))
        },
    )?;
    let io = state.io.clone();
    tauri::async_runtime::spawn(async move {
        let (id, producer, check_input, result) = admitted.await?;
        let input = producer.input().clone();
        let prepared = io
            .run(CommandStage::ExecutionAdopt, move || {
                producer
                    .restore_translation_check(check_input)
                    .map_err(map_source)?
                    .prepare(result)
                    .map_err(map_source)
            })
            .await;
        lease
            .run(
                "finish_translation_check.commit",
                CommandStage::ExecutionAdopt,
                move |sessions| {
                    let active = finish(sessions, &request.session_token, request.project_id, id)?;
                    let (host, store) = active.execution_parts()?;
                    host.allow_mutation()?;
                    current_input(store, &input)?;
                    store
                        .commit_translation_validation(prepared?)
                        .map_err(map_source)
                },
            )
            .await
    })
    .await
    .map_err(|_| CommandError::unknown(CommandStage::ExecutionAdopt))?
}

#[tauri::command]
pub async fn prepare_translation_projection(
    state: State<'_, AppState>,
    request: TranslationProjectionPrepareRequest,
) -> Result<TranslationProjectionReview, CommandError> {
    state
        .sessions
        .lease(CommandStage::ExecutionRead)?
        .run(
            "prepare_translation_projection",
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
                let producer = store
                    .execution_input(request.translation_attempt_id)
                    .map_err(map_source)?;
                let source = current_input(store, &producer)?;
                if let Some(review) = &host.source.translation.projection {
                    if review.request.attempt_id == request.attempt_id {
                        if review.request != request {
                            return Err(stale());
                        }
                        return Ok(review.view.clone());
                    }
                }
                let input = store
                    .capture_translation_projection_with_id(
                        request.translation_attempt_id,
                        request.translation_result_id,
                        request.attempt_id,
                    )
                    .map_err(map_source)?;
                let (material, _) =
                    content::plugin_translation_input(&producer).map_err(map_source)?;
                let view = TranslationProjectionReview {
                    attempt_id: request.attempt_id,
                    input_digest: input.digest().into(),
                    translation_attempt_id: request.translation_attempt_id,
                    translation_result_id: request.translation_result_id,
                    source,
                    target_locale: material.target_language,
                    item_count: input.envelope().items.len() as u32,
                };
                host.source.translation.projection = Some(Arc::new(ProjectionReview {
                    request,
                    input,
                    view: view.clone(),
                }));
                Ok(view)
            },
        )
        .await
}

#[tauri::command]
pub async fn start_translation_projection(
    state: State<'_, AppState>,
    request: TranslationProjectionStartRequest,
) -> Result<ExecutionId, CommandError> {
    state
        .sessions
        .lease(CommandStage::ExecutionRecover)?
        .run(
            "start_translation_projection",
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
                match store.execution_input(request.attempt_id) {
                    Ok(input)
                        if input.digest() == request.input_digest
                            && input.envelope().capability_id
                                == content::TRANSLATION_PROJECTION_CAPABILITY =>
                    {
                        return Ok(request.attempt_id);
                    }
                    Ok(_) => return Err(stale()),
                    Err(error) if error.code == ErrorCode::InvalidInput => {}
                    Err(error) => return Err(map_source(error)),
                }
                let review = host
                    .source
                    .translation
                    .projection
                    .as_ref()
                    .filter(|review| {
                        review.view.attempt_id == request.attempt_id
                            && review.input.digest() == request.input_digest
                    })
                    .ok_or_else(stale)?;
                let producer = store
                    .execution_input(review.request.translation_attempt_id)
                    .map_err(map_source)?;
                current_input(store, &producer)?;
                host.runtime
                    .submit(store, &review.input)
                    .map_err(map_source)?;
                Ok(request.attempt_id)
            },
        )
        .await
}
