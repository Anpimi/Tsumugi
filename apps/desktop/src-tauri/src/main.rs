#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    #[cfg(feature = "wire-schema")]
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "--export-ipc-schema") {
        let destination = std::env::args_os().nth(2).expect("schema destination required");
        commands::contracts::export(std::path::Path::new(&destination)).expect("export IPC schema");
        return;
    }
    commands::register_commands(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running Tsumugi desktop shell");
}

#[cfg(test)]
fn ipc_test_url() -> &'static str {
    // Match the native custom-protocol origin so Tauri's ACL remains active.
    if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use crate::commands::{CloseProjectRequest, ProjectView, ReadProjectRequest};
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::webview::InvokeRequest;

    fn temporary_directory(label: &str) -> TempDir {
        tempfile::Builder::new()
            .prefix(&format!("tsumugi-desktop-{label}-"))
            .tempdir()
            .unwrap()
    }

    fn request(command: &str, body: Value) -> InvokeRequest {
        InvokeRequest {
            cmd: command.to_owned(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: crate::ipc_test_url().parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_owned(),
        }
    }

    #[test]
    #[cfg(not(feature = "execution-test-host"))]
    fn production_commands_do_not_register_the_fixture_entry() {
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();
        let error = tauri::test::get_ipc_response(
            &webview,
            request("seed_execution_fixture", json!({"request":{}})),
        )
        .unwrap_err();
        assert!(
            error
                .as_str()
                .is_some_and(|message| message.contains("not found")),
            "{error}"
        );
    }

    #[test]
    fn tauri_invoke_round_trip_reaches_real_core_storage() {
        let parent = temporary_directory("ipc");
        let destination = parent.path().join("project");
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .unwrap();

        use tauri::{Listener, Manager};
        // Mock Builder::build does not run the native setup callback.
        app.state::<crate::commands::AppState>()
            .connect_change_events(app.handle().clone());
        let (events, changes) = std::sync::mpsc::channel();
        let listener = app.listen_any("project-changed", move |event| {
            let _ = events.send(event.payload().to_owned());
        });

        let created = tauri::test::get_ipc_response(
            &webview,
            request(
                "create_project",
                json!({
                    "request": {
                        "destination": destination,
                        "displayName": "IPC Demo",
                        "sourceLocale": "en-US",
                        "targetLocales": ["zh-CN", "ja"]
                    }
                }),
            ),
        )
        .unwrap()
        .deserialize::<ProjectView>()
        .unwrap();

        let read = tauri::test::get_ipc_response(
            &webview,
            request(
                "read_project",
                json!({
                    "request": serde_json::to_value(ReadProjectRequest {
                        expected_revision: None,
                        session_token: created.session_token.clone(),
                    })
                    .unwrap()
                }),
            ),
        )
        .unwrap()
        .deserialize::<ProjectView>()
        .unwrap();

        assert_eq!(read.session_token, created.session_token);
        assert_eq!(read.metadata.display_name, "IPC Demo");
        assert_eq!(read.metadata.metadata_revision, "1");
        assert_eq!(read.metadata.target_locales, vec!["ja", "zh-CN"]);

        let changes_request = |after: &str| {
            json!({"request": {
                "projectId": created.metadata.project_id, "sessionToken": created.session_token, "afterSequence": after
            }})
        };
        let initial: Value = tauri::test::get_ipc_response(
            &webview,
            request("read_project_changes", changes_request("0")),
        )
        .unwrap()
        .deserialize()
        .unwrap();
        assert_eq!(initial["sequence"], "0");
        assert_eq!(initial["scopes"], json!([]));
        assert_eq!(initial["runtime"]["active"], false);
        let _: Value = tauri::test::get_ipc_response(&webview, request("rename_project", json!({"request": {
            "sessionToken": created.session_token, "expectedRevision": "1", "displayName": "Changed IPC Demo"
        }}))).unwrap().deserialize().unwrap();
        let committed: Value = tauri::test::get_ipc_response(
            &webview,
            request("read_project_changes", changes_request("0")),
        )
        .unwrap()
        .deserialize()
        .unwrap();
        assert_eq!(committed["sequence"], "1");
        assert_eq!(committed["epoch"], initial["epoch"]);
        assert_eq!(committed["scopes"], json!(["project"]));
        let mut saw_change = false;
        for _ in 0..4 {
            let payload = changes
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap();
            let event: Value = serde_json::from_str(&payload).unwrap();
            assert_eq!(event["sessionToken"], created.session_token);
            if event["kind"] == "change" {
                assert_eq!(event["sequence"], "1");
                saw_change = true;
                break;
            }
        }
        assert!(saw_change);
        let settled: Value = tauri::test::get_ipc_response(
            &webview,
            request("read_project_changes", changes_request("1")),
        )
        .unwrap()
        .deserialize()
        .unwrap();
        assert_eq!(settled["scopes"], json!([]));
        let mut wrong_project = changes_request("0");
        wrong_project["request"]["projectId"] = json!("533e0710-d5fd-4ca9-8d41-d7e7819af8cb");
        assert_eq!(
            tauri::test::get_ipc_response(&webview, request("read_project_changes", wrong_project))
                .unwrap_err()["code"],
            "session-invalid"
        );
        app.unlisten(listener);
        app.state::<crate::commands::AppState>()
            .disconnect_change_events();

        let _ = tauri::test::get_ipc_response(
            &webview,
            request(
                "close_project",
                json!({
                    "request": serde_json::to_value(CloseProjectRequest {
                        session_token: created.session_token,
                    })
                    .unwrap()
                }),
            ),
        )
        .unwrap();
        drop(webview);
        drop(app);
    }
}
