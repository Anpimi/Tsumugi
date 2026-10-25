#!/usr/bin/env python3
"""Run two public, prebuilt-package conformance consumers with normal Core."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import tomllib


CASES = (
    (
        "webvtt",
        "webvtt",
        "source_adoption",
        "official_source_checks_gate_atomic_adoption_revision_updates_and_reopening",
    ),
    (
        "stardew-smapi",
        "smapi",
        "translation_validation",
        "complete_translation_requires_current_scope_independent_grants_and_saved_check_proof",
    ),
)
FEATURES = "core-adapter,javascript-conformance"
CONSUMER_MANIFEST = "crates/plugin-host/compatibility/Cargo.toml"
COMMAND_TIMEOUT_SECONDS = 1800


class HarnessError(Exception):
    pass


def absolute(value: str | Path) -> Path:
    # Preserve selected symlink ancestors for the Rust capture owner to reject.
    path = Path(value)
    return path if path.is_absolute() else Path.cwd() / path


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    value = {}
    for key, item in pairs:
        if key in value:
            raise HarnessError(f"duplicate JSON field: {key}")
        value[key] = item
    return value


def read_json(path: Path, maximum: int = 1024 * 1024) -> dict:
    if path.stat().st_size > maximum:
        raise HarnessError(f"JSON document exceeds {maximum} bytes: {path.name}")
    value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise HarnessError(f"expected a JSON object: {path.name}")
    return value


def stop_owned_process(process: subprocess.Popen) -> None:
    # Each command starts its own session. Never signal a shared cache owner or
    # a process selected by executable name or port.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


class Commands:
    def __init__(self, checkout: Path, output: Path):
        self.checkout = checkout
        self.output = output
        self.records: list[dict] = []

    def run(self, label: str, argv: list[str], env: dict | None = None) -> dict:
        stdout = self.output / f"{label}.stdout.log"
        stderr = self.output / f"{label}.stderr.log"
        record = {
            "label": label,
            "argv": argv,
            "cwd": str(self.checkout),
            "stdout": stdout.name,
            "stderr": stderr.name,
            "exitCode": None,
            "timedOut": False,
        }
        self.records.append(record)
        started = time.monotonic()
        environment = os.environ.copy()
        environment["CARGO_TERM_COLOR"] = "never"
        if env:
            environment.update(env)
        with stdout.open("wb") as out, stderr.open("wb") as err:
            try:
                process = subprocess.Popen(
                    argv, cwd=self.checkout, env=environment,
                    stdout=out, stderr=err, start_new_session=True,
                )
                try:
                    record["exitCode"] = process.wait(timeout=COMMAND_TIMEOUT_SECONDS)
                except subprocess.TimeoutExpired:
                    record["timedOut"] = True
                    stop_owned_process(process)
                    record["exitCode"] = process.returncode
                except BaseException:
                    stop_owned_process(process)
                    record["exitCode"] = process.returncode
                    record["interrupted"] = True
                    record["durationSeconds"] = round(time.monotonic() - started, 3)
                    raise
            except OSError as error:
                record["error"] = str(error)
        record["durationSeconds"] = round(time.monotonic() - started, 3)
        return record

    def text(self, record: dict) -> str:
        return (self.output / record["stdout"]).read_text(encoding="utf-8", errors="replace")

    def checked(self, label: str, argv: list[str]) -> str:
        record = self.run(label, argv)
        require_success(record)
        return self.text(record).strip()


def require_success(record: dict) -> None:
    if record["exitCode"] != 0 or record["timedOut"]:
        raise HarnessError(f"command failed: {record['label']} (see its stdout/stderr logs)")


def cargo_prefix(offline: bool) -> list[str]:
    return ["cargo", "--offline"] if offline else ["cargo"]


def inspection_command(binary: str, arguments: list[str], offline: bool) -> list[str]:
    return cargo_prefix(offline) + [
        "run", "--locked", "--quiet", "-p", "tsumugi-plugin-host", "--bin", binary,
        "--", "inspect", *arguments,
    ]


def test_command(target: str, name: str, offline: bool) -> list[str]:
    return cargo_prefix(offline) + [
        "test", "--locked", "--manifest-path", CONSUMER_MANIFEST, "--features", FEATURES,
        "--test", target, name, "--", "--exact", "--nocapture", "--test-threads=1",
    ]


def metadata_command(offline: bool) -> list[str]:
    return cargo_prefix(offline) + [
        "metadata", "--locked", "--manifest-path", CONSUMER_MANIFEST,
        "--features", FEATURES, "--format-version", "1",
    ]


def verify_consumer_graph(metadata: dict, checkout: Path) -> dict:
    """Require the same isolated dependency selection used by both test commands."""
    expected = {
        "tsumugi-plugin-host-compatibility": (CONSUMER_MANIFEST, sorted(FEATURES.split(","))),
        "tsumugi-core": ("crates/core/Cargo.toml", []),
        "tsumugi-plugin-host": ("crates/plugin-host/Cargo.toml", ["core-adapter"]),
        "tsumugi-plugin-sdk": ("crates/plugin-sdk/Cargo.toml", None),
    }
    workspace = (checkout / CONSUMER_MANIFEST).parent.resolve()
    workspace_root = metadata.get("workspace_root")
    packages = metadata.get("packages")
    resolve = metadata.get("resolve")
    if (type(metadata.get("version")) is not int or metadata["version"] != 1
            or not isinstance(workspace_root, str) or not Path(workspace_root).is_absolute()
            or Path(workspace_root).resolve() != workspace
            or not isinstance(packages, list) or not packages or not isinstance(resolve, dict)):
        raise HarnessError("invalid isolated consumer metadata or workspace")
    by_id = {}
    selected = {}
    for package in packages:
        if (not isinstance(package, dict) or not isinstance(package.get("id"), str)
                or not package["id"] or package["id"] in by_id
                or not isinstance(package.get("name"), str) or not package["name"]):
            raise HarnessError("invalid consumer package metadata")
        by_id[package["id"]] = package
        name = package["name"]
        if name in expected:
            manifest = package.get("manifest_path")
            if (name in selected or not isinstance(manifest, str)
                    or not Path(manifest).is_absolute()
                    or Path(manifest).resolve() != (checkout / expected[name][0]).resolve()
                    or "source" not in package or package["source"] is not None):
                raise HarnessError(f"consumer must use the selected checkout's {name} owner")
            selected[name] = package
    if set(selected) != set(expected):
        raise HarnessError("consumer metadata is missing an exact Core, Host, SDK or harness owner")
    root = selected["tsumugi-plugin-host-compatibility"]["id"]
    if resolve.get("root") != root or metadata.get("workspace_members") != [root]:
        raise HarnessError("consumer metadata resolved another workspace or root package")
    nodes = resolve.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise HarnessError("consumer metadata is missing the resolved feature graph")
    resolved = {}
    for node in nodes:
        if (not isinstance(node, dict) or not isinstance(node.get("id"), str)
                or node["id"] not in by_id or node["id"] in resolved):
            raise HarnessError("invalid resolved consumer package")
        for field in ("features", "dependencies"):
            values = node.get(field)
            if (not isinstance(values, list)
                    or any(not isinstance(value, str) or not value for value in values)
                    or len(set(values)) != len(values)):
                raise HarnessError(f"invalid resolved consumer {field}")
        resolved[node["id"]] = node
    if any(dependency not in resolved for node in nodes for dependency in node["dependencies"]):
        raise HarnessError("consumer metadata has an unresolved dependency")
    owners = {}
    for name, (path, features) in expected.items():
        package_id = selected[name]["id"]
        node = resolved.get(package_id)
        if node is None:
            raise HarnessError(f"consumer metadata did not resolve {name}")
        if features is not None and sorted(node["features"]) != features:
            raise HarnessError(f"consumer resolved unexpected {name} features: {node['features']}")
        owners[name] = {
            "packageId": package_id, "manifestPath": str((checkout / path).resolve()),
            "features": node["features"],
        }
    core = owners["tsumugi-core"]["packageId"]
    host = owners["tsumugi-plugin-host"]["packageId"]
    sdk = owners["tsumugi-plugin-sdk"]["packageId"]
    if (not {core, host, sdk}.issubset(resolved[root]["dependencies"])
            or not {core, sdk}.issubset(resolved[host]["dependencies"])
            or sdk not in resolved[core]["dependencies"]):
        raise HarnessError("consumer dependency graph does not bind the selected Core, Host and SDK")
    return {"workspaceRoot": str(workspace), "owners": owners}


def inspect_consumer(commands: Commands, consumer: dict, offline: bool) -> None:
    record = commands.run("consumer-metadata", metadata_command(offline))
    consumer["command"] = record
    require_success(record)
    # Full Cargo metadata is larger than the bounded package/runtime descriptors.
    metadata = read_json(commands.output / record["stdout"], 16 * 1024 * 1024)
    consumer.update(verify_consumer_graph(metadata, commands.checkout))
    consumer["status"] = "passed"


def summary_counts(output: str) -> dict:
    running = re.findall(r"^running (\d+) tests?\s*$", output, re.MULTILINE)
    summaries = re.findall(
        r"^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; "
        r"(\d+) measured; (\d+) filtered out;.*$", output, re.MULTILINE,
    )
    if len(running) != 1 or len(summaries) != 1:
        raise HarnessError("expected one libtest execution and summary")
    status, passed, failed, ignored, measured, filtered = summaries[0]
    counts = dict(zip(
        ("passed", "failed", "ignored", "measured", "filteredOut"),
        map(int, (passed, failed, ignored, measured, filtered)),
    ))
    counts["executed"] = int(running[0])
    counts["summaryStatus"] = status
    return counts


def execution_counts(output: str, name: str) -> dict:
    counts = summary_counts(output)
    observed = re.findall(r"^test ([^\r\n]+) \.\.\. (ok|FAILED|ignored)\s*$", output, re.MULTILINE)
    if counts["executed"] != 1 or observed != [(name, "ok")]:
        raise HarnessError(f"expected exactly the named executed test: {name}")
    if counts["summaryStatus"] != "ok" or any(counts[key] != expected for key, expected in (
        ("passed", 1), ("failed", 0), ("ignored", 0), ("measured", 0),
    )):
        raise HarnessError(f"the selected test did not pass exactly once: {name}")
    return counts


def checkout_identity(commands: Commands) -> dict:
    root = commands.checked("checkout-root", ["git", "rev-parse", "--show-toplevel"])
    if Path(root).resolve() != commands.checkout.resolve():
        raise HarnessError("the script must belong to the selected public checkout")
    commit = commands.checked("checkout-commit", ["git", "rev-parse", "HEAD"])
    status = commands.checked("checkout-status", ["git", "status", "--porcelain=v1", "--untracked-files=all"])
    commands.checked("sdk-tracked", [
        "git", "ls-files", "--error-unmatch", "crates/plugin-sdk/Cargo.toml", "crates/plugin-sdk/src/lib.rs",
    ])
    sdk_status = commands.checked("sdk-status", [
        "git", "status", "--porcelain=v1", "--untracked-files=all", "--", "crates/plugin-sdk",
    ])
    checkout = commands.checkout
    workspace = tomllib.loads((checkout / "Cargo.toml").read_text(encoding="utf-8"))
    sdk = tomllib.loads((checkout / "crates/plugin-sdk/Cargo.toml").read_text(encoding="utf-8"))
    source = (checkout / "crates/plugin-sdk/src/lib.rs").read_text(encoding="utf-8")
    protocols = {}
    for name in ("MANIFEST_PROTOCOL", "PROCESS_PROTOCOL"):
        match = re.search(rf"pub const {name}: u32 = (\d+);", source)
        if not match:
            raise HarnessError(f"cannot identify SDK source constant {name}")
        protocols[name] = int(match.group(1))
    return {
        "checkout": str(checkout), "commit": commit, "dirty": bool(status),
        "dirtyScope": "whole checkout, including untracked files",
        "sdk": {
            "package": sdk["package"]["name"], "packageVersion": sdk["package"]["version"],
            "workspaceVersion": workspace["workspace"]["package"]["version"],
            "manifestProtocol": protocols["MANIFEST_PROTOCOL"],
            "processProtocol": protocols["PROCESS_PROTOCOL"],
            "producer": {"kind": "this-checkout", "commit": commit, "tracked": True, "dirty": bool(sdk_status)},
        },
        "provenance": "Checkout declarations and Git state; not source authentication or proof of the prebuilt JavaScript Host's source commit.",
    }


def inspect_package(commands: Commands, case: dict, offline: bool) -> None:
    domain = case["domain"]
    record = commands.run(f"inspect-{domain}", inspection_command(
        "tsumugi-plugin-package", [case["packageDirectory"]], offline,
    ))
    case["inspectionCommand"] = record
    require_success(record)
    observed = read_json(commands.output / record["stdout"])
    case["inspection"] = observed
    if observed.get("packageDigest") != case["expectedPackageDigest"]:
        raise HarnessError(f"{domain} package digest does not match the independently supplied pin")


def inspect_runtime(commands: Commands, args: argparse.Namespace) -> dict:
    approval = read_json(absolute(args.runtime_approval))
    request = {
        "profile": approval["profile"], "toolVersion": approval["toolVersion"],
        "toolEntrypoint": approval["tool"]["entrypoint"], "hostEntrypoint": approval["host"]["entrypoint"],
    }
    request_path = commands.output / "runtime-inspection-request.json"
    write_json(request_path, request)
    record = commands.run("inspect-runtime", inspection_command(
        "tsumugi-plugin-runtime",
        [str(absolute(args.runtime_tool)), str(absolute(args.runtime_host)), str(request_path)],
        args.offline,
    ))
    require_success(record)
    observed = read_json(commands.output / record["stdout"])
    result = {
        "toolDirectory": str(absolute(args.runtime_tool)),
        "hostDirectory": str(absolute(args.runtime_host)),
        "approvalFile": str(absolute(args.runtime_approval)),
        "approvedDescriptor": approval, "inspection": observed, "command": record,
        "approvalMatched": observed.get("environment") == approval,
        "provenance": "Observed prebuilt metadata; equality with approval is checked separately. Tool version/profile remain installer claims, not discovered source provenance. Inspection executes no Worker.",
    }
    return result


def run_cases(commands: Commands, cases: list[dict], runtime_env: dict, offline: bool) -> None:
    for case in cases:
        if case["status"] == "failed":
            continue
        environment = {
            **runtime_env,
            "TSUMUGI_TEST_PLUGIN_PACKAGE": case["packageDirectory"],
            "TSUMUGI_TEST_PLUGIN_DIGEST": case["expectedPackageDigest"],
        }
        record = commands.run(
            f"test-{case['domain']}", test_command(case["testTarget"], case["test"], offline), environment,
        )
        case["execution"] = {"command": record, "selection": {**runtime_env,
            "TSUMUGI_TEST_PLUGIN_PACKAGE": case["packageDirectory"],
            "TSUMUGI_TEST_PLUGIN_DIGEST": case["expectedPackageDigest"],
        }}
        output = commands.text(record)
        try:
            case["executionCounts"] = summary_counts(output)
        except HarnessError:
            # Build/launch failures need not contain any libtest summary. Their
            # actual exit and complete logs remain evidence, never an empty pass.
            pass
        try:
            require_success(record)
            case["executionCounts"] = execution_counts(output, case["test"])
            case["status"] = "passed"
        except HarnessError as error:
            case["status"] = "failed"
            case["error"] = str(error)


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(description=__doc__)
    for _, prefix, _, _ in CASES:
        command.add_argument(f"--{prefix}-package", required=True)
        command.add_argument(f"--{prefix}-digest", required=True)
    for name in ("runtime-tool", "runtime-host", "runtime-approval", "output"):
        command.add_argument(f"--{name}", required=True)
    command.add_argument("--offline", action="store_true", help="pass --offline to every Cargo command")
    return command


def interrupt_signal(_number, _frame) -> None:
    # CI commonly sends SIGTERM rather than Ctrl-C. Route it through the same
    # owned command cleanup and failed-report path before exiting.
    raise KeyboardInterrupt


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    output = absolute(args.output)
    try:
        output.mkdir(parents=True, exist_ok=False)
    except OSError as error:
        print(f"a new output directory is required: {error}", file=sys.stderr)
        return 2
    checkout = Path(__file__).resolve().parents[3]
    commands = Commands(checkout, output)
    cases = [{
        "domain": domain, "testTarget": target, "test": name, "status": "not-run",
        "packageDirectory": str(absolute(getattr(args, f"{prefix}_package"))),
        "expectedPackageDigest": getattr(args, f"{prefix}_digest"),
    } for domain, prefix, target, name in CASES]
    report = {
        "schemaVersion": 1, "status": "failed", "cases": cases, "commands": commands.records,
        "offline": args.offline, "commandTimeoutSeconds": COMMAND_TIMEOUT_SECONDS,
        "coverage": "Two existing conformance consumers in an independent workspace with verified normal Core features=[], using PackageImage, RunnerProxy, real Workers and Core grants/adoption/reopen; not PackageStore installation, Desktop IPC/GUI, a sandbox, source authentication, model execution or complete platform compatibility.",
    }
    previous_terminate = signal.signal(signal.SIGTERM, interrupt_signal)
    try:
        if sys.platform not in ("darwin", "linux"):
            raise HarnessError("this runtime conformance profile requires macOS or Linux")
        target = os.environ.get("CARGO_TARGET_DIR")
        if not target or not Path(target).is_absolute():
            raise HarnessError("set CARGO_TARGET_DIR explicitly to an absolute shared Cargo cache")
        report["cargoTargetDirectory"] = str(absolute(target))
        for case in cases:
            if not re.fullmatch(r"[0-9a-f]{64}", case["expectedPackageDigest"]):
                raise HarnessError(f"invalid independently supplied {case['domain']} package digest")
        report["host"] = checkout_identity(commands)
        report["consumer"] = {"manifestPath": str(commands.checkout / CONSUMER_MANIFEST), "status": "failed"}
        inspect_consumer(commands, report["consumer"], args.offline)
        for case in cases:
            try:
                inspect_package(commands, case, args.offline)
            except (HarnessError, OSError, ValueError) as error:
                case["status"] = "failed"
                case["error"] = str(error)
        report["runtime"] = inspect_runtime(commands, args)
        if not report["runtime"]["approvalMatched"]:
            raise HarnessError("observed runtime descriptor differs from the supplied approval")
        runtime_env = {
            "TSUMUGI_TEST_RUNTIME_TOOL": str(absolute(args.runtime_tool)),
            "TSUMUGI_TEST_RUNTIME_HOST": str(absolute(args.runtime_host)),
            "TSUMUGI_TEST_RUNTIME_APPROVAL": str(absolute(args.runtime_approval)),
        }
        run_cases(commands, cases, runtime_env, args.offline)
        end_commit = commands.checked("checkout-end-commit", ["git", "rev-parse", "HEAD"])
        end_status = commands.checked("checkout-end-status", ["git", "status", "--porcelain=v1", "--untracked-files=all"])
        report["host"]["after"] = {"commit": end_commit, "dirty": bool(end_status)}
        if end_commit != report["host"]["commit"]:
            raise HarnessError("checkout commit changed during conformance")
        if all(case["status"] == "passed" for case in cases):
            report["status"] = "passed"
    except (HarnessError, OSError, ValueError, KeyError) as error:
        report["error"] = str(error)
    except KeyboardInterrupt:
        report["error"] = "interrupted; the owned command session was terminated"
    finally:
        try:
            write_json(output / "compatibility.json", report)
        finally:
            signal.signal(signal.SIGTERM, previous_terminate)
    print(f"{report['status']}: {output / 'compatibility.json'}")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
