#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    commands::register_commands(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running Tsumugi desktop shell");
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
            url: "http://tauri.localhost".parse().unwrap(),
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
