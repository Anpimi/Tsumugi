//! Kill only the actual channel observed through the original service broker.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tsumugi_plugin_host::{
    ChannelReceipt, PackageFile, PackageImage, ProjectServiceBroker, ProjectServiceFuture,
    ServiceCaller,
    core::{ProjectServiceFactory, ProjectServiceSelectionFuture},
};

#[derive(Default)]
pub(super) struct ChannelObservation {
    caller: std::sync::Mutex<Option<(ChannelReceipt, sdk::InvocationContext)>>,
    released: AtomicUsize,
}
struct ChannelFactory {
    original: Arc<dyn ProjectServiceFactory>,
    observation: Arc<ChannelObservation>,
}
struct ChannelBroker {
    original: Arc<dyn ProjectServiceBroker>,
    observation: Arc<ChannelObservation>,
}
impl ProjectServiceFactory for ChannelFactory {
    fn capture(
        &self,
        request: DispatchRequest,
        permit: PluginPermit,
        cancellation: Cancellation,
    ) -> ProjectServiceSelectionFuture {
        let original = self.original.capture(request, permit, cancellation);
        let observation = self.observation.clone();
        Box::pin(async move {
            Ok(Arc::new(ChannelBroker {
                original: original.await?,
                observation,
            }) as Arc<dyn ProjectServiceBroker>)
        })
    }
}
impl ProjectServiceBroker for ChannelBroker {
    fn bindings(&self) -> &[sdk::ServiceBinding] {
        self.original.bindings()
    }
    fn is_current(&self, binding: &sdk::ServiceBinding) -> bool {
        self.original.is_current(binding)
    }
    fn call<'a>(
        &'a self,
        caller: ServiceCaller,
        binding: sdk::ServiceBinding,
        request: sdk::ServiceRequest,
    ) -> ProjectServiceFuture<'a> {
        let mut recorded = self.observation.caller.lock().unwrap();
        assert!(recorded.is_none(), "one original service call required");
        *recorded = Some((caller.channel().clone(), caller.context().clone()));
        drop(recorded);
        self.original.call(caller, binding, request)
    }
    fn release_channel(&self, channel: &ChannelReceipt) {
        if self
            .observation
            .caller
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|(original, _)| original.child_pid == channel.child_pid)
        {
            self.observation.released.fetch_add(1, Ordering::AcqRel);
        }
        self.original.release_channel(channel);
    }
}

pub(super) fn observe(fixture: &Fixture) -> Arc<ChannelObservation> {
    let observation = Arc::new(ChannelObservation::default());
    let observed = observation.clone();
    fixture
        .app
        .state::<AppState>()
        .sessions
        .with(move |sessions| {
            let (host, _) = sessions.active.as_mut().unwrap().execution_parts().unwrap();
            host.service_factory = Some(Arc::new(ChannelFactory {
                original: host.service_factory.clone().unwrap(),
                observation: observed,
            }));
        });
    observation
}

pub(super) fn package(observer: &Path) -> PackageImage {
    let original = generation_package_with_timeout(None, 60_000);
    let manifest = serde_json::to_vec(original.manifest().manifest()).unwrap();
    let files = BTreeMap::from([
        (
            "component.mjs".into(),
            PackageFile {
                executable: false,
                bytes: br#"
import {readFile, writeFile} from 'node:fs/promises';
const observer = await readFile(new URL('./observer.txt', import.meta.url), 'utf8');
export default { async activate(api) {
  if (api.services.length !== 1) throw new Error('Missing original generation service');
  api.register(async (input, metadata) => {
    const response = await metadata.services.call(api.services[0].handleId, input.utf8, 'generation-call');
    if (response.outcome.kind !== 'succeeded') throw new Error('Child enqueue was not acknowledged');
    await writeFile(observer, JSON.stringify({stage: 'holding', pid: process.pid,
      childAttempt: JSON.parse(input.utf8).attemptId}));
    // Keep the real invocation open after the durable child ACK. The test
    // observes the trusted channel independently before sending SIGKILL.
    return await new Promise(() => {});
  });
  api.onDispose(() => writeFile(observer, JSON.stringify({stage: 'disposed', pid: process.pid})));
} };
"#
                .to_vec(),
            },
        ),
        (
            "observer.txt".into(),
            PackageFile {
                executable: false,
                bytes: observer.to_str().unwrap().as_bytes().to_vec(),
            },
        ),
    ]);
    let digest = PackageImage::digest(&manifest, &files).unwrap();
    PackageImage::capture(manifest, files, &digest).unwrap()
}

pub(super) fn kill(
    fixture: &Fixture,
    action: &ComponentAction,
    provider: &sdk::ProviderSelectionBinding,
    observer: &Path,
    observation: Arc<ChannelObservation>,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    let marker: Value = loop {
        if let Ok(bytes) = std::fs::read(observer)
            && let Ok(marker) = serde_json::from_slice::<Value>(&bytes)
        {
            break marker;
        }
        assert!(
            Instant::now() < deadline,
            "component did not retain its invocation"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let (channel, context) = observation.caller.lock().unwrap().clone().unwrap();
    assert_eq!(channel.provider.selection(), *provider);
    assert!(!channel.provider.instance_id.is_empty());
    assert!(channel.provider.activation_generation > 0);
    assert_eq!(context.attempt_id, action.outer.to_string());
    assert_eq!(channel.scope.project_id, fixture.context["projectId"]);
    assert_eq!(marker["stage"], "holding");
    assert_eq!(marker["childAttempt"], action.generation["attemptId"]);
    assert_eq!(marker["pid"], channel.child_pid);
    assert!(channel.child_pid > 1 && channel.child_pid != std::process::id());
    assert_eq!(observation.released.load(Ordering::Acquire), 0);
    let child = fixture
        .call(
            "read_ai_translation",
            json!({"attemptId":action.generation["attemptId"]}),
        )
        .unwrap();
    assert_eq!(
        child["detail"]["items"][0]["status"]["execution"],
        "dispatched"
    );
    assert!(child["rows"][0]["savedRevisionId"].is_null());
    assert_eq!(child["budget"]["dispatched"], 2);
    let outer = fixture
        .call(
            "read_execution_attempt",
            json!({"attemptId":action.outer,"offset":0,"limit":10}),
        )
        .unwrap();
    assert_eq!(outer["items"][0]["status"]["execution"], "dispatched");
    // Both the SDK principal and the owned component marker identify this live
    // direct child. No process-name, port or process-group kill is used.
    let pid: i32 = channel.child_pid.try_into().unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);
    assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
    let deadline = Instant::now() + Duration::from_secs(5);
    let crashed = loop {
        let view = fixture
            .call(
                "read_execution_attempt",
                json!({"attemptId":action.outer,"offset":0,"limit":10}),
            )
            .unwrap();
        if view["items"][0]["status"]["execution"] == "unknown"
            && observation.released.load(Ordering::Acquire) == 1
        {
            break view;
        }
        assert!(
            Instant::now() < deadline,
            "killed Host did not settle: {view}"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(
        crashed["items"][0]["status"]["diagnostic"],
        "plugin-crashed"
    );
    assert_eq!(crashed["items"][0]["status"]["adoption"], "unapplied");
    assert_eq!(
        unsafe { libc::kill(pid, 0) },
        -1,
        "actual direct child must be reaped"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(observer).unwrap()).unwrap(),
        marker
    );
    crashed
}

pub(super) fn assert_preserved(fixture: &Fixture, action: &ComponentAction, before: &Value) {
    let after = fixture
        .call(
            "read_execution_attempt",
            json!({"attemptId":action.outer,"offset":0,"limit":10}),
        )
        .unwrap();
    assert_eq!(
        after, *before,
        "Host Unknown must survive reopening without replay"
    );
}
