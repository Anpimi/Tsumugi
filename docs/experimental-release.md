# Experimental Mac prerelease

`0.2.0-alpha.1` is an experimental, unsigned prerelease for Apple silicon Macs running macOS 13.5 or later.

## Bundled components and profile isolation

The archive bundles the fixed Node `26.10.0` component Host, the Pi member runtime, and the standalone WebVTT and Stardew SMAPI `0.1.0-alpha.1` packages. Their source, SDK, and package identities are pinned in the application catalog. Installing the application does not alter existing project bindings or grant plugin execution permissions—approving, installing, enabling, and running a plugin remain separate actions inside the app.

The app is named **Tsumugi Experimental** and uses the dedicated `com.tsumugi.experimental` application-data identifier so it stays isolated from other builds' profiles. After preparing the bundled runtime resources, you can build this flavor locally by layering the experimental config over the runtime config:

```sh
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json --config src-tauri/tauri.experimental.conf.json --no-sign -- --locked --offline
```

## Project compatibility and model connections

- **Database schema**: Test with synthetic or disposable projects first. This build supports only project database schema `61`. Projects created with earlier development schemas are refused without automatic migration or reset; keep those directories intact and reimport your original source files into a new project. See [supported integrations](integrations.md) and the [changelog](../CHANGELOG.md) for format details and workflow limits.
- **Model connections**: This snapshot includes the API-key connection workflow (the experimental ChatGPT account sign-in flow is omitted). No model requests are made during installation or startup, and every provider dispatch requires explicit scope, data-sharing, and budget consent.

## Signing and current limitations

- **Unsigned distribution**: This prerelease is neither code-signed with an Apple Developer identity nor notarized. The accompanying manifest and checksums verify archive integrity only; they do not provide Apple notarization, authenticated plugin updates, an automatic updater, or a production TUF repository. Do not weaken system security settings or modify Keychain permissions when testing this build.
- **Scope and verification boundaries**: This snapshot targets Apple silicon macOS only; Intel Macs, Windows, and large-scale production projects are out of scope. In addition, end-to-end provider translation quality, live token/cost accounting, independent human evaluation, clean-machine offline first launch, and comprehensive accessibility/platform edge cases (screen readers, IME composition, viewport/text-scaling extremes, forced system appearance transitions, and physical IPC saturation on exit) have not yet been fully verified.
