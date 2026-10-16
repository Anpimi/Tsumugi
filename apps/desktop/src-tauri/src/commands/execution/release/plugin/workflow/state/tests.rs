use super::*;
use serde_json::{Value, json};

fn fixture() -> (
    WorkflowSession,
    ArtifactCheckWorkflowPreparation,
    ArtifactCheckWorkflowStart,
) {
    let raw: Value = serde_json::from_str(include_str!(
        "../../../../../../../../test/fixtures/pluginBuildWorkflow.contract.json"
    ))
    .unwrap();
    let review: ArtifactCheckReview = serde_json::from_value(raw["checkReview"].clone()).unwrap();
    let mut workflow = WorkflowSession::default();
    let identity = ArtifactCheckWorkflowIdentity {
        owner_id: workflow.owner,
        generation: workflow.next().unwrap(),
        workflow_id: ExecutionId::new(),
    };
    let first = ArtifactCheckWorkflowStepIdentity {
        locale: review.locale.clone(),
        build_item_id: ExecutionId::new(),
        build_result_id: review.build_result_id,
        producer_attempt_id: review.build_attempt_id,
        producer_input_digest: "b".repeat(64),
        task_id: ExecutionId::new(),
        attempt_id: review.attempt_id,
        input_digest: review.input_digest.clone(),
    };
    let mut second = first.clone();
    second.locale = "fr-FR".into();
    second.build_item_id = ExecutionId::new();
    second.build_result_id = ExecutionId::new();
    second.task_id = ExecutionId::new();
    second.attempt_id = ExecutionId::new();
    let preparation = ArtifactCheckWorkflowPreparation {
        identity: identity.clone(),
        build_attempt_id: review.build_attempt_id,
        build_input_digest: "b".repeat(64),
        build_results: vec![
            ArtifactCheckBuildResultRef {
                item_id: first.build_item_id,
                result_id: first.build_result_id,
            },
            ArtifactCheckBuildResultRef {
                item_id: second.build_item_id,
                result_id: second.build_result_id,
            },
        ],
        build: serde_json::from_value(raw["prepare"]["build"].clone()).unwrap(),
    };
    let steps = [first, second]
        .into_iter()
        .enumerate()
        .map(|(ordinal, step)| {
            let mut review = review.clone();
            review.attempt_id = step.attempt_id;
            review.input_digest = step.input_digest.clone();
            review.locale = step.locale.clone();
            review.build_result_id = step.build_result_id;
            ArtifactCheckWorkflowStepView {
                ordinal: ordinal as u32,
                step,
                build_result_digest: "d".repeat(64),
                review,
                selected: false,
                phase: ArtifactCheckWorkflowStepPhase::Prepared,
                proof: None,
                error: None,
            }
        })
        .collect::<Vec<_>>();
    let start = ArtifactCheckWorkflowStart {
        identity,
        materialization_digest: "e".repeat(64),
        consents: vec![ArtifactCheckWorkflowConsent {
            step: steps[1].step.clone(),
            grant_id: ExecutionId::new(),
            expires_at_ms: UnsignedDecimal::parse(
                &(SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()
                    + 60_000)
                    .to_string(),
            )
            .unwrap(),
            unsandboxed_execution: true,
        }],
    };
    workflow.consumed = preparation.identity.generation;
    workflow.current = Some(Intent {
        view: ArtifactCheckWorkflowView {
            preparation: preparation.clone(),
            materialization_digest: Some(start.materialization_digest.clone()),
            phase: ArtifactCheckWorkflowPhase::Prepared,
            start: None,
            steps,
            admission_closed: false,
            callbacks_drained: true,
            current_task: None,
            error: None,
        },
        captures: vec![],
        deadlines: BTreeMap::new(),
        io: BlockingExecutor::new(1),
        plugins: Arc::new(ApplicationPlugins::default()),
        active: None,
        allow_current_proof: true,
        cancel_actions: BTreeMap::new(),
    });
    (workflow, preparation, start)
}

#[test]
fn artifact_workflow_start_freezes_subset_body_and_original_monotonic_deadlines() {
    let (mut workflow, preparation, start) = fixture();
    let accepted = workflow.start(&start).unwrap();
    assert_eq!(accepted.phase, ArtifactCheckWorkflowPhase::Running);
    assert_eq!(
        accepted.steps[0].phase,
        ArtifactCheckWorkflowStepPhase::NotSelected
    );
    assert_eq!(
        accepted.steps[1].phase,
        ArtifactCheckWorkflowStepPhase::Waiting
    );
    assert!(
        accepted.current_task.is_none(),
        "a prepared launch is not an accepted Task"
    );
    let deadline = workflow.current.as_ref().unwrap().deadlines[&start.consents[0].step.attempt_id];
    assert_eq!(workflow.start(&start).unwrap().start.as_ref(), Some(&start));
    assert_eq!(
        workflow.current.as_ref().unwrap().deadlines[&start.consents[0].step.attempt_id],
        deadline
    );
    for field in 0..3 {
        let mut changed = start.clone();
        match field {
            0 => changed.consents[0].grant_id = ExecutionId::new(),
            1 => {
                changed.consents[0].expires_at_ms =
                    UnsignedDecimal::parse(&(start.consents[0].expires_at_ms.get() + 1).to_string())
                        .unwrap()
            }
            _ => changed.consents[0].step.producer_input_digest = "a".repeat(64),
        }
        assert!(workflow.start(&changed).is_err());
    }
    workflow.close(true);
    workflow.retire_if_drained();
    assert!(workflow.current.is_none());
    assert_eq!(
        workflow.start(&start).unwrap().phase,
        ArtifactCheckWorkflowPhase::Stopped
    );
    assert!(
        workflow.current.is_none(),
        "historical Start ACK never recreates an intent"
    );
    let mut changed = preparation.clone();
    changed.build_input_digest = "a".repeat(64);
    assert!(workflow.existing(&changed).is_err());
    assert_eq!(
        workflow
            .existing(&preparation)
            .unwrap()
            .unwrap()
            .preparation,
        preparation
    );
}

#[test]
fn artifact_workflow_stop_keeps_pending_io_owned_and_discards_its_late_prepare() {
    let (mut workflow, preparation, start) = fixture();
    let temporary = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        temporary.path().join("project"),
        tsumugi_core::ProjectMetadata::create("Late preparation", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut host = ExecutionHost::new(&store).unwrap();
    let work = host
        .begin_package_work(vec![preparation.build.package.clone()])
        .unwrap();
    let (sender, receiver) = mpsc::sync_channel(1);
    workflow.current.as_mut().unwrap().view.phase = ArtifactCheckWorkflowPhase::Preparing;
    workflow.current.as_mut().unwrap().view.steps.clear();
    workflow
        .current
        .as_mut()
        .unwrap()
        .view
        .materialization_digest = None;
    workflow.job = Some(Job {
        receiver,
        kind: JobKind::Prepare,
        work,
    });
    workflow.close(true);
    workflow.refresh(&store, &host.runtime).unwrap();
    assert!(workflow.busy());
    assert!(!workflow.current.as_ref().unwrap().view.callbacks_drained);
    assert!(
        workflow
            .current
            .as_ref()
            .unwrap()
            .view
            .current_task
            .is_none()
    );
    assert!(workflow.start(&start).is_err());
    let mut next = preparation.clone();
    next.identity.generation = workflow.next().unwrap();
    next.identity.workflow_id = ExecutionId::new();
    let next_work = host
        .begin_package_work(vec![next.build.package.clone()])
        .unwrap();
    assert_eq!(
        workflow
            .begin(
                next,
                vec![],
                BlockingExecutor::new(1),
                Arc::new(ApplicationPlugins::default()),
                next_work
            )
            .err()
            .expect("old callback owns the generation barrier")
            .code,
        CommandErrorCode::Busy
    );
    // This is the real owner receiver boundary. A stopped intent must not
    // publish even a successfully returned materialization or authorize work.
    assert!(sender.send(Ok(Output::Prepared(vec![], vec![]))).is_ok());
    let sequence = store.execution_sequence().unwrap();
    workflow.tick(&mut host, &mut store).unwrap();
    assert!(!workflow.busy());
    assert!(workflow.current.is_none());
    let retired = workflow.existing(&preparation).unwrap().unwrap();
    assert_eq!(retired.phase, ArtifactCheckWorkflowPhase::Stopped);
    assert!(retired.callbacks_drained);
    assert!(retired.materialization_digest.is_none());
    assert!(retired.steps.is_empty());
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    assert!(!host.runtime.has_active_work(&store).unwrap());
    let work = host
        .begin_package_work(vec![preparation.build.package.clone()])
        .unwrap();
    assert!(
        workflow
            .begin(
                preparation,
                vec![],
                BlockingExecutor::new(1),
                Arc::new(ApplicationPlugins::default()),
                work
            )
            .is_err()
    );
}

#[test]
fn artifact_workflow_stop_before_launch_completion_cannot_enqueue_or_expose_a_nonexistent_task() {
    let (mut workflow, preparation, start) = fixture();
    workflow.start(&start).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        temporary.path().join("project"),
        tsumugi_core::ProjectMetadata::create("Late launch", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let mut host = ExecutionHost::new(&store).unwrap();
    let work = host
        .begin_package_work(vec![preparation.build.package.clone()])
        .unwrap();
    let (sender, receiver) = mpsc::sync_channel(1);
    workflow.current.as_mut().unwrap().active = Some(1);
    workflow.job = Some(Job {
        receiver,
        kind: JobKind::Launch(1),
        work,
    });
    workflow.close(true);
    workflow.refresh(&store, &host.runtime).unwrap();
    assert!(!workflow.current.as_ref().unwrap().view.callbacks_drained);
    assert!(
        workflow
            .current
            .as_ref()
            .unwrap()
            .view
            .current_task
            .is_none()
    );
    assert!(sender.send(Ok(Output::Runners(vec![]))).is_ok());
    let sequence = store.execution_sequence().unwrap();
    workflow.tick(&mut host, &mut store).unwrap();
    assert!(!workflow.busy());
    assert!(
        store
            .reconcile_plugin_start(
                start.consents[0].grant_id,
                start.consents[0].step.attempt_id,
                &start.consents[0].step.input_digest,
                start.consents[0].expires_at_ms.get(),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                },
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(store.execution_sequence().unwrap(), sequence);
    let view = workflow.existing(&preparation).unwrap().unwrap();
    assert_eq!(
        view.steps[1].phase,
        ArtifactCheckWorkflowStepPhase::NotStarted
    );
    assert!(view.current_task.is_none());
    assert!(view.callbacks_drained);
    assert_eq!(
        workflow.start(&start).unwrap().phase,
        ArtifactCheckWorkflowPhase::Stopped
    );
    assert!(!host.runtime.has_active_work(&store).unwrap());
}

#[test]
fn artifact_workflow_wire_requires_nullable_observation_fields_and_keeps_pending_distinct() {
    let (workflow, preparation, start) = fixture();
    let view = serde_json::to_value(&workflow.current.as_ref().unwrap().view).unwrap();
    for field in ["materializationDigest", "start", "currentTask", "error"] {
        let mut missing = view.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert!(serde_json::from_value::<ArtifactCheckWorkflowView>(missing).is_err());
    }
    let request = json!({"sessionToken":"synthetic", "projectId":ExecutionId::new(),"preparation":preparation,"start":null});
    let round: ArtifactCheckWorkflowReadRequest = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(serde_json::to_value(round).unwrap(), request);
    let mut missing = request;
    missing.as_object_mut().unwrap().remove("start");
    assert!(serde_json::from_value::<ArtifactCheckWorkflowReadRequest>(missing).is_err());
    assert_ne!(
        serde_json::to_value(ArtifactCheckWorkflowEnqueueOutcome::Pending).unwrap(),
        serde_json::to_value(ArtifactCheckWorkflowEnqueueOutcome::NotEnqueued).unwrap()
    );
    let temporary = tempfile::tempdir().unwrap();
    let store = ProjectStore::create(
        temporary.path().join("project"),
        tsumugi_core::ProjectMetadata::create("Pure observation", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    let sequence = store.execution_sequence().unwrap();
    let pending = observe_steps(
        &store,
        &workflow.current.as_ref().unwrap().view.preparation,
        Some(&start),
        false,
    )
    .unwrap();
    assert_eq!(pending.len(), start.consents.len());
    assert_eq!(
        pending[0].outcome,
        ArtifactCheckWorkflowEnqueueOutcome::Pending
    );
    let closed = observe_steps(
        &store,
        &workflow.current.as_ref().unwrap().view.preparation,
        Some(&start),
        true,
    )
    .unwrap();
    assert_eq!(closed.len(), start.consents.len());
    assert_eq!(
        closed[0].outcome,
        ArtifactCheckWorkflowEnqueueOutcome::NotEnqueued
    );
    assert!(
        closed[0].execution.is_none() && closed[0].result_id.is_none() && closed[0].proof.is_none()
    );
    assert!(
        store
            .reconcile_plugin_start(
                start.consents[0].grant_id,
                start.consents[0].step.attempt_id,
                &start.consents[0].step.input_digest,
                start.consents[0].expires_at_ms.get(),
                PluginConsent {
                    unsandboxed_execution: true,
                    application_execution: false
                },
            )
            .unwrap()
            .is_none()
    );
    assert_eq!(store.execution_sequence().unwrap(), sequence);
}
