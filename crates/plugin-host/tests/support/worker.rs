//! Independently executed synthetic protocol peer. Enabled only by the explicit
//! conformance-worker feature; it never receives a project or Core API.
use std::{io::Write, time::Duration};
use tsumugi_plugin_sdk::*;
fn read_frame() -> ProcessFrame {
    read_process_frame(
        &mut std::io::stdin().lock(),
        &mut 0,
        MAX_PROCESS_FRAME_BYTES,
        MAX_PROCESS_SESSION_BYTES,
    )
    .unwrap()
    .0
}
fn write_frame(body: ProcessBody) {
    write_process_frame(
        &mut std::io::stdout().lock(),
        &ProcessFrame::new(body),
        &mut 0,
        MAX_PROCESS_FRAME_BYTES,
        MAX_PROCESS_SESSION_BYTES,
    )
    .unwrap();
}
fn raw(bytes: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    for chunk in bytes.chunks(MAX_PROCESS_CHUNK_BYTES) {
        stdout
            .write_all(&(chunk.len() as u32).to_be_bytes())
            .unwrap();
        stdout.write_all(chunk).unwrap();
    }
    stdout.write_all(&0u32.to_be_bytes()).unwrap();
    stdout.flush().unwrap();
}

fn hang() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}
fn main() {
    let mode = std::fs::read_to_string("behavior.txt").unwrap();
    if mode == "startup-marker" {
        let observer = std::fs::read_to_string("observer.txt").unwrap();
        std::fs::write(observer, b"started").unwrap();
    }
    if mode == "no-handshake" {
        hang();
    }
    if mode == "crash-handshake" {
        std::process::exit(7);
    }
    let ProcessBody::Activate(mut activation) = read_frame().body else {
        panic!("expected activation")
    };
    if mode == "wrong-handshake" {
        activation.instance.instance_id = "forged-instance".into();
    }
    if mode == "wrong-protocol" {
        let mut frame = ProcessFrame::new(ProcessBody::Ready(activation));
        frame.protocol_version = PROCESS_PROTOCOL + 1;
        raw(&serde_json::to_vec(&frame).unwrap());
        hang();
    }
    if mode == "delayed-ready" {
        std::thread::sleep(Duration::from_millis(3500));
    }
    write_frame(ProcessBody::Ready(activation.clone()));
    loop {
        if mode == "no-read" {
            hang();
        }
        match read_frame().body {
            ProcessBody::Invoke(request) => {
                if mode == "wrong-direction" {
                    write_frame(ProcessBody::Invoke(request));
                    hang();
                }
                if mode == "crash-result" {
                    std::process::exit(9);
                }
                if mode == "no-result" {
                    hang();
                }
                if mode == "late-result" {
                    if let Ok(observer) = std::fs::read_to_string("observer.txt") {
                        std::fs::write(observer, b"invoked").unwrap();
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
                if mode == "oversized-header" {
                    std::io::stdout()
                        .write_all(&u32::MAX.to_be_bytes())
                        .unwrap();
                    std::io::stdout().flush().unwrap();
                    hang();
                }
                if mode == "truncated" {
                    std::io::stdout().write_all(&[0, 0]).unwrap();
                    std::io::stdout().flush().unwrap();
                    return;
                }
                if mode == "duplicate-fields" {
                    raw(br#"{"protocolVersion":4,"protocolVersion":4,"body":{"kind":"pong","data":{"nonce":"nonce"}}}"#);
                    hang();
                }
                if mode == "stderr-flood" {
                    std::io::stderr().write_all(&[b'x'; 8192]).unwrap();
                    std::io::stderr().flush().unwrap();
                    std::thread::sleep(Duration::from_millis(100));
                }
                if mode == "assert-env" {
                    assert!(std::env::vars_os().next().is_none());
                }
                let result_frame_limit = request.max_result_bytes as usize;
                let output = EncodedPayload::capture(
                    request.output_schema.clone(),
                    if mode == "core-echo" {
                        request.input.utf8.to_string()
                    } else {
                        format!("answer:{}", request.input.utf8)
                    },
                )
                .unwrap();
                let result_id = format!("result-{}", request.context.dispatch_id);
                let mut result = InvocationResult {
                    context: request.context,
                    provider: request.provider,
                    capability: request.capability,
                    profile: request.profile,
                    result_id,
                    outcome: InvocationOutcome::Succeeded { output },
                };
                if mode == "wrong-result" {
                    result.provider.instance_id = "other-process".into();
                }
                if mode == "wrong-scope" {
                    result.context.scope_id = "other-scope".into();
                }
                if matches!(mode.as_str(), "padded-result" | "oversized-padded-result") {
                    let mut bytes = ProcessFrame::new(ProcessBody::Result(result))
                        .encode()
                        .unwrap();
                    assert!(bytes.len() < result_frame_limit);
                    bytes.resize(
                        result_frame_limit + usize::from(mode == "oversized-padded-result"),
                        b' ',
                    );
                    raw(&bytes);
                    continue;
                }
                write_frame(ProcessBody::Result(result.clone()));
                if mode == "duplicate-result" {
                    write_frame(ProcessBody::Result(result));
                }
            }
            ProcessBody::Ping { nonce } => write_frame(ProcessBody::Pong { nonce }),
            ProcessBody::Cancel { dispatch_id } => {
                write_frame(ProcessBody::Cancelled { dispatch_id })
            }
            ProcessBody::Close { instance } => {
                if mode == "no-close" {
                    hang();
                }
                assert_eq!(instance, activation.instance);
                write_frame(ProcessBody::Closed { instance });
                return;
            }
            _ => panic!("unexpected host direction"),
        }
    }
}
