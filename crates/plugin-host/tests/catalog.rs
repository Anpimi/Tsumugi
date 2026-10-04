use std::collections::BTreeMap;

use tsumugi_plugin_host::{
    PackageFile, PackageImage,
    catalog::{
        CatalogError, MAX_CATALOG_PACKAGES, OriginField, PackageApproval, PackageCatalog,
        PackageOrigin,
    },
};
use tsumugi_plugin_sdk as sdk;

fn contract(id: &str) -> sdk::ContractRef {
    sdk::ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}

fn manifest(id: &str, version: &str) -> sdk::PluginManifest {
    sdk::PluginManifest {
        protocol_version: sdk::MANIFEST_PROTOCOL,
        plugin: sdk::PluginIdentity {
            publisher: "example".into(),
            id: id.into(),
            version: version.into(),
        },
        permissions: vec![sdk::PermissionRequest::CapturedInput],
        components: vec![sdk::ComponentDeclaration {
            id: "worker".into(),
            scope: sdk::ComponentScope::Project,
            runtime: sdk::RuntimeKind::JavaScript,
            entrypoint: Some("worker.mjs".into()),
            dependencies: vec![],
            exit: sdk::ExitRequirements {
                stop_timeout_ms: 100,
                cleanup_timeout_ms: 100,
            },
        }],
        contributions: vec![
            sdk::ContributionDeclaration {
                id: "query".into(),
                component_id: "worker".into(),
                contribution: sdk::ContributionKind::Capability {
                    declaration: sdk::CapabilityDeclaration {
                        contract: contract("example.query"),
                        input_schema: contract("example.input"),
                        output_schema: contract("example.output"),
                        error_schema: contract("example.error"),
                        profiles: vec![],
                        effect: sdk::EffectKind::ReadOnly,
                        permissions: vec![sdk::PermissionRequest::CapturedInput],
                        limits: sdk::CapabilityLimits {
                            max_input_bytes: 1024,
                            max_output_bytes: 4096,
                            concurrency: 1,
                            timeout_ms: 1000,
                        },
                    },
                },
            },
            sdk::ContributionDeclaration {
                id: "resource".into(),
                component_id: "worker".into(),
                contribution: sdk::ContributionKind::Resource {
                    schema: contract("example.resource"),
                    path: "resource.json".into(),
                },
            },
        ],
    }
}

fn image(manifest: sdk::PluginManifest, marker: &str) -> PackageImage {
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let files = BTreeMap::from([
        (
            "worker.mjs".into(),
            PackageFile {
                bytes: b"throw new Error('catalog must not activate code');".to_vec(),
                executable: false,
            },
        ),
        (
            "resource.json".into(),
            PackageFile {
                bytes: b"{}".to_vec(),
                executable: false,
            },
        ),
        (
            "marker.txt".into(),
            PackageFile {
                bytes: marker.as_bytes().to_vec(),
                executable: false,
            },
        ),
    ]);
    let expected = PackageImage::digest(&bytes, &files).unwrap();
    PackageImage::capture(bytes, files, &expected).unwrap()
}

fn origin() -> PackageOrigin {
    PackageOrigin {
        source_id: "approved-registry".into(),
        publisher_id: "approved-publisher-key".into(),
    }
}

fn approval(image: &PackageImage) -> PackageApproval {
    PackageApproval {
        plugin: image.manifest().manifest().plugin.clone(),
        package_digest: image.package_digest().into(),
        origin: origin(),
    }
}

fn register(catalog: &mut PackageCatalog, image: PackageImage) -> sdk::PluginIdentity {
    let approval = approval(&image);
    let identity = approval.plugin.clone();
    catalog.register(image, approval).unwrap();
    identity
}

fn choice(plugin: &sdk::PluginIdentity) -> sdk::ProviderKey {
    sdk::ProviderKey {
        plugin: plugin.clone(),
        contribution_id: "query".into(),
    }
}

#[test]
fn approved_registration_starts_disabled_and_retains_actual_binding_and_origin() {
    let mut catalog = PackageCatalog::new();
    assert!(catalog.is_empty());
    let image = image(manifest("example.query", "0.1.0"), "first");
    let digest = image.package_digest().to_owned();
    let identity = register(&mut catalog, image);
    assert_eq!(catalog.len(), 1);
    assert!(!catalog.is_enabled(&identity).unwrap());
    let package = catalog.registered(&identity).unwrap();
    assert_eq!(package.origin(), &origin());
    assert_eq!(package.package_digest(), digest);
    let binding = package.bind_capability("query").unwrap();
    assert_eq!(binding.provider.plugin, identity);
    assert_eq!(binding.provider.component_id, "worker");
    assert_eq!(binding.provider.contribution_id, "query");
    assert_eq!(binding.provider.package_digest, digest);
    for chosen in [vec![], vec![choice(&identity)]] {
        assert_eq!(
            catalog
                .resolve(
                    &contract("example.query"),
                    None,
                    sdk::ProviderSelection::Single,
                    &chosen
                )
                .unwrap_err(),
            CatalogError::DisabledPackage,
        );
    }
    catalog.set_enabled(&identity, true).unwrap();
    let resolved = catalog
        .resolve(
            &contract("example.query"),
            None,
            sdk::ProviderSelection::Single,
            &[],
        )
        .unwrap();
    assert_eq!(resolved[0].binding(), &binding);
    assert_eq!(resolved[0].package().origin(), &origin());
    assert_eq!(
        catalog.lookup(&binding.provider).unwrap().binding(),
        &binding
    );
}

#[test]
fn approval_mismatches_and_same_identity_replacement_never_mutate_registration() {
    let original = image(manifest("example.query", "0.1.0"), "first");
    let mut catalog = PackageCatalog::new();
    for field in ["id", "publisher", "version", "digest"] {
        let mut expected = approval(&original);
        match field {
            "id" => expected.plugin.id = "another.query".into(),
            "publisher" => expected.plugin.publisher = "another".into(),
            "version" => expected.plugin.version = "0.2.0".into(),
            "digest" => expected.package_digest = "a".repeat(64),
            _ => unreachable!(),
        }
        assert_eq!(
            catalog.register(original.clone(), expected).unwrap_err(),
            if field == "digest" {
                CatalogError::DigestMismatch
            } else {
                CatalogError::IdentityMismatch
            }
        );
        assert!(catalog.is_empty());
    }
    let identity = register(&mut catalog, original.clone());
    assert_eq!(
        catalog
            .register(original.clone(), approval(&original))
            .unwrap_err(),
        CatalogError::DuplicatePackage
    );
    let changed = image(manifest("example.query", "0.1.0"), "changed bytes");
    assert_ne!(original.package_digest(), changed.package_digest());
    assert_eq!(
        catalog
            .register(changed.clone(), approval(&changed))
            .unwrap_err(),
        CatalogError::IdentityDigestConflict
    );
    assert_eq!(
        catalog.registered(&identity).unwrap().package_digest(),
        original.package_digest()
    );
    assert!(!catalog.is_enabled(&identity).unwrap());
    assert_eq!(catalog.len(), 1);
}

#[test]
fn logical_plugin_cannot_move_source_or_publisher_even_at_another_version() {
    let mut catalog = PackageCatalog::new();
    register(
        &mut catalog,
        image(manifest("example.query", "0.1.0"), "first"),
    );
    let next = image(manifest("example.query", "0.2.0"), "next");
    let mut expected = approval(&next);
    expected.origin.source_id = "another-registry".into();
    assert_eq!(
        catalog.register(next.clone(), expected).unwrap_err(),
        CatalogError::SourceConflict
    );
    let mut expected = approval(&next);
    expected.origin.publisher_id = "another-approved-key".into();
    assert_eq!(
        catalog.register(next.clone(), expected).unwrap_err(),
        CatalogError::PublisherConflict
    );
    let mut changed_publisher = manifest("example.query", "0.2.0");
    changed_publisher.plugin.publisher = "another".into();
    let changed = image(changed_publisher, "next");
    assert_eq!(
        catalog
            .register(changed.clone(), approval(&changed))
            .unwrap_err(),
        CatalogError::PublisherConflict
    );
    assert_eq!(catalog.len(), 1);
    register(&mut catalog, next);
    assert_eq!(catalog.len(), 2);
}

#[test]
fn single_resolution_requires_explicit_provider_and_version_independent_of_order() {
    for reverse in [false, true] {
        let mut packages = vec![
            image(manifest("example.query", "0.1.0"), "first"),
            image(manifest("example.query", "0.2.0"), "second"),
            image(manifest("another.query", "0.1.0"), "third"),
        ];
        if reverse {
            packages.reverse();
        }
        let mut catalog = PackageCatalog::new();
        let mut identities = vec![];
        for image in packages {
            let identity = register(&mut catalog, image);
            catalog.set_enabled(&identity, true).unwrap();
            identities.push(identity);
        }
        assert_eq!(
            catalog
                .resolve(
                    &contract("example.query"),
                    None,
                    sdk::ProviderSelection::Single,
                    &[]
                )
                .unwrap_err(),
            CatalogError::AmbiguousProvider
        );
        for identity in &identities {
            let resolved = catalog
                .resolve(
                    &contract("example.query"),
                    None,
                    sdk::ProviderSelection::Single,
                    &[choice(identity)],
                )
                .unwrap();
            assert_eq!(resolved.len(), 1);
            assert_eq!(&resolved[0].binding().provider.plugin, identity);
            assert_eq!(resolved[0].package().origin(), &origin());
        }
        let collected = catalog
            .resolve(
                &contract("example.query"),
                None,
                sdk::ProviderSelection::CollectIndependent,
                &[],
            )
            .unwrap();
        identities.sort();
        assert_eq!(
            collected
                .into_iter()
                .map(|provider| provider.binding().provider.plugin.clone())
                .collect::<Vec<_>>(),
            identities
        );
    }
}

#[test]
fn fixed_lookup_preserves_old_bytes_and_rejects_changed_owner_contribution_and_digest() {
    let mut catalog = PackageCatalog::new();
    let old = register(
        &mut catalog,
        image(manifest("example.query", "0.1.0"), "old"),
    );
    catalog.set_enabled(&old, true).unwrap();
    let captured = catalog
        .resolve(
            &contract("example.query"),
            None,
            sdk::ProviderSelection::Single,
            &[],
        )
        .unwrap()
        .remove(0);
    let fixed = captured.binding().provider.clone();
    let next = register(
        &mut catalog,
        image(manifest("example.query", "0.2.0"), "new"),
    );
    catalog.set_enabled(&next, true).unwrap();
    assert_eq!(
        catalog.lookup(&fixed).unwrap().binding(),
        captured.binding()
    );
    let mut changed = fixed.clone();
    changed.package_digest = "a".repeat(64);
    assert_eq!(
        catalog.lookup(&changed).unwrap_err(),
        CatalogError::DigestMismatch
    );
    changed = fixed.clone();
    changed.component_id = "another-owner".into();
    assert_eq!(
        catalog.lookup(&changed).unwrap_err(),
        CatalogError::BindingMismatch
    );
    changed = fixed.clone();
    changed.contribution_id = "missing".into();
    assert_eq!(
        catalog.lookup(&changed).unwrap_err(),
        CatalogError::MissingContribution
    );
    changed = fixed.clone();
    changed.contribution_id = "resource".into();
    assert_eq!(
        catalog.lookup(&changed).unwrap_err(),
        CatalogError::Contract(sdk::ContractErrorCode::IncompatibleContract)
    );
    changed = fixed.clone();
    changed.plugin.version = "0.3.0".into();
    assert_eq!(
        catalog.lookup(&changed).unwrap_err(),
        CatalogError::MissingPackage
    );
    catalog.set_enabled(&old, false).unwrap();
    assert_eq!(
        catalog.lookup(&fixed).unwrap_err(),
        CatalogError::DisabledPackage
    );
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                None,
                sdk::ProviderSelection::Single,
                &[choice(&old)]
            )
            .unwrap_err(),
        CatalogError::DisabledPackage
    );
    let active = catalog
        .resolve(
            &contract("example.query"),
            None,
            sdk::ProviderSelection::Single,
            &[],
        )
        .unwrap();
    assert_eq!(active[0].binding().provider.plugin, next);
    assert_eq!(
        captured.package().image().package_digest(),
        fixed.package_digest
    );
    assert_eq!(
        captured.package().bind_capability("query").unwrap(),
        *captured.binding()
    );
    assert_eq!(captured.package().origin(), &origin());
}

#[test]
fn profiles_duplicate_choices_and_missing_declarations_follow_sdk_rules() {
    let mut declaration = manifest("example.query", "0.1.0");
    let profile = contract("example.profile");
    let sdk::ContributionKind::Capability {
        declaration: capability,
    } = &mut declaration.contributions[0].contribution
    else {
        panic!("fixture capability")
    };
    capability.profiles.push(profile.clone());
    let mut catalog = PackageCatalog::new();
    let identity = register(&mut catalog, image(declaration, "first"));
    catalog.set_enabled(&identity, true).unwrap();
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                None,
                sdk::ProviderSelection::Single,
                &[]
            )
            .unwrap_err(),
        CatalogError::NoCompatibleProvider
    );
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                Some(&contract("another.profile")),
                sdk::ProviderSelection::Single,
                &[]
            )
            .unwrap_err(),
        CatalogError::NoCompatibleProvider
    );
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                Some(&profile),
                sdk::ProviderSelection::Single,
                &[]
            )
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                Some(&profile),
                sdk::ProviderSelection::Single,
                &[choice(&identity), choice(&identity)]
            )
            .unwrap_err(),
        CatalogError::DuplicateSelection
    );
    assert_eq!(
        catalog
            .resolve(
                &contract("another.contract"),
                Some(&profile),
                sdk::ProviderSelection::Single,
                &[]
            )
            .unwrap_err(),
        CatalogError::NoCompatibleProvider
    );
    let mut missing = choice(&identity);
    missing.plugin.id = "missing.plugin".into();
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                Some(&profile),
                sdk::ProviderSelection::Single,
                &[missing]
            )
            .unwrap_err(),
        CatalogError::MissingPackage
    );
    let mut missing = choice(&identity);
    missing.contribution_id = "missing".into();
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                Some(&profile),
                sdk::ProviderSelection::Single,
                &[missing]
            )
            .unwrap_err(),
        CatalogError::MissingContribution
    );
}

#[test]
fn catalog_and_origin_ids_are_bounded_without_partial_registration() {
    let sample = image(manifest("example.query", "0.1.0"), "first");
    let mut catalog = PackageCatalog::new();
    for (value, field) in [
        ("".into(), OriginField::SourceId),
        ("bad\nsource".into(), OriginField::SourceId),
        ("registry/path".into(), OriginField::SourceId),
        ("publisher@registry".into(), OriginField::PublisherId),
        ("registry?query=value".into(), OriginField::SourceId),
        ("publisher=key".into(), OriginField::PublisherId),
        ("x".repeat(129), OriginField::PublisherId),
    ] {
        let mut expected = approval(&sample);
        match field {
            OriginField::SourceId => expected.origin.source_id = value,
            OriginField::PublisherId => expected.origin.publisher_id = value,
        }
        assert_eq!(
            catalog.register(sample.clone(), expected).unwrap_err(),
            CatalogError::InvalidOrigin(field)
        );
        assert!(catalog.is_empty());
    }
    for index in 0..MAX_CATALOG_PACKAGES {
        register(
            &mut catalog,
            image(
                manifest(&format!("example.capacity-{index}"), "0.1.0"),
                "bounded",
            ),
        );
    }
    assert_eq!(catalog.len(), MAX_CATALOG_PACKAGES);
    assert_eq!(
        catalog
            .register(sample.clone(), approval(&sample))
            .unwrap_err(),
        CatalogError::LimitExceeded
    );
    assert_eq!(catalog.len(), MAX_CATALOG_PACKAGES);
    let missing = sample.manifest().manifest().plugin.clone();
    assert_eq!(
        catalog.set_enabled(&missing, true).unwrap_err(),
        CatalogError::MissingPackage
    );
    let chosen = vec![choice(&missing); MAX_CATALOG_PACKAGES + 1];
    assert_eq!(
        catalog
            .resolve(
                &contract("example.query"),
                None,
                sdk::ProviderSelection::Single,
                &chosen
            )
            .unwrap_err(),
        CatalogError::LimitExceeded
    );
}
