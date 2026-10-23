# Experimental Mac prerelease

`0.2.0-alpha.1` is an experimental, unsigned Apple silicon Mac application for
macOS 13.5 or later. The archive includes the fixed Node 26.10.0 component Host,
Pi member runtime, and independent WebVTT and SMAPI `0.1.0-alpha.1` packages.
The application catalog fixes their source, SDK and complete package identities.
Plugin approval, installation, enablement and each execution decision remain
separate actions. Installing this application does not replace an existing
project binding or grant execution permission.

The application is named **Tsumugi Experimental** and uses the separate
`com.tsumugi.experimental` application-data identity. It does not automatically
open another build's profile. To build this flavor after preparing the fixed
resources, layer the experimental identity over the runtime profile:

```sh
CARGO_NET_OFFLINE=true pnpm --dir apps/desktop tauri build --config src-tauri/tauri.runtime.conf.json --config src-tauri/tauri.experimental.conf.json --no-sign -- --locked --offline
```

Use synthetic or disposable projects first. Only the current project schema 61
is supported. Earlier development directories are refused without application
migration or reset; preserve them and reimport original source into a new
project. See [supported integrations](integrations.md) and the
[changelog](../CHANGELOG.md) for format and workflow limits.

This prerelease is not code-signed with an Apple developer identity or notarized.
Its downloadable manifest and checksums identify the supplied bytes; they do not
establish Apple approval, authenticated plugin updates or a production TUF
repository. No automatic updater is included. Do not change system security or
Keychain permissions as part of testing this release.

Remaining acceptance limits include real-provider translation quality, measured
usage and cost, independent human evaluation, and clean-system offline first use.
Large projects, Windows execution, Intel Macs and other untested platforms are
outside this artifact's supported scope. Detailed screen-reader, IME, exact
text-size/viewport, controlled system-appearance and physical IPC/saturated-exit
cases have not all been verified. Shipping this experimental snapshot does not
assert completion of those checks or of the complete refactor.

The experimental ChatGPT account connection is not included in this snapshot.
The existing API-key connection workflow remains available; any real provider
request requires the application's own scope, data-sharing and budget consent.
No model request runs on installation or startup.
