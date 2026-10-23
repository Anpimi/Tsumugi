#![cfg(any(target_os = "macos", target_os = "linux"))]

//! A separately authored, data-only package through the actual signed local
//! directory and durable installation path. The author project and built bytes
//! are explicit external inputs; this test never manufactures their identity.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};
use tsumugi_plugin_host::{
    PackageImage, PackageStore, RepositoryRefreshRequest, catalog::PackageApproval,
    repository::RepositoryPackageDeclaration, repository_source_id,
};

#[path = "support/offline_repository.rs"]
mod offline_repository;
use offline_repository::Fixture;

const PUBLISHER: &str = "org.example.synthetic";
const PUBLISHER_ID: &str = "synthetic-external-author";
const REPOSITORY_ACTION: &str = "00000000-0000-4000-8000-000000000201";
const INSTALL_ACTION: &str = "00000000-0000-4000-8000-000000000202";

fn directory(name: &str) -> PathBuf {
    let path =
        PathBuf::from(env::var_os(name).expect("explicit external author directory required"));
    assert!(
        path.is_absolute(),
        "external author directory must be absolute"
    );
    path.canonicalize()
        .expect("external author directory must exist")
}

#[test]
#[ignore = "requires an independently prepared synthetic author source, package and inspected digest"]
fn external_author_package_is_listed_verified_and_explicitly_installed() {
    let source = directory("TSUMUGI_TEST_EXTERNAL_AUTHOR_SOURCE");
    let package = directory("TSUMUGI_TEST_EXTERNAL_AUTHOR_PACKAGE");
    let digest = env::var("TSUMUGI_TEST_EXTERNAL_AUTHOR_DIGEST")
        .expect("explicit independent Host package digest required");
    let application = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    assert_ne!(source, package);
    assert!(!source.starts_with(&application));
    assert!(!package.starts_with(&application));

    let recipe: Value =
        serde_json::from_slice(&fs::read(source.join("package-files.json")).unwrap()).unwrap();
    assert_eq!(recipe["formatVersion"], 1);
    assert_eq!(recipe["files"], json!(["manifest.json", "data.bin"]));
    assert!(
        recipe
            .get("sdkFiles")
            .is_none_or(|files| files == &json!([]))
    );
    let readme = fs::read_to_string(source.join("README.md")).unwrap();
    assert!(readme.contains(PUBLISHER));
    assert!(readme.contains("Maintainer:"));
    assert!(readme.contains("synthetic"));
    assert!(!fs::read(source.join("LICENSE")).unwrap().is_empty());
    let sdk_lock: Value =
        serde_json::from_slice(&fs::read(source.join("sdk.lock.json")).unwrap()).unwrap();
    assert_eq!(sdk_lock["package"], "tsumugi-plugin-sdk");
    let sdk_archive = source
        .join(sdk_lock["archive"].as_str().unwrap())
        .canonicalize()
        .unwrap();
    assert!(sdk_archive.starts_with(&source));
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(sdk_archive).unwrap())),
        sdk_lock["sha256"].as_str().unwrap()
    );
    for name in ["manifest.json", "data.bin"] {
        assert_eq!(
            fs::read(source.join(name)).unwrap(),
            fs::read(package.join(name)).unwrap(),
            "the packaged file must come from the external author project"
        );
    }

    let inspection = PackageImage::inspect_directory(&package, || true).unwrap();
    assert_eq!(inspection.package_digest, digest);
    assert_eq!(inspection.file_count, 2);
    assert_eq!(inspection.plugin.publisher, PUBLISHER);
    assert_eq!(inspection.plugin.id, "external-notes");
    let image = PackageImage::capture_directory(&package, &digest, || true).unwrap();
    assert_eq!(image.inspection(), inspection);
    let manifest: Value =
        serde_json::from_slice(&fs::read(package.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(manifest["components"][0]["runtime"], "data");
    assert_eq!(
        manifest["contributions"][0]["contribution"]["kind"],
        "resource"
    );

    let expected_plugin = inspection.plugin.clone();
    let expected_digest = digest.clone();
    let package_for_directory = package.clone();
    let fixture = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(Fixture::new_with_package(false, move |repository| {
            let target = repository.join("packages/external-author");
            fs::create_dir_all(&target).unwrap();
            for name in ["manifest.json", "data.bin"] {
                fs::copy(package_for_directory.join(name), target.join(name)).unwrap();
            }
            RepositoryPackageDeclaration {
                directory: "external-author".into(),
                plugin: expected_plugin,
                package_digest: expected_digest,
                publisher_id: PUBLISHER_ID.into(),
            }
        }));
    let captured = fixture.capture();
    let source_id = repository_source_id(&fixture.anchor).unwrap();
    let request = RepositoryRefreshRequest {
        source_id: source_id.clone(),
        expected_revision: 0,
        action_id: REPOSITORY_ACTION.into(),
        initial_root: fixture.anchor.clone(),
        capture_digest: captured.capture_digest().into(),
    };
    let temporary = tempfile::tempdir().unwrap();
    let store_root = temporary.path().join("store");
    let mut store = PackageStore::provision(temporary.path(), &["store"], || true).unwrap();
    assert!(store.repository_sources(|| true).unwrap().is_empty());
    let verified = store
        .refresh_repository(&request, &captured, || true)
        .unwrap();
    assert_eq!(verified.source_id(), source_id);
    assert_eq!(verified.catalog(), &fixture.catalog);
    assert_eq!(verified.packages().len(), 1);
    let selected = &verified.packages()[0];
    assert_eq!(selected.plugin(), &inspection.plugin);
    assert_eq!(selected.package_digest(), digest);
    assert_eq!(selected.image().inspection(), inspection);
    assert_eq!(selected.origin().source_id, source_id);
    assert_eq!(selected.origin().publisher_id, PUBLISHER_ID);
    let records = store.repository_sources(|| true).unwrap();
    assert_eq!(records.len(), 1);
    let record = &records[0];
    assert_eq!(record.source_id, source_id);
    assert_eq!(record.revision, 1);
    assert!(record.pending.is_none());

    let approval = PackageApproval {
        plugin: selected.plugin().clone(),
        package_digest: selected.package_digest().into(),
        origin: selected.origin().clone(),
    };
    let receipt = store.install(INSTALL_ACTION, selected, || true).unwrap();
    assert_eq!(receipt.action_id(), INSTALL_ACTION);
    assert_eq!(receipt.plugin(), &approval.plugin);
    assert_eq!(receipt.package_digest(), approval.package_digest);
    assert_eq!(receipt.origin(), &approval.origin);
    drop(store);
    let reopened = PackageStore::open_existing(&store_root).unwrap();
    let installed = reopened.load(&approval, || true).unwrap();
    assert_eq!(installed.receipt(), &receipt);
    assert_eq!(installed.image().inspection(), inspection);
    assert_eq!(installed.image().package_digest(), digest);
    println!(
        "synthetic external author package verified and loaded: {source_id} {PUBLISHER_ID} {digest}"
    );
}
