//! Real signed offline repositories for isolated Host and Desktop tests.
use aws_lc_rs::{rand::SystemRandom, signature::Ed25519KeyPair};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    fmt, fs,
    num::NonZeroU64,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use tough::{
    TargetName,
    editor::signed::SignedRole,
    key_source::KeySource,
    schema::{
        Hashes, KeyHolder, Metafile, Role, RoleKeys, RoleType, Root, Snapshot, Target, Targets,
        Timestamp,
    },
    sign::Sign,
};
use tsumugi_plugin_host::{
    PackageFile, PackageImage,
    repository::{CapturedOfflineRepository, RepositoryCatalog, RepositoryPackageDeclaration},
};
use tsumugi_plugin_sdk as sdk;

pub const FUTURE: &str = "2099-01-01T00:00:00Z";
pub const EXPIRED: &str = "2000-01-01T00:00:00Z";

#[derive(Clone)]
struct FixtureKey(Vec<u8>);

impl fmt::Debug for FixtureKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("FixtureKey")
    }
}

impl FixtureKey {
    fn new() -> Self {
        Self(
            Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .unwrap()
                .as_ref()
                .to_vec(),
        )
    }

    fn public(&self) -> tough::schema::key::Key {
        tough::sign::parse_keypair(&self.0).unwrap().tuf_key()
    }
}

#[tough::async_trait]
impl KeySource for FixtureKey {
    async fn as_sign(&self) -> Result<Box<dyn Sign>, Box<dyn Error + Send + Sync + 'static>> {
        Ok(Box::new(tough::sign::parse_keypair(&self.0)?))
    }

    async fn write(
        &self,
        _value: &str,
        _key_id_hex: &str,
    ) -> Result<(), Box<dyn Error + Send + Sync + 'static>> {
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported).into())
    }
}

fn number(version: u64) -> NonZeroU64 {
    NonZeroU64::new(version).unwrap()
}

fn root(key: &FixtureKey, version: u64, consistent_snapshot: bool) -> Root {
    let public = key.public();
    let key_id = public.key_id().unwrap();
    Root {
        spec_version: "1.0.0".into(),
        consistent_snapshot,
        version: number(version),
        expires: FUTURE.parse().unwrap(),
        keys: HashMap::from([(key_id.clone(), public)]),
        roles: [
            RoleType::Root,
            RoleType::Timestamp,
            RoleType::Snapshot,
            RoleType::Targets,
        ]
        .into_iter()
        .map(|role| {
            (
                role,
                RoleKeys {
                    keyids: vec![key_id.clone()],
                    threshold: number(1),
                    _extra: HashMap::new(),
                },
            )
        })
        .collect(),
        _extra: HashMap::new(),
    }
}

async fn sign<T: Role + serde::Serialize>(role: T, root: &Root, key: &FixtureKey) -> SignedRole<T> {
    SignedRole::new(
        role,
        &KeyHolder::Root(root.clone()),
        &[Box::new(key.clone())],
        &SystemRandom::new(),
    )
    .await
    .unwrap()
}

fn hashes(bytes: &[u8]) -> Hashes {
    Hashes {
        sha256: Sha256::digest(bytes).to_vec().into(),
        _extra: HashMap::new(),
    }
}

fn metadata(version: u64, bytes: &[u8]) -> Metafile {
    Metafile {
        length: Some(bytes.len() as u64),
        hashes: Some(hashes(bytes)),
        version: number(version),
        _extra: HashMap::new(),
    }
}

pub fn package(root: &Path, directory: &str, version: &str) -> RepositoryPackageDeclaration {
    let plugin = sdk::PluginIdentity {
        publisher: "declared-publisher".into(),
        id: "example.resource".into(),
        version: version.into(),
    };
    let manifest = serde_json::to_vec(&json!({
        "protocolVersion": 1, "plugin": plugin, "permissions": [],
        "components": [{
            "id": "data", "scope": "project", "runtime": "data", "entrypoint": null,
            "dependencies": [], "exit": {"stopTimeoutMs": 100, "cleanupTimeoutMs": 100}
        }],
        "contributions": [{
            "id": "data.resource", "componentId": "data", "contribution": {
                "kind": "resource",
                "schema": {"id": "example.data", "schemaVersion": 1, "behaviorVersion": 1},
                "path": "data.bin"
            }
        }]
    }))
    .unwrap();
    let files = BTreeMap::from([(
        "data.bin".into(),
        PackageFile {
            bytes: format!("resource version {version}").into_bytes(),
            executable: false,
        },
    )]);
    let directory_path = root.join("packages").join(directory);
    fs::create_dir_all(&directory_path).unwrap();
    fs::write(directory_path.join("manifest.json"), &manifest).unwrap();
    fs::write(directory_path.join("data.bin"), &files["data.bin"].bytes).unwrap();
    fs::set_permissions(
        directory_path.join("manifest.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::set_permissions(
        directory_path.join("data.bin"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    RepositoryPackageDeclaration {
        directory: directory.into(),
        plugin,
        package_digest: PackageImage::digest(&manifest, &files).unwrap(),
        publisher_id: "repo-attested-publisher".into(),
    }
}

pub struct Fixture {
    _temporary: tempfile::TempDir,
    pub directory: PathBuf,
    pub anchor: Vec<u8>,
    root: Root,
    key: FixtureKey,
    pub catalog: RepositoryCatalog,
}

impl Fixture {
    pub async fn new(consistent: bool) -> Self {
        Self::new_with_package(consistent, |directory| {
            package(directory, "current", "1.0.0")
        })
        .await
    }

    pub async fn new_with_package(
        consistent: bool,
        make_package: impl FnOnce(&Path) -> RepositoryPackageDeclaration,
    ) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("repository");
        fs::create_dir_all(directory.join("metadata")).unwrap();
        fs::create_dir_all(directory.join("targets")).unwrap();
        let key = FixtureKey::new();
        let root = root(&key, 1, consistent);
        let anchor = sign(root.clone(), &root, &key).await.buffer().clone();
        fs::write(directory.join("metadata/1.root.json"), &anchor).unwrap();
        let catalog = RepositoryCatalog {
            format_version: 1,
            display_name: "Offline repository".into(),
            packages: vec![make_package(&directory)],
        };
        let fixture = Self {
            _temporary: temporary,
            directory,
            anchor,
            root,
            key,
            catalog,
        };
        fixture
            .publish(
                (1, 1, 1),
                FUTURE,
                serde_json::to_value(&fixture.catalog).unwrap(),
            )
            .await;
        fixture
    }

    pub async fn publish(
        &self,
        versions: (u64, u64, u64),
        timestamp_expires: &str,
        catalog: Value,
    ) {
        self.publish_profile(versions, timestamp_expires, catalog, false)
            .await;
    }

    pub async fn publish_delegated(&self) {
        self.publish_profile(
            (2, 2, 2),
            FUTURE,
            serde_json::to_value(&self.catalog).unwrap(),
            true,
        )
        .await;
    }

    async fn publish_profile(
        &self,
        versions: (u64, u64, u64),
        timestamp_expires: &str,
        catalog: Value,
        delegated: bool,
    ) {
        let bytes = serde_json::to_vec(&catalog).unwrap();
        for entry in fs::read_dir(self.directory.join("targets")).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }
        let filename = if self.root.consistent_snapshot {
            format!("{:x}.catalog.json", Sha256::digest(&bytes))
        } else {
            "catalog.json".into()
        };
        fs::write(self.directory.join("targets").join(filename), &bytes).unwrap();
        let mut targets = Targets::new("1.0.0".into(), number(versions.2), FUTURE.parse().unwrap());
        targets.targets.insert(
            TargetName::new("catalog.json").unwrap(),
            Target {
                length: bytes.len() as u64,
                hashes: hashes(&bytes),
                custom: HashMap::new(),
                _extra: HashMap::new(),
            },
        );
        if delegated {
            let key = self.key.public();
            let key_id = key.key_id().unwrap();
            let key_id_text = serde_json::to_value(&key_id)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned();
            targets.delegations = Some(
                serde_json::from_value(json!({
                    "keys": {(key_id_text): key},
                    "roles": [{"name": "2.targets", "keyids": [key_id], "threshold": 1,
                        "paths": ["*"], "terminating": false}]
                }))
                .unwrap(),
            );
        }
        let targets = sign(targets, &self.root, &self.key).await;
        let mut snapshot =
            Snapshot::new("1.0.0".into(), number(versions.1), FUTURE.parse().unwrap());
        snapshot.meta.insert(
            "targets.json".into(),
            metadata(versions.2, targets.buffer()),
        );
        let snapshot = sign(snapshot, &self.root, &self.key).await;
        let mut timestamp = Timestamp::new(
            "1.0.0".into(),
            number(versions.0),
            timestamp_expires.parse().unwrap(),
        );
        timestamp.meta.insert(
            "snapshot.json".into(),
            metadata(versions.1, snapshot.buffer()),
        );
        let timestamp = sign(timestamp, &self.root, &self.key).await;
        let output = self.directory.join("metadata");
        targets
            .write(&output, self.root.consistent_snapshot)
            .await
            .unwrap();
        snapshot
            .write(&output, self.root.consistent_snapshot)
            .await
            .unwrap();
        timestamp
            .write(&output, self.root.consistent_snapshot)
            .await
            .unwrap();
    }

    pub async fn rotate(&mut self, cross_sign: bool) {
        let new_key = FixtureKey::new();
        let new_root = root(
            &new_key,
            self.root.version.get() + 1,
            self.root.consistent_snapshot,
        );
        let mut signed = sign(new_root.clone(), &new_root, &new_key).await;
        if cross_sign {
            let old = sign(new_root.clone(), &self.root, &self.key).await;
            signed = signed
                .add_old_signatures(old.signed().signatures.clone())
                .unwrap();
        }
        fs::write(
            self.directory
                .join(format!("metadata/{}.root.json", new_root.version)),
            signed.buffer(),
        )
        .unwrap();
        self.key = new_key;
        self.root = new_root;
    }

    /// Stage a role-key rollover where old role signatures remain valid under
    /// the new root. This distinguishes required cache invalidation from merely
    /// ignoring an old cache whose signatures no longer verify.
    pub async fn rotate_retaining_role_keys(&mut self, expires: &str) {
        let new_key = FixtureKey::new();
        let old_public = self.key.public();
        let old_id = old_public.key_id().unwrap();
        let mut new_root = root(
            &new_key,
            self.root.version.get() + 1,
            self.root.consistent_snapshot,
        );
        new_root.expires = expires.parse().unwrap();
        new_root.keys.insert(old_id.clone(), old_public);
        for role in [RoleType::Timestamp, RoleType::Snapshot] {
            new_root
                .roles
                .get_mut(&role)
                .unwrap()
                .keyids
                .push(old_id.clone());
        }
        let new = sign(new_root.clone(), &new_root, &new_key).await;
        let old = sign(new_root.clone(), &self.root, &self.key).await;
        let signed = new
            .add_old_signatures(old.signed().signatures.clone())
            .unwrap();
        fs::write(
            self.directory
                .join(format!("metadata/{}.root.json", new_root.version)),
            signed.buffer(),
        )
        .unwrap();
        self.key = new_key;
        self.root = new_root;
    }

    pub async fn advance_root_same_keys(&mut self, expires: &str) {
        let mut new_root = self.root.clone();
        new_root.version = number(new_root.version.get() + 1);
        new_root.expires = expires.parse().unwrap();
        let signed = sign(new_root.clone(), &new_root, &self.key).await;
        fs::write(
            self.directory
                .join(format!("metadata/{}.root.json", new_root.version)),
            signed.buffer(),
        )
        .unwrap();
        self.root = new_root;
    }

    pub fn capture(&self) -> CapturedOfflineRepository {
        CapturedOfflineRepository::capture_directory(&self.directory, || true).unwrap()
    }

    pub fn write_initial_root(&self) -> PathBuf {
        let path = self._temporary.path().join("initial-root.json");
        fs::write(&path, &self.anchor).unwrap();
        path
    }
}
