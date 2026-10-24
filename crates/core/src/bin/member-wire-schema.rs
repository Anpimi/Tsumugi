fn main() {
    use schemars::transform::{RecursiveTransform, Transform};
    use tsumugi_core::ai::member_wire::*;
    let mut schema = schemars::generate::SchemaSettings::draft2020_12()
        .with(|settings| settings.contract = schemars::generate::Contract::Serialize)
        .into_generator()
        .into_root_schema_for::<MemberFrame>();
    // JSON numbers must round-trip through the Node boundary without loss.
    RecursiveTransform(|schema: &mut schemars::Schema| {
        let bound = match schema.get("format").and_then(|value| value.as_str()) {
            Some("uint16") => 65_535u64,
            Some("uint32") => 4_294_967_295,
            Some("uint64") => 9_007_199_254_740_991,
            _ => return,
        };
        let object = schema.ensure_object();
        object.remove("format");
        if object
            .get("maximum")
            .and_then(|value| value.as_u64())
            .is_none_or(|max| max > bound)
        {
            object.insert("maximum".into(), bound.into());
        }
    })
    .transform(&mut schema);
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "schema":schema,
        "profile":{"protocolVersion":PROTOCOL,"maxFrameBytes":MAX_FRAME_BYTES,"maxSessionBytes":MAX_SESSION_BYTES}
    })).unwrap());
}
