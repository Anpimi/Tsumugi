"""Transport-only fixtures; the synthetic inspector supplies no Host acceptance."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("desktop_plugins", Path(__file__).resolve().parents[1] / "scripts/prepare-desktop-plugins.py")
OWNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNER)


def archive(files, extra=()):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as stream:
        for name, (data, executable) in files.items():
            item = tarfile.TarInfo(name)
            item.size, item.mode = len(data), 0o755 if executable else 0o644
            stream.addfile(item, io.BytesIO(data))
        for item, data in extra:
            stream.addfile(item, io.BytesIO(data) if data is not None else None)
    return output.getvalue()


class DesktopPluginPreparation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tsumugi-plugin-transport-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.artifacts = self.root / "artifacts"
        self.artifacts.mkdir(mode=0o700)
        self.output = self.root / "prepared"
        self.inspector = self.root / "approved-inspector"
        self.inspector.write_bytes(b"synthetic inspector fixture; never executed")
        self.inspector.chmod(0o700)
        self.inspector_hash = OWNER.sha256(self.inspector.read_bytes())
        self.catalog_path = self.root / "selection.json"
        self.catalog = {"formatVersion": 1, "platform": {"operatingSystem": "macos", "architecture": "aarch64"},
                        "runtimeProfile": "node-system-libraries-v1", "processProtocol": 2, "packages": []}
        self.files = {}
        for name in ("first", "second"):
            identity = {"publisher": "org.example", "id": name, "version": "0.1.0-alpha.1"}
            pin = {"id": name, "displayName": name, "plugin": identity, "packageDigest": "a" * 64,
                   "sourceRepository": "https://github.com/example/plugins", "sourceCommit": "b" * 40,
                   "sdkVersion": "0.1.0-alpha.1", "sdkArtifactSha256": "c" * 64, "archiveName": name + ".tar"}
            files = {"manifest.json": (json.dumps({"plugin": identity, "components": []}).encode(), False),
                     "component/main": (b"synthetic executable fixture; never executed", True),
                     "sdk/LICENSE": (b"synthetic license", False),
                     "sdk/lock.json": (json.dumps({"package": "tsumugi-plugin-sdk", "version": pin["sdkVersion"],
                                                   "sha256": pin["sdkArtifactSha256"]}).encode(), False),
                     "package-files.json": (json.dumps({"formatVersion": 1,
                                                        "files": ["manifest.json", "component/main", "package-files.json"],
                                                        "sdkFiles": [{"source": "LICENSE", "target": "sdk/LICENSE"}]}).encode(), False)}
            data = archive(files)
            pin["archiveSha256"] = OWNER.sha256(data)
            (self.artifacts / pin["archiveName"]).write_bytes(data)
            self.catalog["packages"].append(pin)
            self.files[name] = files
        self.save_catalog()
        self.calls = []

    def save_catalog(self):
        self.catalog_path.write_text(json.dumps(self.catalog))

    def fake_inspector(self, executable, package):
        self.assertNotEqual(executable, self.inspector)
        self.assertEqual(executable.read_bytes(), b"synthetic inspector fixture; never executed")
        self.assertEqual(stat.S_IMODE(executable.stat().st_mode), 0o500)
        self.calls.append(package.name)
        files = self.files[package.name]
        pin = next(pin for pin in self.catalog["packages"] if pin["id"] == package.name)
        return json.dumps({"plugin": pin["plugin"], "packageDigest": pin["packageDigest"],
                           "manifestSha256": OWNER.sha256(files["manifest.json"][0]),
                           "fileCount": len(files), "byteCount": sum(len(data) for data, _ in files.values())}).encode()

    def prepare(self, inspector=None):
        return OWNER.prepare(self.artifacts, self.output, self.inspector, self.inspector_hash,
                             selection_path=self.catalog_path, run_inspector=inspector or self.fake_inspector)

    def test_complete_preparation_preserves_bytes_modes_and_inputs_under_private_umask(self):
        parent_mode = stat.S_IMODE(self.artifacts.stat().st_mode)
        previous = os.umask(0o077)
        try:
            result = self.prepare()
        finally:
            os.umask(previous)
        self.assertEqual(self.calls, ["first", "second"])
        self.assertEqual(result["execution"], "not-run")
        self.assertEqual(result["runtimeCompatibility"], "not-run")
        self.assertEqual(json.loads((self.output / "preparation.json").read_text()), result)
        self.assertEqual(stat.S_IMODE(self.artifacts.stat().st_mode), parent_mode)
        self.assertFalse(list(self.root.glob(".tsumugi-plugins-*")))
        for package, files in self.files.items():
            for name, (data, executable) in files.items():
                path = self.output / package / name
                self.assertEqual(path.read_bytes(), data)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o755 if executable else 0o644)
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o755)

    def test_existing_output_is_preserved_before_reading_any_inputs(self):
        self.output.mkdir()
        (self.output / "sentinel").write_bytes(b"preserved")
        self.inspector.unlink()
        with self.assertRaisesRegex(OWNER.PreparationError, "already exists"):
            self.prepare()
        self.assertEqual((self.output / "sentinel").read_bytes(), b"preserved")
        self.assertFalse(list(self.root.glob(".tsumugi-plugins-*")))

    def test_corrupt_missing_or_wrong_source_archives_never_create_final_output(self):
        pin = self.catalog["packages"][0]
        selected = self.artifacts / pin["archiveName"]
        original = selected.read_bytes()
        for mode in ("corrupt", "missing", "wrong-source"):
            with self.subTest(mode=mode):
                selected.write_bytes(original)
                if mode == "corrupt":
                    selected.write_bytes(original + b"extra")
                elif mode == "missing":
                    selected.unlink()
                else:
                    pin["plugin"]["publisher"] = "different.publisher"
                    self.save_catalog()
                with self.assertRaises((OSError, OWNER.PreparationError)):
                    self.prepare()
                self.assertFalse(self.output.exists())
                self.assertFalse(self.calls)

    def test_untrusted_inspector_is_refused_without_staging_or_execution(self):
        self.inspector_hash = "f" * 64
        with self.assertRaisesRegex(OWNER.PreparationError, "executable pin"):
            self.prepare()
        self.assertFalse(self.calls)
        self.assertFalse(list(self.root.glob(".tsumugi-plugins-*")))

    def test_symlink_and_hardlinked_archive_inputs_are_refused(self):
        selected = self.artifacts / "first.tar"
        saved = self.root / "original.tar"
        selected.rename(saved)
        for mode in ("symlink", "hardlink"):
            with self.subTest(mode=mode):
                if mode == "symlink":
                    selected.symlink_to(saved)
                else:
                    os.link(saved, selected)
                with self.assertRaises((OSError, OWNER.PreparationError)):
                    self.prepare()
                selected.unlink()
        self.assertFalse(self.output.exists())

    def test_symbolic_ancestor_and_parent_traversal_are_refused(self):
        alias = self.root / "alias"
        alias.symlink_to(self.artifacts, target_is_directory=True)
        self.artifacts = alias
        with self.assertRaises(OSError):
            self.prepare()
        self.artifacts = self.root / "artifacts"
        self.output = self.root / "absent" / ".." / "prepared"
        with self.assertRaisesRegex(OWNER.PreparationError, "parent traversal"):
            self.prepare()

    def test_archive_path_escape_alias_overlap_and_special_members_are_refused(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE),
                           (".", tarfile.REGTYPE), ("sdk/\x7f", tarfile.REGTYPE),
                           ("SDK/other", tarfile.REGTYPE),
                           ("a\\b", tarfile.REGTYPE), ("a/./b", tarfile.REGTYPE),
                           ("CON.txt", tarfile.REGTYPE), ("manifest.json/child", tarfile.REGTYPE),
                           ("MANIFEST.JSON", tarfile.REGTYPE), ("manifest.json", tarfile.REGTYPE),
                           ("extra", tarfile.SYMTYPE), ("extra", tarfile.LNKTYPE),
                           ("extra", tarfile.DIRTYPE), ("extra", tarfile.FIFOTYPE)):
            with self.subTest(name=name, kind=kind):
                item = tarfile.TarInfo(name)
                item.type = kind
                item.linkname = "manifest.json" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""
                item.size = 1 if kind == tarfile.REGTYPE else 0
                data = archive(self.files["first"], [(item, b"x" if item.size else None)])
                pin = dict(self.catalog["packages"][0], archiveSha256=OWNER.sha256(data))
                with self.assertRaises(OWNER.PreparationError):
                    OWNER.unpack(data, pin)
        self.assertFalse((self.root / "escape").exists())

    def test_recipe_extra_missing_and_wrong_sdk_files_are_refused(self):
        for mutation in ("extra", "missing", "sdk"):
            with self.subTest(mutation=mutation):
                files = dict(self.files["first"])
                if mutation == "extra":
                    files["extra.txt"] = (b"extra", False)
                elif mutation == "missing":
                    del files["component/main"]
                else:
                    files["sdk/lock.json"] = (b'{"package":"tsumugi-plugin-sdk","version":"other","sha256":"wrong"}', False)
                data = archive(files)
                pin = dict(self.catalog["packages"][0], archiveSha256=OWNER.sha256(data))
                with self.assertRaises(OWNER.PreparationError):
                    OWNER.unpack(data, pin)

    def test_fixed_archive_limits_reject_excess_files_and_declared_size(self):
        files = {"file-" + str(index): (b"", False) for index in range(OWNER.MAX_FILES + 1)}
        data = archive(files)
        with self.assertRaisesRegex(OWNER.PreparationError, "limits"):
            OWNER.unpack(data, dict(self.catalog["packages"][0], archiveSha256=OWNER.sha256(data)))
        item = tarfile.TarInfo("oversized")
        item.size = OWNER.MAX_BYTES + 1
        # A bounded archive with a deliberately oversized declaration is enough;
        # no giant fixture or allocation is needed.
        data = item.tobuf() + bytes(1024)
        with self.assertRaises(OWNER.PreparationError):
            OWNER.unpack(data, dict(self.catalog["packages"][0], archiveSha256=OWNER.sha256(data)))

    def test_inspector_mismatch_or_failure_retains_only_unpromoted_staging(self):
        for mutation in ("identity", "digest", "count", "extra", "failure"):
            with self.subTest(mutation=mutation):
                def response(executable, package):
                    record = json.loads(self.fake_inspector(executable, package))
                    if mutation == "failure":
                        raise OWNER.PreparationError("synthetic inspection rejection")
                    if mutation == "identity":
                        record["plugin"] = {"id": "forged"}
                    elif mutation == "digest":
                        record["packageDigest"] = "e" * 64
                    elif mutation == "count":
                        record["fileCount"] = True
                    else:
                        record["unexpected"] = True
                    return json.dumps(record).encode()
                with self.assertRaises(OWNER.PreparationError):
                    self.prepare(response)
                self.assertFalse(self.output.exists())
        self.assertEqual(len(list(self.root.glob(".tsumugi-plugins-*"))), 5)

    def test_input_archive_or_selection_changes_abort_before_promotion(self):
        for mutation in ("archive", "catalog"):
            with self.subTest(mutation=mutation):
                original = self.catalog_path.read_bytes()
                selected = self.artifacts / "first.tar"
                archive_bytes = selected.read_bytes()
                def response(executable, package):
                    result = self.fake_inspector(executable, package)
                    if mutation == "archive":
                        selected.write_bytes(archive_bytes + b"changed")
                    else:
                        self.catalog_path.write_bytes(original + b" ")
                    return result
                with self.assertRaisesRegex(OWNER.PreparationError, "changed during preparation"):
                    self.prepare(response)
                self.assertFalse(self.output.exists())
                self.catalog_path.write_bytes(original)
                selected.write_bytes(archive_bytes)

    def test_prepared_bytes_modes_links_and_extra_directories_are_rechecked(self):
        for mutation in ("bytes", "executable", "symlink", "extra-file", "extra-directory"):
            with self.subTest(mutation=mutation):
                def response(executable, package):
                    result = self.fake_inspector(executable, package)
                    target = package / "component/main"
                    if mutation == "bytes":
                        target.write_bytes(b"changed")
                    elif mutation == "executable":
                        target.chmod(0o644)
                    elif mutation == "symlink":
                        target.unlink()
                        target.symlink_to(self.inspector)
                    elif mutation == "extra-file":
                        (package / "extra").write_bytes(b"extra")
                    else:
                        (package / "empty-extra").mkdir()
                    return result
                with self.assertRaises((OSError, OWNER.PreparationError)):
                    self.prepare(response)
                self.assertFalse(self.output.exists())

    def test_captured_inspector_does_not_follow_replaced_source_path(self):
        def response(executable, package):
            self.inspector.write_bytes(b"replacement that must not execute")
            return self.fake_inspector(executable, package)
        self.prepare(response)
        self.assertTrue(self.output.is_dir())

    def test_replaced_staging_directory_is_not_promoted(self):
        def response(executable, package):
            result = self.fake_inspector(executable, package)
            if package.name == "second":
                payload = package.parent
                payload.rename(payload.with_name("retained-original"))
                payload.mkdir()
            return result
        with self.assertRaisesRegex(OWNER.PreparationError, "directory changed"):
            self.prepare(response)
        self.assertFalse(self.output.exists())

    def test_atomic_promotion_never_replaces_a_concurrently_created_output(self):
        def response(executable, package):
            if not self.output.exists():
                self.output.mkdir()
                (self.output / "sentinel").write_bytes(b"preserved")
            return self.fake_inspector(executable, package)
        with self.assertRaises(OSError):
            self.prepare(response)
        self.assertEqual(list(self.output.iterdir()), [self.output / "sentinel"])
        self.assertEqual((self.output / "sentinel").read_bytes(), b"preserved")

    def test_atomic_promotion_also_refuses_an_existing_empty_directory(self):
        def response(executable, package):
            self.output.mkdir(exist_ok=True)
            return self.fake_inspector(executable, package)
        with self.assertRaises(OSError):
            self.prepare(response)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_duplicate_json_fields_and_invalid_transport_pins_are_refused(self):
        with self.assertRaises(OWNER.PreparationError):
            OWNER.json_object(b'{"formatVersion":1,"formatVersion":1}')
        for mutation in ("duplicate", "archive-name", "archive-sha", "sdk-sha", "branch", "source", "extra"):
            with self.subTest(mutation=mutation):
                changed = copy.deepcopy(self.catalog)
                pin = changed["packages"][0]
                if mutation == "duplicate":
                    changed["packages"].append(pin)
                elif mutation == "archive-name":
                    pin["archiveName"] = "../first.tar"
                elif mutation == "archive-sha":
                    pin["archiveSha256"] = "bad"
                elif mutation == "sdk-sha":
                    pin["sdkArtifactSha256"] = "bad"
                elif mutation == "branch":
                    pin["sourceCommit"] = "main"
                elif mutation == "source":
                    pin["sourceRepository"] = "file:///source"
                else:
                    changed["extra"] = True
                with self.assertRaises(OWNER.PreparationError):
                    OWNER.selection(json.dumps(changed))

    def test_checked_in_selection_has_two_independent_process_two_artifacts(self):
        selected = OWNER.selection(OWNER.SELECTION.read_bytes())
        self.assertEqual({pin["id"] for pin in selected["packages"]}, {"webvtt", "stardew-smapi"})
        self.assertEqual(selected["processProtocol"], 2)
        self.assertNotEqual(selected["packages"][0]["archiveSha256"], selected["packages"][1]["archiveSha256"])


if __name__ == "__main__":
    unittest.main()
