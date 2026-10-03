//! Generate IPC shapes from the same Rust definitions used by Tauri and Serde.
use super::*;
use schemars::{JsonSchema, generate::SchemaSettings};

#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct Requests {
    create: CreateProjectRequest,
    open: OpenProjectRequest,
    read: ReadProjectRequest,
    rename: RenameProjectRequest,
    add_target_locale: AddTargetLocaleRequest,
    set_target_locales: SetTargetLocalesRequest,
    close: CloseProjectRequest,
    changes: changes::ChangesRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct Responses {
    project_view: ProjectView,
    metadata_mutation: MetadataMutationView,
    close: CloseProjectView,
    error: CommandError,
    changes: changes::ProjectChanges,
    notification: changes::ChangeNotification,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExecutionRequests {
    session: execution::SessionRequest,
    list: execution::ListRequest,
    task: execution::TaskRequest,
    attempt: execution::AttemptRequest,
    output: execution::OutputRequest,
    cancel: execution::CancelRequest,
    recovery: execution::RecoveryRequest,
    prepare: execution::PrepareRequest,
    adopt: execution::AdoptRequest,
}
#[derive(JsonSchema)]
#[schemars(rename_all = "camelCase")]
#[allow(dead_code)]
struct ExecutionResponses {
    identity: tsumugi_core::execution::ExecutionId,
    status: execution::RuntimeStatus,
    tasks: Vec<tsumugi_core::TaskView>,
    attempts: Vec<execution::AttemptSummary>,
    attempt: execution::AttemptDetail,
    output: tsumugi_core::execution::ResultEnvelope,
    cancellation: tsumugi_core::execution::Revision,
    recovery: execution::RecoveryView,
    action: tsumugi_core::execution::AdoptionAction,
    adoption: tsumugi_core::execution::AdoptionReceipt,
    receipt: Option<tsumugi_core::execution::AdoptionReceipt>,
}
pub(super) fn metadata_revision(_: &mut schemars::generate::SchemaGenerator) -> schemars::Schema {
    tsumugi_core::execution::wire_schema::unsigned_decimal(u64::MAX)
}
pub(super) fn optional_metadata_revision(
    generator: &mut schemars::generate::SchemaGenerator,
) -> schemars::Schema {
    let value = metadata_revision(generator);
    if *generator.contract() == schemars::generate::Contract::Deserialize {
        schemars::json_schema!({"anyOf": [value, {"type":"null"}]})
    } else {
        value
    }
}
pub(super) fn optional_text(
    generator: &mut schemars::generate::SchemaGenerator,
) -> schemars::Schema {
    if *generator.contract() == schemars::generate::Contract::Serialize {
        String::json_schema(generator)
    } else {
        Option::<String>::json_schema(generator)
    }
}

pub(crate) fn export(path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let requests = SchemaSettings::draft07()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<Requests>();
    let responses = SchemaSettings::draft07()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<Responses>();
    let execution_requests = SchemaSettings::draft07()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<ExecutionRequests>();
    let execution_responses = SchemaSettings::draft07()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<ExecutionResponses>();
    std::fs::write(
        path,
        serde_json::to_string_pretty(
            &serde_json::json!({
                "project": {"requests":requests, "responses":responses},
                "execution": {"requests":execution_requests, "responses":execution_responses}
            }),
        )? + "\n",
    )?;
    Ok(())
}
