use super::*;
use openidconnect::{AccessToken, JsonWebKeyId, PrivateSigningKey,
    core::{CoreEdDsaPrivateSigningKey, CoreIdToken, CoreIdTokenClaims}};
use serde_json::{Value, json};

// Deliberately public, deterministic synthetic seeds; never application keys.
const TEST_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----";
const OTHER_KEY: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB\n-----END PRIVATE KEY-----";
const CLIENT: &str = "oaiapp_synthetic";
const NONCE: &str = "synthetic-nonce";

fn claims() -> Value {
    let now = now_ms().unwrap() / 1000;
    json!({"iss":ISSUER,"sub":"synthetic-subject","aud":[CLIENT],
        "exp":now+3600,"iat":now-20,"nonce":NONCE,"email":"account@example.test"})
}

fn signed_response(claims: Value, key: &str, hash_access: Option<&str>) -> CoreTokenResponse {
    let key = CoreEdDsaPrivateSigningKey::from_ed25519_pem(key,
        Some(JsonWebKeyId::new("synthetic-key".into()))).unwrap();
    let claims: CoreIdTokenClaims = serde_json::from_value(claims).unwrap();
    let access = hash_access.map(|value| AccessToken::new(value.into()));
    let token = CoreIdToken::new(claims, &key, CoreJwsSigningAlgorithm::EdDsa,
        access.as_ref(), None).unwrap();
    serde_json::from_value(json!({"access_token":"synthetic-access","refresh_token":"synthetic-refresh",
        "token_type":"Bearer","expires_in":3600,"scope":"openid email profile offline_access resource.invoke chatgpt.tokens.use.direct",
        "id_token":token.to_string()})).unwrap()
}

fn keys() -> CoreJsonWebKeySet {
    let key = CoreEdDsaPrivateSigningKey::from_ed25519_pem(TEST_KEY,
        Some(JsonWebKeyId::new("synthetic-key".into()))).unwrap();
    // Exercise the published JWKS JSON parsing path, not an unverified token
    // payload or a mock identity parser.
    let document = json!({"keys":[key.as_verification_key()]});
    serde_json::from_value(document).unwrap()
}

fn verify(response: &CoreTokenResponse, nonce: &str, required: bool)
    -> Result<(String, String), ExecutionError>
{
    verify_identity(response, CLIENT, nonce, required, keys(), vec![CoreJwsSigningAlgorithm::EdDsa])
}

#[test]
fn oidc_verifies_signature_jwks_issuer_audience_expiry_and_nonce_before_identity() {
    let response = signed_response(claims(), TEST_KEY, Some("synthetic-access"));
    assert_eq!(verify(&response, NONCE, true).unwrap(),
        ("synthetic-subject".into(), "account@example.test".into()));
    assert!(verify(&response, "another-nonce", true).is_err());
    let mut invalid = claims();
    invalid["iss"] = json!("https://untrusted.example.test");
    assert!(verify(&signed_response(invalid, TEST_KEY, None), NONCE, true).is_err());
    let mut invalid = claims();
    invalid["aud"] = json!(["oaiapp_another"]);
    assert!(verify(&signed_response(invalid, TEST_KEY, None), NONCE, true).is_err());
    let mut invalid = claims();
    invalid["aud"] = json!([CLIENT, "oaiapp_untrusted"]);
    assert!(verify(&signed_response(invalid, TEST_KEY, None), NONCE, true).is_err());
    let mut invalid = claims();
    invalid["exp"] = json!(now_ms().unwrap()/1000-1);
    assert!(verify(&signed_response(invalid, TEST_KEY, None), NONCE, true).is_err());
    assert!(verify(&signed_response(claims(), OTHER_KEY, None), NONCE, true).is_err());
    assert!(verify(&signed_response(claims(), TEST_KEY, Some("substituted-access")), NONCE, true).is_err());
    assert!(verify_identity(&response, CLIENT, NONCE, true, CoreJsonWebKeySet::new(Vec::new()),
        vec![CoreJwsSigningAlgorithm::EdDsa]).is_err());
    assert!(verify_identity(&response, CLIENT, NONCE, true, keys(),
        vec![CoreJwsSigningAlgorithm::None, CoreJwsSigningAlgorithm::HmacSha256]).is_err());
}

#[test]
fn oidc_refresh_may_omit_nonce_but_cannot_change_a_present_nonce_or_grant_scope() {
    let mut absent = claims();
    absent.as_object_mut().unwrap().remove("nonce");
    let response = signed_response(absent, TEST_KEY, None);
    assert!(verify(&response, NONCE, true).is_err());
    assert!(verify(&response, NONCE, false).is_ok());
    assert!(verify(&signed_response(claims(), TEST_KEY, None), "other", false).is_err());
    let valid = signed_response(claims(), TEST_KEY, None);
    let mut insufficient = serde_json::to_value(&valid).unwrap();
    insufficient["scope"] = json!("openid profile email");
    let insufficient: CoreTokenResponse = serde_json::from_value(insufficient).unwrap();
    assert!(verify(&insufficient, NONCE, true).is_ok());
    assert!(credentials(&insufficient, ExecutionId::new(), NONCE, None, None).is_err());
    let original = credentials(&valid, ExecutionId::new(), NONCE, None, None).unwrap();
    let mut missing_rotated_token = serde_json::to_value(valid).unwrap();
    missing_rotated_token.as_object_mut().unwrap().remove("refresh_token");
    let missing_rotated_token: CoreTokenResponse = serde_json::from_value(missing_rotated_token).unwrap();
    assert!(credentials(&missing_rotated_token, original.account, NONCE, Some(&original), None).is_err());
}

fn prepared(selected: Option<Registration>) -> PreparedLogin {
    prepare(ExecutionId::new(), selected, ExecutionId::new(), now_ms().unwrap()+300_000).unwrap()
}

fn callback_request(pending: &PreparedLogin, query: &str) -> Vec<u8> {
    let url = Url::parse(&pending.redirect).unwrap();
    format!("GET /auth/callback?{query} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",url.port().unwrap()).into_bytes()
}

#[test]
fn authorization_uses_fresh_pkce_state_nonce_exact_loopback_and_no_credential_hint() {
    let first = prepared(None);
    let second = prepared(None);
    let url = Url::parse(&first.view.authorization_url).unwrap();
    assert_eq!(url.origin().ascii_serialization(), ISSUER);
    assert_eq!(url.path(), "/api/accounts/authorize");
    let params: BTreeMap<_,_> = url.query_pairs().into_owned().collect();
    assert_eq!(params["client_id"], DYNAMIC_CLIENT);
    assert_eq!(params["agent_name_hint"], "Tsumugi");
    assert_eq!(params["redirect_uri"], first.redirect);
    assert_eq!(params["resource"], RESOURCE);
    assert_eq!(params["code_challenge_method"], "S256");
    assert!(params["ext_agent_host_id"].starts_with("urn:uuid:"));
    assert!(!params.contains_key("id_token_hint"));
    assert!(!params.contains_key("login_hint"));
    let second_params: BTreeMap<_,_> = Url::parse(&second.view.authorization_url).unwrap().query_pairs().into_owned().collect();
    for parameter in ["state", "nonce", "code_challenge"] { assert_ne!(params[parameter],second_params[parameter]); }
}

#[test]
fn callback_rejects_wrong_state_path_host_duplicate_fields_and_missing_issued_client() {
    let pending = prepared(None);
    let query = format!("state={}&code=synthetic-code&client_id={CLIENT}", pending.state.secret());
    let parsed = parse_callback(&callback_request(&pending, &query), &pending).unwrap();
    assert!(parsed.is_ok());
    for query in ["state=wrong&code=c&client_id=oaiapp_synthetic".into(),
        format!("state={}&code=c",pending.state.secret()),
        format!("state={}&code=c&client_id=dynamic_agent_client",pending.state.secret()),
        format!("{query}&state=duplicate"), format!("{query}&code=duplicate")]
    { assert!(parse_callback(&callback_request(&pending, &query), &pending).is_err()); }
    let bytes = callback_request(&pending, &query);
    let request = String::from_utf8(bytes).unwrap();
    assert!(parse_callback(request.replace("/auth/callback?", "/callback?").as_bytes(), &pending).is_err());
    assert!(parse_callback(request.replace("Host: 127.0.0.1", "Host: localhost").as_bytes(), &pending).is_err());
    assert!(parse_callback(request.replace("GET ", "POST ").as_bytes(), &pending).is_err());
    let denied = format!("state={}&error=access_denied",pending.state.secret());
    assert!(matches!(parse_callback(&callback_request(&pending,&denied),&pending),
        Ok(Err(ChatGptAccountIssue::LoginCancelled))));
    assert!(parse_callback(&callback_request(&pending,"state=wrong&error=access_denied"),&pending).is_err());
}

#[test]
fn returning_registration_keeps_issued_client_and_rejects_a_different_client() {
    let selected = Registration { id:ExecutionId::new(),client_id:CLIENT.into(),subject:"subject".into(),
        label:"Synthetic".into(),credentials:None };
    let pending = prepared(Some(selected));
    let params:BTreeMap<_,_> = Url::parse(&pending.view.authorization_url).unwrap().query_pairs().into_owned().collect();
    assert_eq!(params["client_id"],CLIENT);
    assert!(!params.contains_key("agent_name_hint"));
    let query = format!("state={}&code=c",pending.state.secret());
    let callback = parse_callback(&callback_request(&pending,&query),&pending).unwrap();
    assert!(callback.is_ok());
    assert!(parse_callback(&callback_request(&pending,&format!("{query}&client_id=oaiapp_other")),&pending).is_err());
}

#[test]
fn catalog_uses_server_order_display_names_and_only_visible_models() {
    let models = parse_models(br#"{"models":[{"slug":"second","display_name":"Second model","visibility":"list"},{"slug":"hidden","display_name":"Hidden","visibility":"hidden"},{"slug":"first","display_name":"First model","visibility":"list"}]}"#).unwrap();
    assert_eq!(models,vec![ChatGptModelView{id:"second".into(),label:"Second model".into()},
        ChatGptModelView{id:"first".into(),label:"First model".into()}]);
    assert!(parse_models(br#"{"data":[]}"#).is_err());
    assert!(parse_models(br#"{"models":[{"slug":"duplicate","display_name":"A","visibility":"list"},{"slug":"duplicate","display_name":"B","visibility":"list"}]}"#).is_err());
}
