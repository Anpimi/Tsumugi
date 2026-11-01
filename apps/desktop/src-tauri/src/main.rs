#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
#[path = "../plugin_bundle.rs"]
mod plugin_bundle;
#[path = "../runtime_bundle.rs"]
mod runtime_bundle;

#[cfg(target_os = "macos")]
use tauri::Manager;

#[cfg(target_os = "macos")]
const QUIT_MENU_ID: &str = "coordinated-quit";

#[cfg(target_os = "macos")]
fn macos_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let quit_text = PredefinedMenuItem::quit(app, None)?.text()?;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (position, child) in submenu.items()?.iter().enumerate() {
                if let Some(native) = child.as_predefined_menuitem() {
                    if native.text()? == quit_text {
                        // The predefined macOS Quit calls Cocoa terminate directly,
                        // bypassing Tauri's ExitRequested and frontend draft checks.
                        let quit =
                            MenuItem::with_id(app, QUIT_MENU_ID, &quit_text, true, Some("Cmd+Q"))?;
                        submenu.remove(native)?;
                        submenu.insert(&quit, position)?;
                        return Ok(menu);
                    }
                }
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "default macOS menu is missing its Quit item",
    )
    .into())
}

fn main() {
    if commands::mcp::bridge_main() {
        return;
    }
    #[cfg(feature = "wire-schema")]
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--export-ipc-schema")
    {
        let destination = std::env::args_os()
            .nth(2)
            .expect("schema destination required");
        commands::contracts::export(std::path::Path::new(&destination)).expect("export IPC schema");
        return;
    }
    let builder =
        commands::register_commands(tauri::Builder::default()).plugin(tauri_plugin_dialog::init());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu).on_menu_event(|app, event| {
        if event.id().as_ref() == QUIT_MENU_ID {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.close() {
                    eprintln!("Could not request coordinated window close: {error}");
                }
            }
        }
    });
    builder
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

    #[test]
    fn project_change_reconnect_reads_missed_commits_and_releases_retired_listeners() {
        use std::sync::mpsc::{self, Receiver};
        use std::time::Duration;
        use tauri::{Listener, Manager};

        struct ListenerLifetime(mpsc::Sender<()>);
        impl Drop for ListenerLifetime {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }
        fn receive_change(events: &Receiver<String>, project: &Value, kind: &str, sequence: &str) {
            let event: Value =
                serde_json::from_str(&events.recv_timeout(Duration::from_secs(2)).unwrap()).unwrap();
            assert_eq!(event["projectId"], project["metadata"]["projectId"]);
            assert_eq!(event["sessionToken"], project["sessionToken"]);
            assert_eq!(event["kind"], kind);
            assert_eq!(event["sequence"], sequence);
            assert_eq!(event["scopes"], json!(["project"]));
        }
        fn change_request(project: &Value, after: &str) -> Value {
            json!({"request": {"sessionToken": project["sessionToken"],
                "projectId": project["metadata"]["projectId"], "afterSequence": after}})
        }

        let parent = temporary_directory("change-reconnect");
        let app = crate::commands::register_commands(tauri::test::mock_builder())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let webview =
            tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::App("index.html".into()))
                .build()
                .unwrap();
        let invoke = |command: &str, body: Value| -> Value {
            tauri::test::get_ipc_response(&webview, request(command, body))
                .unwrap()
                .deserialize()
                .unwrap()
        };
        let (events, received) = mpsc::channel();
        let (released, release_observed) = mpsc::channel();
        let lifetime = ListenerLifetime(released);
        let listener = app.listen_any("project-changed", move |event| {
            let _lifetime = &lifetime;
            let _ = events.send(event.payload().to_owned());
        });
        let state = app.state::<crate::commands::AppState>();
        state.connect_change_events(app.handle().clone());
        let first = invoke(
            "create_project",
            json!({"request": {
                "destination": parent.path().join("first"), "displayName": "First",
                "sourceLocale": "en-US", "targetLocales": ["zh-CN"]
            }}),
        );
        receive_change(&received, &first, "resync", "0");
        let initial = invoke("read_project_changes", change_request(&first, "0"));
        invoke(
            "rename_project",
            json!({"request": {"sessionToken": first["sessionToken"],
            "expectedRevision": "1", "displayName": "Before disconnect"}}),
        );
        receive_change(&received, &first, "change", "1");

        state.disconnect_change_events();
        app.unlisten(listener);
        release_observed
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert_eq!(received.try_recv(), Err(mpsc::TryRecvError::Disconnected));
        invoke(
            "rename_project",
            json!({"request": {"sessionToken": first["sessionToken"],
            "expectedRevision": "2", "displayName": "Committed while disconnected"}}),
        );
        let missed = invoke("read_project_changes", change_request(&first, "1"));
        assert_eq!(missed["epoch"], initial["epoch"]);
        assert_eq!(missed["sequence"], "2");
        assert_eq!(missed["scopes"], json!(["project"]));

        let (events, received) = mpsc::channel();
        let (released, release_observed) = mpsc::channel();
        let lifetime = ListenerLifetime(released);
        let listener = app.listen_any("project-changed", move |event| {
            let _lifetime = &lifetime;
            let _ = events.send(event.payload().to_owned());
        });
        state.connect_change_events(app.handle().clone());
        receive_change(&received, &first, "change", "2");
        let settled = invoke("read_project_changes", change_request(&first, "2"));
        assert_eq!(settled["sequence"], missed["sequence"]);
        assert_eq!(settled["scopes"], json!([]));
        assert_eq!(settled["runtime"]["active"], false);
        assert_eq!(settled["runtime"]["queryCount"], 0);
        let read = invoke(
            "read_project",
            json!({"request": {
                "sessionToken": first["sessionToken"], "expectedRevision": null
            }}),
        );
        assert_eq!(
            read["metadata"]["displayName"],
            "Committed while disconnected"
        );

        invoke(
            "close_project",
            json!({"request": {"sessionToken": first["sessionToken"]}}),
        );
        let second = invoke(
            "create_project",
            json!({"request": {
                "destination": parent.path().join("second"), "displayName": "Second",
                "sourceLocale": "en-US", "targetLocales": ["ja"]
            }}),
        );
        receive_change(&received, &second, "resync", "0");
        let reopened = invoke("read_project_changes", change_request(&second, "0"));
        assert_ne!(reopened["epoch"], initial["epoch"]);
        assert_eq!(reopened["runtime"]["active"], false);
        assert_eq!(reopened["runtime"]["queryCount"], 0);
        assert_eq!(
            tauri::test::get_ipc_response(
                &webview,
                request("read_project_changes", change_request(&first, "0")),
            )
            .unwrap_err()["code"],
            "session-invalid"
        );
        state.disconnect_change_events();
        app.unlisten(listener);
        release_observed
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert_eq!(received.try_recv(), Err(mpsc::TryRecvError::Disconnected));
        invoke(
            "close_project",
            json!({"request": {"sessionToken": second["sessionToken"]}}),
        );
    }
}
