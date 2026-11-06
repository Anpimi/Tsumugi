//! One native chooser for each declared file set. Paths never come from IPC.
use super::*;
use tsumugi_plugin_sdk::{SourceFileSetDeclaration, SourceFileSetSelection, SourceImportBinding, TranslationImportBinding};

pub(in crate::commands) async fn choose<R, F, Fut>(
    app: Option<tauri::AppHandle<R>>,
    io: &crate::commands::dispatch::BlockingExecutor,
    dialogs: &crate::commands::dispatch::BlockingExecutor,
    selection: Arc<capture::Selection>,
    binding: SourceImportBinding,
    check: F,
) -> Result<Option<Vec<SourceFileSetSelection>>, CommandError>
where
    R: tauri::Runtime,
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<(), CommandError>>,
{
    binding.validate().map_err(|_| stale())?;
    let Some(choices) = choose_sets(app, io, dialogs, selection, binding.declaration.file_sets.clone().unwrap_or_default(), check).await? else {
        return Ok(None);
    };
    if binding.declaration.materials.is_empty() && choices.iter().all(|choice| choice.logical_paths.is_empty()) {
        return Ok(None);
    }
    binding
        .declaration
        .resolve_materials(&choices)
        .map_err(|_| {
            map_source(ExecutionError::new(
                ErrorCode::InvalidInput,
                "source-import-selection",
            ))
        })?;
    Ok(Some(choices))
}

/// Translation file groups use the same native chooser and path authority.
pub(in crate::commands) async fn choose_translation<R, F, Fut>(
    app: Option<tauri::AppHandle<R>>,
    io: &crate::commands::dispatch::BlockingExecutor,
    dialogs: &crate::commands::dispatch::BlockingExecutor,
    selection: Arc<capture::Selection>,
    binding: TranslationImportBinding,
    check: F,
) -> Result<Option<Vec<SourceFileSetSelection>>, CommandError>
where
    R: tauri::Runtime,
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<(), CommandError>>,
{
    binding.validate().map_err(|_| stale())?;
    let sets = binding.declaration.file_sets.clone().ok_or_else(stale)?;
    let Some(choices) = choose_sets(app, io, dialogs, selection, sets, check).await? else { return Ok(None); };
    if choices.iter().all(|choice| choice.logical_paths.is_empty()) { return Ok(None); }
    binding.declaration.resolve_paired_materials(&choices).map_err(|_| {
        map_source(ExecutionError::new(ErrorCode::InvalidInput, "translation-import-selection"))
    })?;
    Ok(Some(choices))
}

async fn choose_sets<R, F, Fut>(
    app: Option<tauri::AppHandle<R>>,
    io: &crate::commands::dispatch::BlockingExecutor,
    dialogs: &crate::commands::dispatch::BlockingExecutor,
    selection: Arc<capture::Selection>,
    sets: Vec<SourceFileSetDeclaration>,
    check: F,
) -> Result<Option<Vec<SourceFileSetSelection>>, CommandError>
where
    R: tauri::Runtime,
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<(), CommandError>>,
{
    let mut choices = Vec::new();
    for set in sets {
        check().await?;
        let app = app.clone().ok_or_else(stale)?;
        let set = set.clone();
        let selected = selection.clone();
        let directory = io
            .run(CommandStage::ExecutionRead, move || {
                selected
                    .destination_root()
                    .map(std::path::Path::to_path_buf)
                    .map_err(map_source)
            })
            .await?;
        let title = set.display_name.clone();
        let extensions = set.extensions.clone();
        let paths = dialogs
            .run(CommandStage::ExecutionRead, move || {
                let extensions = extensions.iter().map(String::as_str).collect::<Vec<_>>();
                app.dialog()
                    .file()
                    .set_title(title.clone())
                    .set_directory(directory)
                    .add_filter(title, &extensions)
                    .blocking_pick_files()
                    .map(|paths| {
                        paths
                            .into_iter()
                            .map(|path| path.into_path().map_err(|_| stale()))
                            .collect::<Result<Vec<_>, _>>()
                    })
                    .transpose()
            })
            .await?;
        check().await?;
        let Some(paths) = paths else {
            if set.min_files > 0 {
                return Ok(None);
            }
            continue;
        };
        if paths.len() < set.min_files as usize || paths.len() > set.max_files as usize {
            return Err(map_source(ExecutionError::new(
                ErrorCode::InvalidInput,
                "source-import-selection-count",
            )));
        }
        let selected = selection.clone();
        let logical_paths = io
            .run(CommandStage::ExecutionRead, move || {
                selected.native_relative_paths(paths).map_err(map_source)
            })
            .await?;
        choices.push(SourceFileSetSelection {
            id: set.id,
            logical_paths,
        });
    }
    Ok(Some(choices))
}
