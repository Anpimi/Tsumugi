//! Verify the independently reviewed package before adapting a synthetic copy.
//! Only component ownership/scope and the corresponding strict Worker identity
//! guards change in memory. Code bytes therefore differ; installed material,
//! SDK validators and all other domain checks remain unchanged.
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};
use tsumugi_plugin_host::{PackageFile, PackageImage};
use tsumugi_plugin_sdk as sdk;

type ComponentIdentities = BTreeMap<String, (String, String)>;

fn scoped_identity<'a>(
    identities: &'a ComponentIdentities,
    contribution: &str,
    original: &str,
) -> &'a str {
    let (captured, scoped) = identities
        .get(contribution)
        .unwrap_or_else(|| panic!("Missing reviewed capability {contribution}"));
    assert_eq!(captured, original, "Unexpected owner for {contribution}");
    scoped
}

fn replace_guard(source: &mut String, original: &str, adapted: &str) {
    assert_eq!(
        source.matches(original).count(),
        1,
        "Reviewed Worker identity guard changed: {original}"
    );
    *source = source.replacen(original, adapted, 1);
}

/// The reviewed workers deliberately validate their own component identity.
/// Keep those exact comparisons aligned with the synthetic manifest rather
/// than disabling them or accepting an arbitrary component from the request.
fn adapt_identity_guards(
    plugin: &sdk::PluginIdentity,
    identities: &ComponentIdentities,
    files: &mut BTreeMap<String, PackageFile>,
) {
    let (path, original_component) = match (plugin.publisher.as_str(), plugin.id.as_str()) {
        ("org.tsumugi", "webvtt") => ("components/webvtt.mjs", "caption-worker"),
        ("org.tsumugi", "stardew-smapi") => ("components/smapi.mjs", "smapi-worker"),
        ("org.tsumugi.examples", "philosophy") => ("components/text-review.mjs", "knowledge"),
        _ => panic!("No reviewed scope fixture adapter for {}", plugin.id),
    };
    let file = files
        .get_mut(path)
        .unwrap_or_else(|| panic!("Missing reviewed Worker {path}"));
    let mut source = String::from_utf8(file.bytes.clone()).unwrap();
    let quoted_identity = |contribution| {
        serde_json::to_string(scoped_identity(
            identities,
            contribution,
            original_component,
        ))
        .unwrap()
    };
    match plugin.id.as_str() {
        "webvtt" => {
            for contribution in ["source-semantic-check", "review-check", "validate-artifact"] {
                replace_guard(
                    &mut source,
                    &format!(
                        "provider.componentId !== 'caption-worker' || provider.contributionId !== '{contribution}'"
                    ),
                    &format!(
                        "provider.componentId !== {} || provider.contributionId !== '{contribution}'",
                        quoted_identity(contribution)
                    ),
                );
            }
        }
        "stardew-smapi" => {
            // requirement() serves these three fixed call sites. A different
            // contribution has no mapped identity and still fails the guard.
            let expected: BTreeMap<_, _> = [
                "source-semantic-check",
                "translation-semantic-check",
                "validate-artifact",
            ]
            .into_iter()
            .map(|contribution| {
                (
                    contribution,
                    scoped_identity(identities, contribution, original_component),
                )
            })
            .collect();
            replace_guard(
                &mut source,
                "provider.componentId !== 'smapi-worker' || provider.contributionId !== contribution",
                &format!(
                    "provider.componentId !== ({})[contribution] || provider.contributionId !== contribution",
                    serde_json::to_string(&expected).unwrap()
                ),
            );
            replace_guard(
                &mut source,
                "provider.componentId !== 'smapi-worker' || provider.contributionId !== 'review-check'",
                &format!(
                    "provider.componentId !== {} || provider.contributionId !== 'review-check'",
                    quoted_identity("review-check")
                ),
            );
        }
        "philosophy" => replace_guard(
            &mut source,
            "actual.componentId !== 'knowledge' || actual.contributionId !== 'check'",
            &format!(
                "actual.componentId !== {} || actual.contributionId !== 'check'",
                quoted_identity("check")
            ),
        ),
        _ => unreachable!(),
    }
    assert!(
        !source.contains(&format!("componentId !== '{original_component}'")),
        "Unadapted reviewed Worker identity guard in {path}"
    );
    file.bytes = source.into_bytes();
}

pub fn capture(
    directory: &Path,
    expected: &str,
    scope: impl Fn(&str) -> sdk::ComponentScope,
) -> PackageImage {
    let original = PackageImage::capture_directory(directory, expected, || true).unwrap();
    fn collect(root: &Path, at: &Path, files: &mut BTreeMap<String, PackageFile>) {
        for entry in std::fs::read_dir(at).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            assert!(!kind.is_symlink());
            if kind.is_dir() {
                collect(root, &entry.path(), files);
            } else {
                assert!(kind.is_file());
                let name = entry
                    .path()
                    .strip_prefix(root)
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned();
                if name != "manifest.json" {
                    assert!(
                        files
                            .insert(
                                name,
                                PackageFile {
                                    bytes: std::fs::read(entry.path()).unwrap(),
                                    executable: entry.metadata().unwrap().permissions().mode()
                                        & 0o111
                                        != 0,
                                }
                            )
                            .is_none()
                    );
                }
            }
        }
    }
    let mut files = BTreeMap::new();
    collect(directory, directory, &mut files);
    assert_eq!(
        PackageImage::digest(
            &std::fs::read(directory.join("manifest.json")).unwrap(),
            &files
        )
        .unwrap(),
        expected
    );
    let mut manifest = original.manifest().manifest().clone();
    let components = manifest.components.clone();
    let mut identities = ComponentIdentities::new();
    for contribution in &mut manifest.contributions {
        if matches!(
            contribution.contribution,
            sdk::ContributionKind::Capability { .. }
        ) {
            let mut component = components
                .iter()
                .find(|component| component.id == contribution.component_id)
                .unwrap()
                .clone();
            let original_component = component.id.clone();
            component.id = format!("scoped-{}", contribution.id);
            component.scope = scope(&contribution.id);
            contribution.component_id = component.id.clone();
            assert!(
                identities
                    .insert(
                        contribution.id.clone(),
                        (original_component, component.id.clone()),
                    )
                    .is_none()
            );
            manifest.components.push(component);
        }
    }
    // A split can leave the old worker with no contributions (for example,
    // a package whose resources belong to a separate data component).
    manifest.components.retain(|component| {
        manifest
            .contributions
            .iter()
            .any(|entry| entry.component_id == component.id)
    });
    adapt_identity_guards(&manifest.plugin, &identities, &mut files);
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let digest = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &digest).unwrap()
}
