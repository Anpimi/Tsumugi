//! A public SDK-only component, not a domain plugin or a Core integration.
use tsumugi_plugin_sdk::{
    EncodedPayload, NativeCapabilityOutput, NativeComponent, NativeInvocationMetadata,
    serve_native_component,
};

struct Echo;
impl NativeComponent for Echo {
    fn invoke(
        &mut self,
        input: &EncodedPayload,
        _metadata: &NativeInvocationMetadata,
    ) -> NativeCapabilityOutput {
        NativeCapabilityOutput::Succeeded(input.utf8.clone())
    }
}
fn main() {
    if let Err(error) = serve_native_component(Echo) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
