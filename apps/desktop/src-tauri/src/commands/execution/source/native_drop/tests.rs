use super::*;
use serde_json::{Value, json};

fn scope() -> DropScope {
    DropScope {
        window: "main".into(),
        session_token: "current-session".into(),
        project_id: ExecutionId::new(),
        generation: ExecutionId::new(),
    }
}

fn register(tickets: &mut NativeDropSession, scope: &DropScope, now: Instant) -> ExecutionId {
    match tickets.register(scope.clone(), vec![PathBuf::from("/native/materials")], now).unwrap() {
        NativeSourceDropEvent::Ready { drop_ticket, .. } => drop_ticket,
        _ => panic!("native ticket expected"),
    }
}

#[test]
fn native_drop_ticket_is_single_use_and_bound_to_every_current_scope_component() {
    let mut tickets = NativeDropSession::default();
    let scope = scope();
    let now = Instant::now();
    let id = register(&mut tickets, &scope, now);
    for changed in [
        DropScope { window: "another-window".into(), ..scope.clone() },
        DropScope { session_token: "reopened-session".into(), ..scope.clone() },
        DropScope { project_id: ExecutionId::new(), ..scope.clone() },
        DropScope { generation: ExecutionId::new(), ..scope.clone() },
    ] {
        assert!(tickets.consume(id, &changed, now).is_err());
    }
    assert!(tickets.consume(ExecutionId::new(), &scope, now).is_err());
    assert_eq!(tickets.consume(id, &scope, now).unwrap(), PathBuf::from("/native/materials"));
    let picker = ExecutionId::new();
    tickets.begin_selection("main".into(), picker);
    assert!(tickets.consume(id, &scope, now).is_err());
    assert_eq!(tickets.picker, Some(("main".into(), picker)));
}

#[test]
fn expired_replaced_destroyed_and_rejected_drops_cannot_restore_a_ticket() {
    let scope = scope();
    let now = Instant::now();
    let mut tickets = NativeDropSession::default();
    let expired = register(&mut tickets, &scope, now);
    tickets.begin_selection("main".into(), ExecutionId::new());
    assert!(tickets.consume(expired, &scope, now + TICKET_LIFETIME).is_err());
    assert!(tickets.picker.is_none());
    let replaced = register(&mut tickets, &scope, now);
    let current = register(&mut tickets, &scope, now);
    assert!(tickets.consume(replaced, &scope, now).is_err());
    tickets.clear_window("another-window");
    assert!(tickets.ticket.is_some());
    tickets.clear_window("main");
    assert!(tickets.consume(current, &scope, now).is_err());
    let picker = ExecutionId::new();
    tickets.begin_selection("main".into(), picker);
    assert_eq!(tickets.clear_window("another-window"), None);
    assert_eq!(tickets.clear_window("main"), Some(picker));
    assert_eq!(tickets.clear_window("main"), None);
    let previous = register(&mut tickets, &scope, now);
    assert!(tickets.register(scope.clone(), vec!["/one".into(), "/two".into()], now).is_err());
    assert!(tickets.consume(previous, &scope, now).is_err());
    assert!(tickets.register(scope, Vec::new(), now).is_err());
}

#[test]
fn wire_carries_only_opaque_ticket_and_declared_source_never_a_path() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../../test/fixtures/pluginSourceWorkflow.contract.json"
    )).unwrap();
    let mut request = fixture["select"].clone();
    request["dropTicket"] = json!(ExecutionId::new());
    let parsed: PluginSourceDropRequest = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), request);
    for key in ["path", "paths", "directory", "window", "generation"] {
        let mut forged = request.clone();
        forged[key] = json!("/untrusted/path");
        assert!(serde_json::from_value::<PluginSourceDropRequest>(forged).is_err());
    }
    let mut tickets = NativeDropSession::default();
    let event = tickets.register(scope(), vec!["/private/native/materials".into()], Instant::now()).unwrap();
    let event = serde_json::to_value(event).unwrap();
    assert_eq!(event["kind"], "ready");
    assert_eq!(event["folderName"], "materials");
    assert!(!event.to_string().contains("/private/native"));
    assert!(event.get("path").is_none());
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn consumed_native_ticket_uses_the_existing_directory_handle_authority() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("material.txt");
    std::fs::write(&file, "synthetic material").unwrap();
    let scope = scope();
    let now = Instant::now();
    let mut tickets = NativeDropSession::default();
    let file_ticket = match tickets.register(scope.clone(), vec![file], now).unwrap() {
        NativeSourceDropEvent::Ready { drop_ticket, .. } => drop_ticket,
        _ => unreachable!(),
    };
    let path = tickets.consume(file_ticket, &scope, now).unwrap();
    assert!(capture::Selection::authorize(path).is_err());
    assert!(tickets.consume(file_ticket, &scope, now).is_err());
    let directory_ticket = match tickets.register(scope.clone(), vec![root.path().to_path_buf()], now).unwrap() {
        NativeSourceDropEvent::Ready { drop_ticket, .. } => drop_ticket,
        _ => unreachable!(),
    };
    let path = tickets.consume(directory_ticket, &scope, now).unwrap();
    assert!(capture::Selection::authorize(path).is_ok());
}
