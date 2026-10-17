import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "compatibility", Path(__file__).resolve().parents[1] / "compatibility.py",
)
compatibility = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compatibility)


def test_output(name, *, passed=1, failed=0, ignored=0, filtered=1):
    outcome = "FAILED" if failed else "ignored" if ignored else "ok"
    summary = "FAILED" if failed else "ok"
    count = passed + failed + ignored
    line = f"test {name} ... {outcome}\n" if count else ""
    return (
        f"running {count} test{'s' if count != 1 else ''}\n{line}\n"
        f"test result: {summary}. {passed} passed; {failed} failed; {ignored} ignored; "
        f"0 measured; {filtered} filtered out; finished in 0.03s\n"
    )


def consumer_graph(checkout):
    consumer = "path-consumer"
    core = "path-core"
    host = "path-host"
    sdk = "path-sdk"
    return {
        "version": 1,
        "workspace_root": str(checkout / "crates/plugin-host/compatibility"),
        "workspace_members": [consumer],
        "packages": [
            {"id": consumer, "name": "tsumugi-plugin-host-compatibility", "source": None,
             "manifest_path": str(checkout / "crates/plugin-host/compatibility/Cargo.toml")},
            {"id": core, "name": "tsumugi-core", "source": None,
             "manifest_path": str(checkout / "crates/core/Cargo.toml")},
            {"id": host, "name": "tsumugi-plugin-host", "source": None,
             "manifest_path": str(checkout / "crates/plugin-host/Cargo.toml")},
            {"id": sdk, "name": "tsumugi-plugin-sdk", "source": None,
             "manifest_path": str(checkout / "crates/plugin-sdk/Cargo.toml")},
        ],
        "resolve": {"root": consumer, "nodes": [
            {"id": consumer, "features": ["core-adapter", "javascript-conformance"], "dependencies": [core, host, sdk]},
            {"id": core, "features": [], "dependencies": [sdk]},
            {"id": host, "features": ["core-adapter"], "dependencies": [core, sdk]},
            {"id": sdk, "features": ["default"], "dependencies": []},
        ]},
    }


class FakeCommands:
    """Orchestration tests never build, inspect or start a Worker."""

    def __init__(self, checkout, output, responses):
        self.checkout = checkout
        self.output = output
        self.responses = responses
        self.records = []
        self.selections = {}

    def run(self, label, argv, env=None):
        exit_code, text = self.responses[label]
        record = {
            "label": label, "argv": argv, "cwd": str(self.checkout),
            "stdout": f"{label}.stdout.log", "stderr": f"{label}.stderr.log",
            "exitCode": exit_code, "timedOut": False,
        }
        self.records.append(record)
        self.selections[label] = env
        (self.output / record["stdout"]).write_text(text, encoding="utf-8")
        (self.output / record["stderr"]).write_text("", encoding="utf-8")
        return record

    def text(self, record):
        return (self.output / record["stdout"]).read_text(encoding="utf-8")

    def checked(self, label, argv):
        record = self.run(label, argv)
        compatibility.require_success(record)
        return self.text(record).strip()


class SelectionTests(unittest.TestCase):
    def test_exact_executed_name_accepts_other_filtered_tests(self):
        counts = compatibility.execution_counts(test_output("selected", filtered=7), "selected")
        self.assertEqual(counts["executed"], 1)
        self.assertEqual(counts["passed"], 1)
        self.assertEqual(counts["filteredOut"], 7)

    def test_zero_wrong_ignored_failed_and_duplicate_executions_are_rejected(self):
        for output in (
            test_output("selected", passed=0),
            test_output("different"),
            test_output("selected", passed=0, ignored=1),
            test_output("selected", passed=0, failed=1),
            test_output("selected") + test_output("selected"),
        ):
            with self.subTest(output=output), self.assertRaises(compatibility.HarnessError):
                compatibility.execution_counts(output, "selected")

    def test_commands_fix_features_target_name_and_exact_selection(self):
        for _, _, target, name in compatibility.CASES:
            command = compatibility.test_command(target, name, True)
            self.assertEqual(command[:3], ["cargo", "--offline", "test"])
            self.assertEqual(command[command.index("--manifest-path") + 1], "crates/plugin-host/compatibility/Cargo.toml")
            self.assertEqual(command[command.index("--features") + 1], "core-adapter,javascript-conformance")
            self.assertEqual(command[command.index("--test") + 1], target)
            self.assertEqual(command[-5:], [name, "--", "--exact", "--nocapture", "--test-threads=1"])
            self.assertNotIn("--ignored", command)
            self.assertNotIn("-p", command)
            metadata = compatibility.metadata_command(True)
            self.assertEqual(metadata[:3], ["cargo", "--offline", "metadata"])
            for flag in ("--manifest-path", "--features"):
                self.assertEqual(metadata[metadata.index(flag) + 1], command[command.index(flag) + 1])
            self.assertIn("--locked", metadata)
            self.assertEqual(metadata[-2:], ["--format-version", "1"])

    def test_termination_uses_the_owned_command_interruption_cleanup(self):
        with self.assertRaises(KeyboardInterrupt):
            compatibility.interrupt_signal(compatibility.signal.SIGTERM, None)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            commands = compatibility.Commands(directory, directory)
            process = mock.Mock(returncode=-15)
            process.wait.side_effect = KeyboardInterrupt
            with mock.patch.object(compatibility.subprocess, "Popen", return_value=process), \
                 mock.patch.object(compatibility, "stop_owned_process") as stop, \
                 self.assertRaises(KeyboardInterrupt):
                commands.run("interrupted", ["cargo", "test"])
            stop.assert_called_once_with(process)
            self.assertTrue(commands.records[0]["interrupted"])
            self.assertEqual(commands.records[0]["exitCode"], -15)
            self.assertTrue((directory / commands.records[0]["stdout"]).is_file())
            self.assertTrue((directory / commands.records[0]["stderr"]).is_file())


class ConsumerGraphTests(unittest.TestCase):
    def test_exact_normal_core_owner_accepts_normal_transitive_features(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            graph = consumer_graph(checkout)
            graph["packages"].append({
                "id": "registry-dependency", "name": "ordinary-dependency",
                "source": "registry+https://example.invalid/index",
                "manifest_path": str(checkout / "cache/ordinary-dependency/Cargo.toml"),
            })
            graph["resolve"]["nodes"].append({"id": "registry-dependency", "features": ["default", "std"], "dependencies": []})
            graph["resolve"]["nodes"][1]["dependencies"].append("registry-dependency")
            verified = compatibility.verify_consumer_graph(graph, checkout)
            owners = verified["owners"]
            self.assertEqual(verified["workspaceRoot"], str((checkout / "crates/plugin-host/compatibility").resolve()))
            self.assertEqual(owners["tsumugi-core"]["features"], [])
            self.assertEqual(owners["tsumugi-core"]["manifestPath"], str((checkout / "crates/core/Cargo.toml").resolve()))
            self.assertEqual(owners["tsumugi-plugin-sdk"]["features"], ["default"])

    def test_missing_or_malformed_resolve_never_proves_normal_core(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            original = consumer_graph(checkout)
            changes = [
                lambda value: value.update(version=True),
                lambda value: value.update(packages=None),
                lambda value: value.update(resolve=None),
                lambda value: value.pop("resolve"),
                lambda value: value["resolve"].update(nodes=[]),
                lambda value: value["resolve"].update(nodes=[None]),
                lambda value: value["resolve"]["nodes"].pop(1),
                lambda value: value["resolve"]["nodes"][1].pop("features"),
                lambda value: value["resolve"]["nodes"][1].update(features="[]"),
                lambda value: value["resolve"]["nodes"][1].update(features=[False]),
                lambda value: value["resolve"]["nodes"][1].update(dependencies=[[]]),
                lambda value: value["resolve"]["nodes"][1].update(dependencies=["unresolved"]),
                lambda value: value["resolve"]["nodes"].append(copy.deepcopy(value["resolve"]["nodes"][1])),
            ]
            for change in changes:
                graph = copy.deepcopy(original)
                change(graph)
                with self.subTest(graph=graph), self.assertRaises(compatibility.HarnessError):
                    compatibility.verify_consumer_graph(graph, checkout)

    def test_fixture_features_wrong_owners_and_disconnected_dependencies_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            original = consumer_graph(checkout)
            changes = [
                lambda value: value["resolve"]["nodes"][1].update(features=["execution-test-host"]),
                lambda value: value["resolve"]["nodes"][1].update(features=["wire-schema"]),
                lambda value: value["packages"][1].update(manifest_path=str(checkout / "other/core/Cargo.toml")),
                lambda value: value["packages"][1].update(manifest_path="crates/core/Cargo.toml"),
                lambda value: value["packages"][1].update(source="registry+https://example.invalid/index"),
                lambda value: value["packages"].pop(1),
                lambda value: value["packages"].append(dict(value["packages"][1], id="another-core")),
                lambda value: value["packages"][2].update(manifest_path=str(checkout / "other/host/Cargo.toml")),
                lambda value: value["packages"][3].update(manifest_path=str(checkout / "other/sdk/Cargo.toml")),
                lambda value: value.update(workspace_root=str(checkout)),
                lambda value: value.update(workspace_members=["path-host"]),
                lambda value: value["resolve"].update(root="path-host"),
                lambda value: value["resolve"]["nodes"][0].update(features=["core-adapter"]),
                lambda value: value["resolve"]["nodes"][2].update(features=["core-adapter", "javascript-conformance"]),
                lambda value: value["resolve"]["nodes"][0]["dependencies"].remove("path-core"),
                lambda value: value["resolve"]["nodes"][2]["dependencies"].remove("path-core"),
            ]
            for change in changes:
                graph = copy.deepcopy(original)
                change(graph)
                with self.subTest(graph=graph), self.assertRaises(compatibility.HarnessError):
                    compatibility.verify_consumer_graph(graph, checkout)


class HarnessTests(unittest.TestCase):
    def exercise(self, *, webvtt_exit=0, webvtt_output=None, webvtt_digest=None,
                 runtime_matches=True, metadata_exit=0, metadata_output=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "results"
            approval = {
                "profile": "node-system-libraries-v1", "toolVersion": "22.0.0",
                "tool": {"treeDigest": "c" * 64, "entrypoint": "bin/node"},
                "host": {"treeDigest": "d" * 64, "entrypoint": "host.mjs"},
                "sdkVersion": "0.1.0-alpha.1", "processProtocol": 3,
                "protocolVersion": 1, "platform": "linux-x86_64",
            }
            approval_path = root / "approval.json"
            approval_path.write_text(json.dumps(approval), encoding="utf-8")
            observed = dict(approval)
            if not runtime_matches:
                observed["toolVersion"] = "23.0.0"
            webvtt = compatibility.CASES[0][3]
            smapi = compatibility.CASES[1][3]
            responses = {
                "consumer-metadata": (metadata_exit, metadata_output if metadata_output is not None else json.dumps(
                    consumer_graph(Path(compatibility.__file__).resolve().parents[3]),
                )),
                "inspect-webvtt": (0, json.dumps({"packageDigest": "a" * 64, "plugin": {"id": "webvtt"}})),
                "inspect-stardew-smapi": (0, json.dumps({"packageDigest": "b" * 64, "plugin": {"id": "stardew-smapi"}})),
                "inspect-runtime": (0, json.dumps({"environment": observed, "environmentDigest": "e" * 64})),
                "test-webvtt": (webvtt_exit, webvtt_output if webvtt_output is not None else test_output(webvtt)),
                "test-stardew-smapi": (0, test_output(smapi)),
                "checkout-end-commit": (0, "checkout-identity\n"),
                "checkout-end-status": (0, "?? scripts/compatibility.py\n"),
            }
            created = []

            def create(checkout, directory):
                commands = FakeCommands(checkout, directory, responses)
                created.append(commands)
                return commands

            arguments = [
                "--webvtt-package", str(root / "webvtt"), "--webvtt-digest", webvtt_digest or "a" * 64,
                "--smapi-package", str(root / "smapi"), "--smapi-digest", "b" * 64,
                "--runtime-tool", str(root / "tool"), "--runtime-host", str(root / "host"),
                "--runtime-approval", str(approval_path), "--output", str(output), "--offline",
            ]
            with mock.patch.object(compatibility, "Commands", side_effect=create), \
                 mock.patch.object(compatibility, "checkout_identity", return_value={"commit": "checkout-identity", "dirty": True}), \
                 mock.patch.object(compatibility.sys, "platform", "linux"), \
                 mock.patch.dict(os.environ, {"CARGO_TARGET_DIR": str(root / "shared-target")}), \
                 contextlib.redirect_stdout(io.StringIO()):
                result = compatibility.main(arguments)
            report = json.loads((output / "compatibility.json").read_text(encoding="utf-8"))
            for command in report["commands"]:
                self.assertTrue((output / command["stdout"]).is_file())
                self.assertTrue((output / command["stderr"]).is_file())
            return result, report, created[0]

    def test_both_real_consumer_commands_and_original_selections_are_required(self):
        result, report, commands = self.exercise()
        self.assertEqual(result, 0)
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["host"]["commit"], "checkout-identity")
        self.assertEqual(report["consumer"]["status"], "passed")
        self.assertEqual(report["consumer"]["owners"]["tsumugi-core"]["features"], [])
        self.assertEqual(commands.records[0]["label"], "consumer-metadata")
        self.assertEqual([case["status"] for case in report["cases"]], ["passed", "passed"])
        for case in report["cases"]:
            self.assertEqual(case["executionCounts"]["passed"], 1)
            self.assertEqual(case["inspection"]["packageDigest"], case["expectedPackageDigest"])
            selection = commands.selections[f"test-{case['domain']}"]
            self.assertEqual(selection["TSUMUGI_TEST_PLUGIN_PACKAGE"], case["packageDirectory"])
            self.assertEqual(selection["TSUMUGI_TEST_PLUGIN_DIGEST"], case["expectedPackageDigest"])
            self.assertEqual(set(selection), {
                "TSUMUGI_TEST_PLUGIN_PACKAGE", "TSUMUGI_TEST_PLUGIN_DIGEST",
                "TSUMUGI_TEST_RUNTIME_TOOL", "TSUMUGI_TEST_RUNTIME_HOST", "TSUMUGI_TEST_RUNTIME_APPROVAL",
            })

    def test_metadata_failure_stops_before_inspection_or_any_consumer(self):
        result, report, commands = self.exercise(metadata_exit=101, metadata_output="Cargo metadata failed")
        self.assertEqual(result, 1)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["consumer"]["status"], "failed")
        self.assertEqual(report["consumer"]["command"]["exitCode"], 101)
        self.assertIn("consumer-metadata", report["error"])
        self.assertEqual([case["status"] for case in report["cases"]], ["not-run", "not-run"])
        self.assertEqual([record["label"] for record in commands.records], ["consumer-metadata"])

    def test_invalid_json_and_fixture_features_cannot_fall_back_to_host_tests(self):
        graph = consumer_graph(Path(compatibility.__file__).resolve().parents[3])
        graph["resolve"]["nodes"][1]["features"] = ["execution-test-host"]
        for output in ["not JSON", "[]", json.dumps(graph)]:
            with self.subTest(output=output):
                result, report, commands = self.exercise(metadata_output=output)
                self.assertEqual(result, 1)
                self.assertEqual(report["status"], "failed")
                self.assertEqual(report["consumer"]["status"], "failed")
                self.assertTrue(report["error"])
                self.assertEqual([case["status"] for case in report["cases"]], ["not-run", "not-run"])
                self.assertEqual([record["label"] for record in commands.records], ["consumer-metadata"])

    def test_failed_consumer_retains_actual_counts_logs_and_the_other_result(self):
        name = compatibility.CASES[0][3]
        result, report, _ = self.exercise(webvtt_exit=101, webvtt_output=test_output(name, passed=0, failed=1))
        self.assertEqual(result, 1)
        self.assertEqual(report["status"], "failed")
        self.assertEqual([case["status"] for case in report["cases"]], ["failed", "passed"])
        self.assertEqual(report["cases"][0]["executionCounts"]["failed"], 1)
        self.assertEqual(report["cases"][0]["execution"]["command"]["exitCode"], 101)

    def test_empty_filtered_success_is_an_overall_failure(self):
        result, report, _ = self.exercise(webvtt_output=test_output("unused", passed=0))
        self.assertEqual(result, 1)
        self.assertEqual(report["cases"][0]["executionCounts"]["executed"], 0)
        self.assertEqual(report["cases"][1]["status"], "passed")

    def test_wrong_package_pin_prevents_that_worker_and_keeps_other_case(self):
        result, report, commands = self.exercise(webvtt_digest="f" * 64)
        self.assertEqual(result, 1)
        self.assertEqual(report["cases"][0]["inspection"]["packageDigest"], "a" * 64)
        self.assertNotIn("test-webvtt", commands.selections)
        self.assertEqual(report["cases"][1]["status"], "passed")

    def test_runtime_mismatch_keeps_observed_descriptor_without_starting_consumers(self):
        result, report, commands = self.exercise(runtime_matches=False)
        self.assertEqual(result, 1)
        self.assertEqual(report["runtime"]["inspection"]["environment"]["toolVersion"], "23.0.0")
        self.assertNotIn("test-webvtt", commands.selections)
        self.assertNotIn("test-stardew-smapi", commands.selections)
        self.assertEqual([case["status"] for case in report["cases"]], ["not-run", "not-run"])

    def test_existing_output_is_never_reused_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "compatibility.json"
            marker.write_text("original", encoding="utf-8")
            arguments = []
            for _, prefix, _, _ in compatibility.CASES:
                arguments += [f"--{prefix}-package", "unused", f"--{prefix}-digest", "a" * 64]
            arguments += ["--runtime-tool", "unused", "--runtime-host", "unused", "--runtime-approval", "unused", "--output", str(root)]
            with mock.patch.object(compatibility, "Commands") as commands, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(compatibility.main(arguments), 2)
            commands.assert_not_called()
            self.assertEqual(marker.read_text(encoding="utf-8"), "original")


if __name__ == "__main__":
    unittest.main()
