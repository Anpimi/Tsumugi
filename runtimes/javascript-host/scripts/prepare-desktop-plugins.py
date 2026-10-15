#!/usr/bin/env python3
"""Prepare the source-pinned desktop packages from complete local transport archives.

This build tool neither downloads nor builds packages. The public Rust Host owns
manifest validation and packageDigest; this module handles only transport and IO.
"""
import argparse
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import stat
import subprocess
import sys
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
SELECTION = ROOT / "apps/desktop/src-tauri/bundled-plugins.macos-aarch64.json"
MAX_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_BYTES = MAX_BYTES + 1024 * 1024
MAX_FILES = 256
MAX_JSON_BYTES = 256 * 1024


class PreparationError(ValueError):
    pass


def fail(message):
    raise PreparationError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def json_object(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail("Duplicate JSON field.")
            result[key] = value
        return result
    result = json.loads(data, object_pairs_hook=unique)
    if not isinstance(result, dict):
        fail("Expected a JSON object.")
    return result


def relative_file(name, maximum_depth=16):
    if not isinstance(name, str) or not name or not name.isascii() or len(name) > 1024:
        fail("Archive contains an invalid file name.")
    path = PurePosixPath(name)
    if (not path.parts or path.is_absolute() or str(path) != name or len(path.parts) > maximum_depth
            or any(part in {".", ".."} for part in path.parts) or "\\" in name):
        fail("Archive contains a noncanonical path.")
    for part in path.parts:
        stem = part.split(".")[0].upper()
        if (part.endswith((".", " ")) or any(ord(c) < 32 or ord(c) == 127 or c in ':*?"<>|' for c in part)
                or stem in {"CON", "PRN", "AUX", "NUL"}
                or len(stem) == 4 and stem[:3] in {"COM", "LPT"} and stem[3] in "123456789"):
            fail("Archive contains a nonportable path.")
    return path


def absolute(path):
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        fail("Select an absolute path without parent traversal.")
    # Only these two fixed OS aliases are allowed; never resolve input symlinks.
    if sys.platform == "darwin" and len(path.parts) > 1 and path.parts[1] in {"tmp", "var"}:
        alias = "/" + path.parts[1]
        if os.path.islink(alias) and os.readlink(alias) == "/private" + alias:
            path = Path("/private" + str(path))
    return path


def directory(path):
    path = absolute(path)
    held = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=held)
            os.close(held)
            held = child
        return held
    except BaseException:
        os.close(held)
        raise


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def capture(held, name, maximum):
    # Every caller selects one direct member of an already held directory.
    if Path(name).name != name or name in {"", ".", ".."}:
        fail("Invalid selected file.")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=held)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
            fail("Selected input is not a bounded ordinary file.")
        chunks, count = [], 0
        while chunk := os.read(fd, min(65536, maximum - count + 1)):
            chunks.append(chunk)
            count += len(chunk)
            if count > maximum:
                fail("Selected input exceeds its bound.")
        after = os.fstat(fd)
        selected = os.stat(name, dir_fd=held, follow_symlinks=False)
        if identity(before) != identity(after) or identity(after) != identity(selected):
            fail("Selected input changed during capture.")
        return b"".join(chunks), bool(before.st_mode & 0o111)
    finally:
        os.close(fd)


def selection(data):
    value = json_object(data)
    if (set(value) != {"formatVersion", "platform", "runtimeProfile", "processProtocol", "packages"}
            or type(value["formatVersion"]) is not int or value["formatVersion"] != 1
            or value["platform"] != {"operatingSystem": "macos", "architecture": "aarch64"}
            or value["runtimeProfile"] != "node-system-libraries-v1"
            or type(value["processProtocol"]) is not int or value["processProtocol"] < 1
            or not isinstance(value["packages"], list) or not 1 <= len(value["packages"]) <= 128):
        fail("Invalid source-owned bundle selection.")
    ids, plugins = set(), set()
    fields = {"id", "displayName", "plugin", "packageDigest", "sourceRepository", "sourceCommit",
              "sdkVersion", "sdkArtifactSha256", "archiveName", "archiveSha256"}
    for pin in value["packages"]:
        if (not isinstance(pin, dict) or set(pin) != fields
                or not isinstance(pin["id"], str) or re.fullmatch("[a-z0-9-]{1,64}", pin["id"]) is None
                or pin["id"] in ids or pin["archiveName"] != pin["id"] + ".tar"
                or not isinstance(pin["plugin"], dict) or set(pin["plugin"]) != {"publisher", "id", "version"}
                or any(not isinstance(v, str) or not v for v in pin["plugin"].values())
                or any(not isinstance(pin[key], str) or re.fullmatch("[a-f0-9]{64}", pin[key]) is None
                       for key in ("packageDigest", "archiveSha256", "sdkArtifactSha256"))
                or not isinstance(pin["sourceCommit"], str) or re.fullmatch("[a-f0-9]{40}", pin["sourceCommit"]) is None
                or not isinstance(pin["sourceRepository"], str) or not pin["sourceRepository"].startswith("https://github.com/")
                or not isinstance(pin["sdkVersion"], str) or not pin["sdkVersion"]):
            fail("Invalid fixed package transport pin.")
        plugin = tuple(sorted(pin["plugin"].items()))
        if plugin in plugins:
            fail("Duplicate fixed package identity.")
        ids.add(pin["id"])
        plugins.add(plugin)
    return value


def unpack(data, pin):
    if sha256(data) != pin["archiveSha256"]:
        fail("Package archive differs from the source-owned transport pin.")
    files, total, folded, spellings = {}, 0, set(), {}
    # Uncompressed deterministic tar is the existing public candidate format.
    # Never call extract/extractall, follow links or interpret executable bytes.
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        for item in archive:
            relative_file(item.name)
            for path in (PurePosixPath(item.name), *PurePosixPath(item.name).parents):
                if str(path) == ".":
                    continue
                spelling = str(path)
                if spellings.setdefault(spelling.lower(), spelling) != spelling:
                    fail("Archive contains case-aliased path components.")
            name = item.name.lower()
            if (not item.isfile() or item.sparse is not None or item.linkname
                    or item.mode & ~0o777 or item.size < 0 or item.size > MAX_BYTES
                    or any(name == old or name.startswith(old + "/") or old.startswith(name + "/") for old in folded)):
                fail("Archive contains links, aliases, overlapping paths or unsupported members.")
            folded.add(name)
            total += item.size
            if len(folded) > MAX_FILES or total > MAX_BYTES:
                fail("Package archive exceeds the fixed limits.")
            if item.name in {"manifest.json", "package-files.json", "sdk/lock.json"} and item.size > MAX_JSON_BYTES:
                fail("Package metadata exceeds its fixed limit.")
            stream = archive.extractfile(item)
            if stream is None:
                fail("Archive member is unreadable.")
            with stream:
                contents = stream.read(item.size + 1)
            if len(contents) != item.size:
                fail("Archive member is incomplete.")
            files[item.name] = (contents, bool(item.mode & 0o111))
    if not {"manifest.json", "package-files.json", "sdk/lock.json"} <= files.keys():
        fail("Archive is missing complete prebuilt package metadata.")
    recipe = json_object(files["package-files.json"][0])
    if (set(recipe) != {"formatVersion", "files", "sdkFiles"}
            or type(recipe["formatVersion"]) is not int or recipe["formatVersion"] != 1
            or not isinstance(recipe["files"], list) or not isinstance(recipe["sdkFiles"], list)):
        fail("Archive has an unsupported prebuilt package recipe.")
    expected = [str(relative_file(name)) for name in recipe["files"]]
    for entry in recipe["sdkFiles"]:
        if not isinstance(entry, dict) or set(entry) != {"source", "target"}:
            fail("Archive has an invalid SDK file recipe.")
        relative_file(entry["source"])
        expected.append(str(relative_file(entry["target"])))
    expected.append("sdk/lock.json")
    if len(set(expected)) != len(expected) or set(expected) != files.keys():
        fail("Archive has missing or extra package files.")
    manifest = json_object(files["manifest.json"][0])
    lock = json_object(files["sdk/lock.json"][0])
    if (manifest.get("plugin") != pin["plugin"] or lock.get("package") != "tsumugi-plugin-sdk"
            or lock.get("version") != pin["sdkVersion"] or lock.get("sha256") != pin["sdkArtifactSha256"]):
        fail("Archive identity or SDK artifact differs from the source-owned selection.")
    return files


def write_file(root, name, data, executable):
    path = relative_file(name)
    held = os.dup(root)
    try:
        for part in path.parts[:-1]:
            try:
                os.mkdir(part, 0o755, dir_fd=held)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=held)
            os.fchmod(child, 0o755)
            os.close(held)
            held = child
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o755 if executable else 0o644, dir_fd=held)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            # Build umask must not make the shipped artifact unreadable to its
            # installing user. Only executable flags affect Host packageDigest.
            os.fchmod(output.fileno(), 0o755 if executable else 0o644)
    finally:
        os.close(held)


def verify_tree(root, expected, extra_depth=0):
    actual, directories = {}, set()
    expected_dirs = {parent.as_posix() for name in expected for parent in PurePosixPath(name).parents
                     if str(parent) != "."}
    def visit(held, prefix, depth):
        if depth > 16 + extra_depth:
            fail("Prepared package exceeds directory limits.")
        for name in os.listdir(held):
            path = prefix + name
            relative_file(path, 16 + extra_depth)
            info = os.stat(name, dir_fd=held, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                directories.add(path)
                if path not in expected_dirs:
                    fail("Prepared package gained an unexpected directory.")
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=held)
                try:
                    visit(child, path + "/", depth + 1)
                finally:
                    os.close(child)
            else:
                if path not in expected:
                    fail("Prepared package gained an unexpected file.")
                actual[path] = capture(held, name, MAX_BYTES)
    visit(root, "", 0)
    if actual != expected or directories != expected_dirs:
        fail("Prepared package bytes, executable flags or paths changed.")


def inspect(executable, package):
    child = subprocess.Popen([str(executable), "inspect", str(package)], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"})
    deadline = time.monotonic() + 60
    buffers = {child.stdout: bytearray(), child.stderr: bytearray()}
    try:
        with selectors.DefaultSelector() as selected:
            for stream in buffers:
                selected.register(stream, selectors.EVENT_READ)
            while selected.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    fail("Host inspection exceeded its deadline.")
                for key, _ in selected.select(remaining):
                    data = os.read(key.fileobj.fileno(), 4096)
                    if not data:
                        selected.unregister(key.fileobj)
                    else:
                        buffers[key.fileobj].extend(data)
                        if len(buffers[key.fileobj]) > 16 * 1024:
                            fail("Host inspection exceeded its output limit.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail("Host inspection exceeded its deadline.")
            try:
                code = child.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                fail("Host inspection exceeded its deadline.")
        if code != 0:
            fail("Host inspection refused the prepared package.")
        return bytes(buffers[child.stdout])
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        child.stdout.close()
        child.stderr.close()


def promote(parent, stage, output):
    # os.rename may replace an existing empty directory. Use the actual platform
    # no-replace operation so a concurrent builder cannot lose its valid output.
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function, flag = library.renameatx_np, 4  # SDK RENAME_EXCL
    elif sys.platform.startswith("linux"):
        function, flag = library.renameat2, 1  # RENAME_NOREPLACE
    else:
        fail("Atomic no-replace preparation is unavailable on this builder.")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(stage, b"payload", parent, os.fsencode(output), flag) != 0:
        raise OSError(ctypes.get_errno(), "Could not promote the complete bundle without replacement.")


def prepare(artifacts, output, inspector, inspector_sha256, *, selection_path=SELECTION, run_inspector=inspect):
    artifacts, output, inspector, selection_path = map(absolute, (artifacts, output, inspector, selection_path))
    if not output.name:
        fail("Select a new named output directory.")
    if re.fullmatch("[a-f0-9]{64}", inspector_sha256) is None:
        fail("Select the explicit SHA-256 of the approved Host inspector.")
    parent = directory(output.parent)
    try:
        try:
            os.stat(output.name, dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            fail("Output already exists; choose a new directory.")
        catalog_fd = archive_fd = inspector_fd = None
        try:
            catalog_fd = directory(selection_path.parent)
            archive_fd = directory(artifacts)
            inspector_fd = directory(inspector.parent)
            catalog_bytes = capture(catalog_fd, selection_path.name, MAX_JSON_BYTES)
            catalog = selection(catalog_bytes[0])
            archives, packages, total = {}, {}, 0
            for pin in catalog["packages"]:
                captured = capture(archive_fd, pin["archiveName"], MAX_ARCHIVE_BYTES)
                files = unpack(captured[0], pin)
                total += sum(len(data) for data, _ in files.values())
                if total > MAX_BYTES:
                    fail("Complete bundle exceeds its fixed byte limit.")
                archives[pin["id"]], packages[pin["id"]] = captured, files
            binary = capture(inspector_fd, inspector.name, MAX_BYTES)
            if not binary[1] or sha256(binary[0]) != inspector_sha256:
                fail("Host inspector differs from its explicit executable pin.")
            stage_name = ".tsumugi-plugins-" + uuid.uuid4().hex
            os.mkdir(stage_name, 0o700, dir_fd=parent)
            stage = os.open(stage_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                os.fchmod(stage, 0o700)
                write_file(stage, "inspector", binary[0], True)
                os.chmod("inspector", 0o500, dir_fd=stage, follow_symlinks=False)
                os.mkdir("payload", 0o755, dir_fd=stage)
                payload = os.open("payload", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=stage)
                try:
                    os.fchmod(payload, 0o755)
                    observations = []
                    for pin in catalog["packages"]:
                        os.mkdir(pin["id"], 0o755, dir_fd=payload)
                        package = os.open(pin["id"], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=payload)
                        try:
                            os.fchmod(package, 0o755)
                            for name, (data, executable) in sorted(packages[pin["id"]].items()):
                                write_file(package, name, data, executable)
                            copied_inspector = output.parent / stage_name / "inspector"
                            if capture(stage, "inspector", MAX_BYTES) != binary:
                                fail("Captured Host inspector changed before use.")
                            observed = json_object(run_inspector(copied_inspector, output.parent / stage_name / "payload" / pin["id"]))
                            expected = {"plugin": pin["plugin"], "packageDigest": pin["packageDigest"],
                                        "manifestSha256": sha256(packages[pin["id"]]["manifest.json"][0]),
                                        "fileCount": len(packages[pin["id"]]),
                                        "byteCount": sum(len(data) for data, _ in packages[pin["id"]].values())}
                            if observed != expected or any(type(observed[key]) is not int for key in ("fileCount", "byteCount")):
                                fail("Host inspection differs from the complete fixed package.")
                            verify_tree(package, packages[pin["id"]])
                            observations.append(observed)
                        finally:
                            os.close(package)
                    # Retain the original selection and exact transport inputs;
                    # changed input paths never silently select another version.
                    if capture(catalog_fd, selection_path.name, MAX_JSON_BYTES) != catalog_bytes:
                        fail("Source-owned selection changed during preparation.")
                    for pin in catalog["packages"]:
                        if capture(archive_fd, pin["archiveName"], MAX_ARCHIVE_BYTES) != archives[pin["id"]]:
                            fail("Package archive changed during preparation.")
                    report = {"formatVersion": 1, "selection": catalog, "inspectorSha256": inspector_sha256,
                              "packages": observations, "publisherAuthentication": "not-performed",
                              "runtimeCompatibility": "not-run", "execution": "not-run"}
                    write_file(payload, "preparation.json", (json.dumps(report, indent=2) + "\n").encode(), False)
                    expected_payload = {"preparation.json": ((json.dumps(report, indent=2) + "\n").encode(), False)}
                    for package_id, files in packages.items():
                        expected_payload.update({package_id + "/" + name: item for name, item in files.items()})
                    # Each package's independent directory/file bounds were
                    # checked above; allow one extra path level for this bundle.
                    verify_tree(payload, expected_payload, extra_depth=1)
                    check_parent = directory(output.parent)
                    try:
                        if (os.fstat(parent).st_dev, os.fstat(parent).st_ino) != (os.fstat(check_parent).st_dev, os.fstat(check_parent).st_ino):
                            fail("Output parent changed during preparation.")
                    finally:
                        os.close(check_parent)
                    for held, owner, name in ((stage, parent, stage_name), (payload, stage, "payload")):
                        observed = os.stat(name, dir_fd=owner, follow_symlinks=False)
                        if (observed.st_dev, observed.st_ino) != (os.fstat(held).st_dev, os.fstat(held).st_ino):
                            fail("Preparation directory changed before promotion.")
                    os.unlink("inspector", dir_fd=stage)
                    promote(parent, stage, output.name)
                finally:
                    os.close(payload)
                # Promotion completed. Cleanup cannot turn a complete output
                # into a reported preparation failure or remove a replacement.
                try:
                    selected_stage = os.stat(stage_name, dir_fd=parent, follow_symlinks=False)
                    if (selected_stage.st_dev, selected_stage.st_ino) != (os.fstat(stage).st_dev, os.fstat(stage).st_ino):
                        raise OSError("staging name changed")
                    os.rmdir(stage_name, dir_fd=parent)
                except OSError:
                    print("Bundle preparation completed; review the retained staging directory before explicit cleanup.", file=sys.stderr)
            finally:
                os.close(stage)
            return report
        finally:
            for held in (inspector_fd, archive_fd, catalog_fd):
                if held is not None:
                    os.close(held)
    finally:
        os.close(parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True, help="existing directory containing the selected local .tar archives")
    parser.add_argument("--inspector", type=Path, required=True, help="explicit approved tsumugi-plugin-package executable")
    parser.add_argument("--inspector-sha256", required=True)
    parser.add_argument("--output", type=Path, required=True, help="new resource directory beneath an existing parent")
    args = parser.parse_args()
    try:
        report = prepare(args.artifacts, args.output, args.inspector, args.inspector_sha256)
        print(json.dumps(report, indent=2))
    except (OSError, ValueError, KeyError, TypeError, tarfile.TarError, AttributeError):
        print("Plugin preparation failed. Review the fixed pins, explicit inputs and any new .tsumugi-plugins-* staging directory. Existing outputs are never replaced; use a new output directory.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
