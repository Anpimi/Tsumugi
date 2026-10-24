use tsumugi_plugin_sdk::*;

fn contract(id: &str) -> ContractRef {
    ContractRef {
        id: id.into(),
        schema_version: 1,
        behavior_version: 1,
    }
}
fn dependency(id: &str, required: bool, selection: ProviderSelection) -> CapabilityDependency {
    CapabilityDependency {
        contract: contract(id),
        required,
        selection,
    }
}
fn required(id: &str) -> CapabilityDependency {
    dependency(id, true, ProviderSelection::Single)
}
fn component(
    id: &str,
    offered: &str,
    dependencies: Vec<CapabilityDependency>,
) -> (ComponentDeclaration, ContributionDeclaration) {
    (
        ComponentDeclaration {
            id: id.into(),
            scope: ComponentScope::Project,
            runtime: RuntimeKind::JavaScript,
            entrypoint: Some("worker.mjs".into()),
            dependencies,
            exit: ExitRequirements {
                stop_timeout_ms: 100,
                cleanup_timeout_ms: 100,
            },
        },
        ContributionDeclaration {
            id: format!("{id}-call"),
            component_id: id.into(),
            contribution: ContributionKind::Capability {
                declaration: CapabilityDeclaration {
                    contract: contract(offered),
                    input_schema: contract("example.input"),
                    output_schema: contract("example.output"),
                    error_schema: contract("example.error"),
                    profiles: vec![],
                    effect: EffectKind::ReadOnly,
                    permissions: vec![],
                    limits: CapabilityLimits {
                        timeout_ms: 1000,
                        max_input_bytes: 1024,
                        max_output_bytes: 1024,
                        concurrency: 1,
                    },
                },
            },
        },
    )
}
fn manifest(
    id: &str,
    components: Vec<(ComponentDeclaration, ContributionDeclaration)>,
) -> ValidatedManifest {
    let (components, contributions) = components.into_iter().unzip();
    PluginManifest {
        protocol_version: MANIFEST_PROTOCOL,
        plugin: PluginIdentity {
            publisher: "example".into(),
            id: id.into(),
            version: "1.0.0".into(),
        },
        permissions: vec![],
        components,
        contributions,
    }
    .validate()
    .unwrap()
}
fn key(manifest: &ValidatedManifest, id: &str) -> ComponentKey {
    ComponentKey {
        plugin: manifest.manifest().plugin.clone(),
        component_id: id.into(),
    }
}
fn provider(manifest: &ValidatedManifest, id: &str) -> ProviderKey {
    ProviderKey {
        plugin: manifest.manifest().plugin.clone(),
        contribution_id: format!("{id}-call"),
    }
}
fn request(manifest: &ValidatedManifest, id: &str) -> DependencyClosureRequest {
    DependencyClosureRequest {
        roots: vec![key(manifest, id)],
        selections: vec![],
    }
}
fn diagnose(
    manifests: &[ValidatedManifest],
    request: &DependencyClosureRequest,
) -> Result<DependencyClosureReport, ContractError> {
    let entries = manifests
        .iter()
        .map(|manifest| DeclarationEntry {
            manifest,
            enabled: true,
        })
        .collect::<Vec<_>>();
    diagnose_dependency_closure(&entries, request)
}
fn error(
    result: Result<DependencyClosureReport, ContractError>,
    code: ContractErrorCode,
    field: &str,
) {
    assert_eq!(
        result.unwrap_err(),
        ContractError {
            code,
            field: field.into()
        }
    );
}

#[test]
fn data_roots_and_missing_declarations_do_not_claim_runtime_readiness() {
    let (mut owner, mut contribution) = component(
        "resources",
        "example.unused",
        vec![
            required("tsumugi.generation"),
            dependency(
                "example.optional",
                false,
                ProviderSelection::CollectIndependent,
            ),
        ],
    );
    owner.runtime = RuntimeKind::Data;
    owner.scope = ComponentScope::Application;
    owner.entrypoint = None;
    owner.dependencies[0].contract = generation_service_contract();
    contribution.contribution = ContributionKind::Skill {
        path: "guide.md".into(),
    };
    let catalog = manifest("data", vec![(owner, contribution)]);
    let query = request(&catalog, "resources");
    let report = diagnose_dependency_closure(
        &[DeclarationEntry {
            manifest: &catalog,
            enabled: false,
        }],
        &query,
    )
    .unwrap();
    assert_eq!(report.scope, DependencyClosureScope::DeclarationCatalogOnly);
    assert_eq!(report.nodes.len(), 1);
    assert_eq!(report.nodes[0].runtime, RuntimeKind::Data);
    assert!(!report.nodes[0].enabled);
    assert_eq!(
        report.edges[0].resolution,
        DependencyResolution::OptionalDeclarationAbsent
    );
    assert!(!report.edges[0].required);
    assert_eq!(
        report.edges[1].resolution,
        DependencyResolution::RequiredDeclarationMissing
    );
    assert!(report.edges[1].required);
    assert!(report.cycles.is_empty());
}

#[test]
fn exact_profiles_and_provider_choices_belong_to_each_dependency_owner() {
    let caller = manifest(
        "caller",
        vec![
            component("one", "example.one", vec![required("example.query")]),
            component("two", "example.two", vec![required("example.query")]),
        ],
    );
    let mut first = component("worker", "example.query", vec![]);
    let mut second = first.clone();
    for (item, profile) in [
        (&mut first, "example.profile-one"),
        (&mut second, "example.profile-two"),
    ] {
        let ContributionKind::Capability { declaration } = &mut item.1.contribution else {
            unreachable!()
        };
        declaration.profiles = vec![contract(profile)];
    }
    let a = manifest("provider-a", vec![first]);
    let b = manifest("provider-b", vec![second]);
    let mut query = request(&caller, "one");
    query.roots.push(key(&caller, "two"));
    for (owner, profile, selected) in [
        ("one", "example.profile-one", provider(&a, "worker")),
        ("two", "example.profile-two", provider(&b, "worker")),
    ] {
        query.selections.push(DependencyChoice {
            owner: key(&caller, owner),
            contract: contract("example.query"),
            profile: Some(contract(profile)),
            chosen: vec![selected],
        });
    }
    let report = diagnose(&[caller.clone(), a.clone(), b.clone()], &query).unwrap();
    assert_eq!(report.nodes.len(), 4);
    assert_eq!(
        report.edges[0].resolution,
        DependencyResolution::Resolved {
            providers: vec![provider(&a, "worker")]
        }
    );
    assert_eq!(
        report.edges[1].resolution,
        DependencyResolution::Resolved {
            providers: vec![provider(&b, "worker")]
        }
    );
    query.selections[0].profile = Some(contract("example.profile-two"));
    let wrong = diagnose(&[caller.clone(), a.clone(), b.clone()], &query).unwrap();
    assert_eq!(
        wrong.edges[0].resolution,
        DependencyResolution::IncompatibleSelection
    );
    query.selections.remove(0);
    let absent_profile = diagnose(&[caller, a, b], &query).unwrap();
    assert_eq!(
        absent_profile.edges[0].resolution,
        DependencyResolution::RequiredDeclarationMissing
    );
}

#[test]
fn ambiguity_collection_and_disabled_candidates_follow_the_original_resolver() {
    let caller = manifest(
        "caller",
        vec![
            component("single", "example.single", vec![required("example.query")]),
            component(
                "collection",
                "example.collection",
                vec![dependency(
                    "example.query",
                    false,
                    ProviderSelection::CollectIndependent,
                )],
            ),
        ],
    );
    let a = manifest(
        "provider-a",
        vec![component("worker", "example.query", vec![])],
    );
    let b = manifest(
        "provider-b",
        vec![component("worker", "example.query", vec![])],
    );
    let mut query = request(&caller, "single");
    query.roots.push(key(&caller, "collection"));
    let report = diagnose(&[caller.clone(), b.clone(), a.clone()], &query).unwrap();
    let expected = resolve_declarations(
        &[a.clone(), b.clone()],
        &contract("example.query"),
        None,
        ProviderSelection::CollectIndependent,
        &[],
    )
    .unwrap()
    .into_iter()
    .map(|item| item.key)
    .collect::<Vec<_>>();
    assert_eq!(
        report.edges[0].resolution,
        DependencyResolution::Resolved {
            providers: expected.clone()
        }
    );
    assert_eq!(
        report.edges[1].resolution,
        DependencyResolution::AmbiguousProviders {
            providers: expected
        }
    );
    let entries = [
        DeclarationEntry {
            manifest: &caller,
            enabled: true,
        },
        DeclarationEntry {
            manifest: &a,
            enabled: true,
        },
        DeclarationEntry {
            manifest: &b,
            enabled: false,
        },
    ];
    let enabled = diagnose_dependency_closure(&entries, &query).unwrap();
    assert!(enabled.edges.iter().all(|edge| edge.resolution
        == DependencyResolution::Resolved {
            providers: vec![provider(&a, "worker")]
        }));
    query.selections.push(DependencyChoice {
        owner: key(&caller, "single"),
        contract: contract("example.query"),
        profile: None,
        chosen: vec![provider(&b, "worker")],
    });
    let disabled = diagnose_dependency_closure(&entries, &query).unwrap();
    assert_eq!(
        disabled.edges[1].resolution,
        DependencyResolution::DisabledProviders {
            providers: vec![provider(&b, "worker")]
        }
    );
    assert!(
        !disabled
            .nodes
            .iter()
            .any(|node| node.key.plugin == b.manifest().plugin)
    );
    let all_disabled = [
        entries[0],
        DeclarationEntry {
            manifest: &a,
            enabled: false,
        },
        entries[2],
    ];
    query.selections.clear();
    let disabled = diagnose_dependency_closure(&all_disabled, &query).unwrap();
    assert!(disabled.edges.iter().all(|edge| edge.resolution
        == DependencyResolution::DisabledProviders {
            providers: vec![provider(&a, "worker"), provider(&b, "worker")],
        }));
}

#[test]
fn diamond_closure_and_directed_cycle_witnesses_are_canonical() {
    let components = vec![
        component(
            "root",
            "example.root",
            vec![required("example.b"), required("example.a")],
        ),
        component("a", "example.a", vec![required("example.shared")]),
        component("b", "example.b", vec![required("example.shared")]),
        component("shared", "example.shared", vec![]),
    ];
    let plain = manifest("graph", components.clone());
    let query = request(&plain, "root");
    let report = diagnose(&[plain.clone()], &query).unwrap();
    assert_eq!(report.nodes.len(), 4);
    assert_eq!(report.edges.len(), 4);
    assert!(report.cycles.is_empty());
    let mut cyclic = components;
    cyclic[3].0.dependencies.push(required("example.root"));
    let forward = manifest("graph", cyclic.clone());
    cyclic.reverse();
    for (component, _) in &mut cyclic {
        component.dependencies.reverse();
    }
    let reversed = manifest("graph", cyclic);
    let report = diagnose(&[forward.clone()], &query).unwrap();
    assert_eq!(report, diagnose(&[reversed], &query).unwrap());
    assert_eq!(
        report.cycles,
        vec![vec![
            key(&forward, "a"),
            key(&forward, "shared"),
            key(&forward, "root"),
            key(&forward, "a")
        ]]
    );
    let self_cycle = manifest(
        "self",
        vec![component(
            "root",
            "example.root",
            vec![required("example.root")],
        )],
    );
    let report = diagnose(&[self_cycle.clone()], &request(&self_cycle, "root")).unwrap();
    assert_eq!(
        report.cycles,
        vec![vec![key(&self_cycle, "root"), key(&self_cycle, "root")]]
    );
}

#[test]
fn duplicate_invalid_and_unused_requests_do_not_return_partial_graphs() {
    let owner = manifest(
        "owner",
        vec![component(
            "root",
            "example.root",
            vec![required("example.query")],
        )],
    );
    let mut query = request(&owner, "root");
    query.roots.push(query.roots[0].clone());
    error(
        diagnose(&[owner.clone()], &query),
        ContractErrorCode::DuplicateIdentity,
        "dependencyClosure.roots",
    );
    query.roots.pop();
    let choice = DependencyChoice {
        owner: key(&owner, "root"),
        contract: contract("example.query"),
        profile: None,
        chosen: vec![],
    };
    query.selections = vec![choice.clone(), choice.clone()];
    error(
        diagnose(&[owner.clone()], &query),
        ContractErrorCode::DuplicateIdentity,
        "dependencyClosure.selections",
    );
    query.selections = vec![DependencyChoice {
        chosen: vec![provider(&owner, "root"), provider(&owner, "root")],
        ..choice.clone()
    }];
    error(
        diagnose(&[owner.clone()], &query),
        ContractErrorCode::DuplicateIdentity,
        "dependencyClosure.chosen",
    );
    query.selections = vec![DependencyChoice {
        contract: contract("example.other"),
        ..choice.clone()
    }];
    error(
        diagnose(&[owner.clone()], &query),
        ContractErrorCode::InvalidDeclaration,
        "dependencyClosure.selections.unused",
    );
    query.selections = vec![DependencyChoice {
        contract: ContractRef {
            behavior_version: 2,
            ..choice.contract.clone()
        },
        ..choice
    }];
    error(
        diagnose(&[owner.clone()], &query),
        ContractErrorCode::InvalidDeclaration,
        "dependencyClosure.selections.unused",
    );
    query.selections.clear();
    error(
        diagnose(&[owner.clone(), owner.clone()], &query),
        ContractErrorCode::DuplicateIdentity,
        "dependencyClosure.manifests.plugin",
    );
    query.roots[0].component_id = "missing".into();
    error(
        diagnose(&[owner], &query),
        ContractErrorCode::MissingOwner,
        "dependencyClosure.component",
    );
}

#[test]
fn request_entrypoints_reject_unknown_duplicate_and_oversize_input() {
    let owner = manifest("owner", vec![component("root", "example.root", vec![])]);
    let query = request(&owner, "root");
    let encoded = serde_json::to_vec(&query).unwrap();
    assert_eq!(parse_dependency_closure_request(&encoded).unwrap(), query);
    let mut unknown = serde_json::to_value(&query).unwrap();
    unknown["unexpected"] = true.into();
    assert_eq!(
        parse_dependency_closure_request(&serde_json::to_vec(&unknown).unwrap())
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );
    let duplicate =
        String::from_utf8(encoded)
            .unwrap()
            .replacen("\"roots\":", "\"roots\":[],\"roots\":", 1);
    assert_eq!(
        parse_dependency_closure_request(duplicate.as_bytes())
            .unwrap_err()
            .code,
        ContractErrorCode::InvalidSchema
    );
    assert_eq!(
        parse_dependency_closure_request(&vec![b' '; MAX_DEPENDENCY_REQUEST_BYTES + 1])
            .unwrap_err()
            .code,
        ContractErrorCode::LimitExceeded
    );
    let mut oversized = query.clone();
    oversized.roots[0].component_id = "r".repeat(MAX_DEPENDENCY_REQUEST_BYTES);
    assert_eq!(
        oversized.validate().unwrap_err().code,
        ContractErrorCode::LimitExceeded
    );
    let mut roots = query.clone();
    roots.roots = (0..=MAX_DEPENDENCY_ROOTS)
        .map(|i| key(&owner, &format!("root-{i}")))
        .collect();
    assert_eq!(
        roots.validate().unwrap_err().field,
        "dependencyClosure.roots"
    );
    let mut choices = query;
    choices.selections = (0..=MAX_DEPENDENCY_CHOICES)
        .map(|i| DependencyChoice {
            owner: key(&owner, "root"),
            contract: contract(&format!("example.dep-{i}")),
            profile: None,
            chosen: vec![],
        })
        .collect();
    assert_eq!(
        choices.validate().unwrap_err().field,
        "dependencyClosure.selections"
    );
    let entries = vec![
        DeclarationEntry {
            manifest: &owner,
            enabled: true
        };
        MAX_DEPENDENCY_MANIFESTS + 1
    ];
    error(
        diagnose_dependency_closure(&entries, &request(&owner, "root")),
        ContractErrorCode::LimitExceeded,
        "dependencyClosure.manifests",
    );
}

fn chain(length: usize) -> ValidatedManifest {
    manifest(
        "chain",
        (0..length)
            .map(|i| {
                component(
                    &format!("node-{i}"),
                    &format!("example.node-{i}"),
                    if i + 1 == length {
                        vec![]
                    } else {
                        vec![required(&format!("example.node-{}", i + 1))]
                    },
                )
            })
            .collect(),
    )
}
#[test]
fn depth_nodes_and_edges_are_bounded_without_truncation() {
    let exact = chain(MAX_DEPENDENCY_DEPTH);
    assert_eq!(
        diagnose(&[exact.clone()], &request(&exact, "node-0"))
            .unwrap()
            .nodes
            .len(),
        MAX_DEPENDENCY_DEPTH
    );
    let deep = chain(MAX_DEPENDENCY_DEPTH + 1);
    error(
        diagnose(&[deep.clone()], &request(&deep, "node-0")),
        ContractErrorCode::LimitExceeded,
        "dependencyClosure.depth",
    );
    let caller = manifest(
        "caller",
        vec![component(
            "root",
            "example.root",
            vec![dependency(
                "example.query",
                true,
                ProviderSelection::CollectIndependent,
            )],
        )],
    );
    for count in [MAX_DEPENDENCY_NODES - 1, MAX_DEPENDENCY_NODES] {
        let providers = manifest(
            "providers",
            (0..count)
                .map(|i| component(&format!("worker-{i}"), "example.query", vec![]))
                .collect(),
        );
        let result = diagnose(&[caller.clone(), providers], &request(&caller, "root"));
        if count + 1 == MAX_DEPENDENCY_NODES {
            assert_eq!(result.unwrap().nodes.len(), MAX_DEPENDENCY_NODES);
        } else {
            error(
                result,
                ContractErrorCode::LimitExceeded,
                "dependencyClosure.nodes",
            );
        }
    }
    for count in [4, 5] {
        let graph = manifest(
            "edges",
            (0..count)
                .map(|i| {
                    component(
                        &format!("root-{i}"),
                        &format!("example.root-{i}"),
                        (0..128)
                            .map(|j| required(&format!("example.absent-{j}")))
                            .collect(),
                    )
                })
                .collect(),
        );
        let query = DependencyClosureRequest {
            roots: (0..count)
                .map(|i| key(&graph, &format!("root-{i}")))
                .collect(),
            selections: vec![],
        };
        let result = diagnose(&[graph], &query);
        if count == 4 {
            assert_eq!(result.unwrap().edges.len(), MAX_DEPENDENCY_EDGES);
        } else {
            error(
                result,
                ContractErrorCode::LimitExceeded,
                "dependencyClosure.edges",
            );
        }
    }
}

#[test]
fn provider_reference_budget_counts_final_edges_not_resolver_passes() {
    let base = manifest(
        "providers",
        vec![component("worker", "example.query", vec![])],
    );
    let mut many = base.manifest().clone();
    for i in 1..128 {
        let mut contribution = many.contributions[0].clone();
        contribution.id = format!("query-{i}");
        many.contributions.push(contribution);
    }
    let providers = many.validate().unwrap();
    for count in [8, 9] {
        let caller = manifest(
            "caller",
            (0..count)
                .map(|i| {
                    component(
                        &format!("root-{i}"),
                        &format!("example.root-{i}"),
                        vec![dependency(
                            "example.query",
                            true,
                            ProviderSelection::CollectIndependent,
                        )],
                    )
                })
                .collect(),
        );
        let query = DependencyClosureRequest {
            roots: (0..count)
                .map(|i| key(&caller, &format!("root-{i}")))
                .collect(),
            selections: vec![],
        };
        for enabled in [true, false] {
            let result = diagnose_dependency_closure(
                &[
                    DeclarationEntry {
                        manifest: &caller,
                        enabled: true,
                    },
                    DeclarationEntry {
                        manifest: &providers,
                        enabled,
                    },
                ],
                &query,
            );
            if count == 8 {
                let report = result.unwrap();
                assert_eq!(
                    report
                        .edges
                        .iter()
                        .map(|edge| edge.resolution.referenced_providers().len())
                        .sum::<usize>(),
                    MAX_DEPENDENCY_PROVIDER_REFS
                );
                assert_eq!(report.nodes.len(), count + usize::from(enabled));
            } else {
                error(
                    result,
                    ContractErrorCode::LimitExceeded,
                    "dependencyClosure.providers",
                );
            }
        }
    }
}

#[test]
fn large_cycle_reports_fail_the_byte_budget_instead_of_hiding_witnesses() {
    let mut graph = manifest(
        "graph",
        (0..32)
            .map(|i| {
                let mut dependencies = (0..i)
                    .map(|j| required(&format!("example.node-{j}")))
                    .collect::<Vec<_>>();
                if i < 31 {
                    dependencies.push(required(&format!("example.node-{}", i + 1)));
                }
                if i == 31 {
                    dependencies.drain(0..16);
                }
                component(
                    &format!("node-{i}"),
                    &format!("example.node-{i}"),
                    dependencies,
                )
            })
            .collect(),
    )
    .manifest()
    .clone();
    graph.plugin.publisher = "p".repeat(128);
    graph.plugin.id = "g".repeat(128);
    let graph = graph.validate().unwrap();
    error(
        diagnose(&[graph.clone()], &request(&graph, "node-0")),
        ContractErrorCode::LimitExceeded,
        "dependencyClosure.report",
    );
}
