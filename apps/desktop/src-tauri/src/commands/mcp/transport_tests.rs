use super::*;
use std::io::{BufRead, BufReader, Read, Write};

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .unwrap()
}
fn sockets(control: &Arc<Control>) -> (std::net::TcpStream, std::net::TcpStream) {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let client = std::net::TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (server, _) = listener.accept().unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    *control.socket.lock().unwrap() = Some(server.try_clone().unwrap());
    (client, server)
}
fn receive_input(bytes: Vec<u8>) -> (bool, bool) {
    let control = Control::new(Instant::now() + Duration::from_secs(20));
    let (mut client, server) = sockets(&control);
    let sender = std::thread::spawn(move || {
        let _ = client.write_all(&bytes);
        let _ = client.shutdown(std::net::Shutdown::Write);
    });
    server.set_nonblocking(true).unwrap();
    let result = runtime().block_on(async {
        let mut io = BoundedIo {
            socket: TcpStream::from_std(server).unwrap(),
            control: control.clone(),
            _work: control.work(),
            line: 0,
            frames: 0,
        };
        let mut received = Vec::new();
        io.read_to_end(&mut received).await
    });
    sender.join().unwrap();
    (result.is_err(), control.closed())
}

#[test]
fn mcp_share_transport_bounds_empty_lines_and_oversize_frames_before_sdk_buffering() {
    assert_eq!(receive_input(vec![b'\n'; 128]), (false, false));
    assert_eq!(receive_input(vec![b'\n'; 129]), (true, true));
    assert_eq!(receive_input(vec![b'x'; MAX_FRAME + 1]), (true, true));
    assert_eq!(receive_input(vec![b'x'; MAX_FRAME - 1]), (false, false));
}

#[test]
fn mcp_share_shutdown_before_late_authorization_install_closes_exact_control() {
    let shutdown = Shutdown::default();
    shutdown.close();
    let late = Control::new(Instant::now() + Duration::from_secs(30));
    assert_eq!(
        shutdown.install(&late).err().unwrap().code,
        CommandErrorCode::SessionInvalid
    );
    assert!(late.closed());
    assert!(late.drained());
    let live_shutdown = Shutdown::default();
    let original = Control::new(Instant::now() + Duration::from_secs(30));
    live_shutdown.install(&original).unwrap();
    let work = original.work();
    let replacement = Control::new(Instant::now() + Duration::from_secs(30));
    assert_eq!(
        live_shutdown.install(&replacement).err().unwrap().code,
        CommandErrorCode::Busy
    );
    assert!(replacement.closed());
    assert!(!original.closed());
    live_shutdown.close();
    assert!(original.closed());
    assert!(!original.drained());
    drop(work);
    assert!(original.drained());
}

struct Deferred {
    entered: std::sync::mpsc::SyncSender<()>,
    release: Arc<(Mutex<bool>, std::sync::Condvar)>,
    control: Arc<Control>,
    callback: dispatch::SessionCallback,
}
impl ServerHandler for Deferred {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
    }
    async fn call_tool(
        &self,
        _: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let work = self.control.work();
        let entered = self.entered.clone();
        let release = self.release.clone();
        let value = self
            .callback
            .submit(
                "synthetic-mcp-read",
                CommandStage::ExecutionRead,
                move |_| {
                    // Exactly like production Reader, the accepted owner closure owns
                    // this work count even if the SDK cancels its reply future.
                    let _work = work;
                    entered.send(()).unwrap();
                    let (lock, ready) = &*release;
                    let flag = lock.lock().unwrap();
                    let (flag, _) = ready
                        .wait_timeout_while(flag, Duration::from_secs(10), |value| !*value)
                        .unwrap();
                    assert!(*flag, "test did not release the accepted owner callback");
                    Ok(serde_json::json!({"text":"late-private-payload"}))
                },
            )
            .unwrap()
            .await
            .map_err(|_| ErrorData::internal_error("synthetic-owner-closed", None))?;
        Ok(CallToolResult::structured(value).into())
    }
}

#[test]
fn mcp_share_sdk_cancel_drains_accepted_work_but_writer_never_sends_late_payload() {
    let control = Control::new(Instant::now() + Duration::from_secs(30));
    let (client, server) = sockets(&control);
    let (entered, observed) = std::sync::mpsc::sync_channel(1);
    let (cancellation, cancel) = std::sync::mpsc::sync_channel(1);
    let (finished, joined) = std::sync::mpsc::sync_channel(1);
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let executor = dispatch::SessionExecutor::default();
    let handler = Deferred {
        entered,
        release: release.clone(),
        control: control.clone(),
        callback: executor.callback(),
    };
    let owner = control.clone();
    let thread = std::thread::spawn(move || {
        server.set_nonblocking(true).unwrap();
        runtime().block_on(async {
            let io = BoundedIo {
                socket: TcpStream::from_std(server).unwrap(),
                control: owner.clone(),
                _work: owner.work(),
                line: 0,
                frames: 0,
            };
            let running = handler.serve(io).await.unwrap();
            cancellation.send(running.cancellation_token()).unwrap();
            let _ = running.waiting().await;
        });
        finished.send(()).unwrap();
    });
    let mut wire = BufReader::new(client);
    writeln!(wire.get_mut(), "{}", serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"Synthetic","version":"1"}}})).unwrap();
    let mut initialized = String::new();
    wire.read_line(&mut initialized).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&initialized).unwrap()["id"],
        1
    );
    writeln!(
        wire.get_mut(),
        "{}",
        serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"})
    )
    .unwrap();
    writeln!(wire.get_mut(), "{}", serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"deferred","arguments":{}}})).unwrap();
    observed
        .recv_timeout(Duration::from_secs(5))
        .expect("SDK did not enter the actual handler");
    // Isolate the writer gate from the additional production socket shutdown.
    // The live SDK still owns the actual socket when cancellation drains replies.
    control.socket.lock().unwrap().take();
    assert!(!control.drained());
    control.close();
    cancel
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .cancel();
    assert!(
        !control.drained(),
        "accepted callback was incorrectly declared drained"
    );
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    let mut received = String::new();
    match wire.read_to_string(&mut received) {
        Ok(_) => {}
        Err(error) => assert!(matches!(
            error.kind(),
            io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
        )),
    }
    assert!(
        received.is_empty(),
        "SDK emitted a queued result after writer revocation"
    );
    joined
        .recv_timeout(Duration::from_secs(8))
        .expect("SDK IO did not drain");
    thread.join().unwrap();
    assert!(control.drained());
}
