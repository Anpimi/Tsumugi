//! Independently executed synthetic protocol peer. Enabled only by the explicit
//! conformance-worker feature; it never receives a project or Core API.
use std::{
    io::{Read, Write},
    time::Duration,
};
use tsumugi_plugin_sdk::*;
fn read_frame() -> ProcessFrame {
    let mut header = [0u8; 4];
    std::io::stdin().read_exact(&mut header).unwrap();
    let length = u32::from_be_bytes(header) as usize;
    assert!(length <= MAX_PROCESS_FRAME_BYTES);
    let mut bytes = vec![0u8; length];
    std::io::stdin().read_exact(&mut bytes).unwrap();
    parse_process_frame(&bytes).unwrap()
}
fn write_frame(body: ProcessBody) {
    let bytes = ProcessFrame::new(body).encode().unwrap();
    raw(&bytes);
}
fn raw(bytes: &[u8]) {
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    stdout.write_all(bytes).unwrap();
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
        activation.provider.instance_id = "forged-instance".into();
    }
    if mode == "wrong-protocol" {
        let mut frame = ProcessFrame::new(ProcessBody::Ready(activation));
        frame.protocol_version = PROCESS_PROTOCOL + 1;
        raw(&serde_json::to_vec(&frame).unwrap());
        hang();
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
                    raw(br#"{"protocolVersion":2,"protocolVersion":2,"body":{"kind":"pong","data":{"nonce":"nonce"}}}"#);
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
                    format!("answer:{}", request.input.utf8),
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
            ProcessBody::Close { provider } => {
                if mode == "no-close" {
                    hang();
                }
                assert_eq!(provider, activation.provider);
                write_frame(ProcessBody::Closed { provider });
                return;
            }
            _ => panic!("unexpected host direction"),
        }
    }
}
