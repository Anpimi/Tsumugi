//! Synthetic source fixture using the existing source baseline, without plugin workers.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tsumugi_core::{
    ProjectMetadata, ProjectStore,
    content::{ContentRow, SourceAdoptionHandler, SourceBundle, SourceRunner},
    execution::*,
};

pub fn source_fixture() -> (tempfile::TempDir, ProjectStore, Vec<ContentRow>) {
    let directory = tempfile::tempdir().unwrap();
    let mut store = ProjectStore::create(
        directory.path().join("project"),
        ProjectMetadata::create("Production content", "en", ["zh-CN"]).unwrap(),
    )
    .unwrap();
    // The existing source baseline establishes synthetic content only. No
    // domain builder, plugin process or independent checker is invoked.
    let source = SourceBundle::capture(
        br#"{"UniqueID":"Synthetic.Mod","Name":"Synthetic","Version":"1.0.0","EntryDll":"Synthetic.dll"}"#,
        br#"{"first":"same","second":"same"}"#,
        "en",
    ).unwrap();
    let input = source
        .fixed_input(store.metadata().unwrap().project_id())
        .unwrap();
    let mut runtime = ExecutionRuntime::new(&store).unwrap();
    runtime.register_read_only(Arc::new(SourceRunner)).unwrap();
    runtime.submit(&mut store, &input).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = loop {
        runtime.tick(&mut store).unwrap();
        let status = store
            .execution_attempt(input.envelope().attempt_id, true)
            .unwrap();
        if status.items[0].execution == ExecutionState::Succeeded {
            break store
                .execution_current_result(
                    input.envelope().attempt_id,
                    input.envelope().items[0].item_id,
                )
                .unwrap()
                .unwrap();
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    };
    let preview = store
        .source_preview(input.envelope().attempt_id, result, 0, 10)
        .unwrap();
    let action = store
        .prepare_adoption_with_id(
            ExecutionId::new(),
            input.envelope().attempt_id,
            input.envelope().units[0].unit_id,
            vec![result],
            serde_json::to_value(preview.confirmation).unwrap(),
        )
        .unwrap();
    store
        .adopt_execution(&action, &SourceAdoptionHandler)
        .unwrap();
    let snapshot = store.content_scope().unwrap().current_snapshot.unwrap();
    let rows = store.source_content(snapshot, 0, 10).unwrap().rows;
    (directory, store, rows)
}
