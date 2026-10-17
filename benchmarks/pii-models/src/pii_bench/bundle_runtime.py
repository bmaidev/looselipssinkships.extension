"""Bind an isolated reduced runtime build to its source, SDK and build evidence.

This bundles research artifacts, never the live extension. Build settings do not
prove privacy, browser compatibility, model parity or supply-chain certification.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess

from .minimal_runtime import RUNTIME_VERSION, SDK_REVISION, SOURCE_REVISION, digest


REQUIRED_FLAGS = {
    "onnxruntime_MINIMAL_BUILD": "ON", "onnxruntime_REDUCED_OPS_BUILD": "ON",
    "onnxruntime_USE_TELEMETRY": "OFF", "onnxruntime_MINIMAL_BUILD_CUSTOM_OPS": "OFF",
    "onnxruntime_ENABLE_WEBASSEMBLY_SIMD": "ON", "onnxruntime_ENABLE_WEBASSEMBLY_THREADS": "ON",
    "onnxruntime_ENABLE_WEBASSEMBLY_PROFILING": "OFF",
}


def read_flags(path: Path) -> dict:
    result = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith(("#", "//")) or "=" not in line or ":" not in line.split("=", 1)[0]:
            continue
        key, value = line.split("=", 1)
        result[key.split(":", 1)[0]] = value
    for name, expected in REQUIRED_FLAGS.items():
        if result.get(name) != expected:
            raise ValueError(f"Unverified build flag {name}: expected {expected}, got {result.get(name)}")
    return result


def checked_revision(directory: Path, expected: str) -> str:
    actual = subprocess.check_output(["git", "-C", str(directory), "rev-parse", "HEAD"], text=True).strip()
    if actual != expected:
        raise ValueError(f"Unexpected source revision in {directory.name}")
    subprocess.run(["git", "-C", str(directory), "diff", "--quiet", "HEAD", "--"], check=True)
    return actual


def bundle(source: Path, build: Path, operator_config: Path, output: Path) -> dict:
    if output.exists() and any(output.iterdir()):
        raise FileExistsError("Use a fresh runtime bundle directory")
    checked_revision(source, SOURCE_REVISION)
    checked_revision(source / "cmake/external/emsdk", SDK_REVISION)
    scope = source / "package.json"
    if scope.exists() and json.loads(scope.read_text()) != {"private": True, "type": "commonjs"}:
        raise ValueError("Unreviewed upstream Node package-scope override")
    cache = build / "CMakeCache.txt"
    flags = read_flags(cache)
    names = ("ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm")
    for name in names:
        if not (build / name).is_file():
            raise FileNotFoundError(f"Build has no completed {name}")
    with (build / names[1]).open("rb") as handle:
        if handle.read(8) != b"\x00asm\x01\x00\x00\x00":
            raise ValueError("Build output is not a WASM version-1 binary")
    generated = build / "op_reduction.generated"
    registrations = {str(path.relative_to(generated)): digest(path)
                     for path in sorted(generated.rglob("*")) if path.is_file()}
    if not registrations:
        raise ValueError("Build has no operator-reduction evidence")
    result = {"schema_version": 1, "release_eligible": False, "runtime_version": RUNTIME_VERSION,
              "source_revision": SOURCE_REVISION, "sdk_revision": SDK_REVISION,
              "minimal_build": True, "telemetry_disabled": True,
              "cmake_cache_sha256": digest(cache), "build_type": flags.get("CMAKE_BUILD_TYPE"),
              "compiler_flags": {name: flags.get(name) for name in ("CMAKE_CXX_FLAGS_MINSIZEREL", "CMAKE_C_FLAGS_MINSIZEREL")},
              "supplied_operator_config_sha256": digest(operator_config),
              "upstream_dependency_manifest_sha256": digest(source / "cmake/deps.txt"),
              "node_package_scope_override_sha256": digest(scope) if scope.exists() else None,
              "generated_registration_sha256": registrations,
              "verified_cmake_flags": {name: flags[name] for name in REQUIRED_FLAGS},
              "files": {name: {"sha256": digest(build / name), "bytes": (build / name).stat().st_size} for name in names},
              "limitations": "Research-only compiled artifacts; settings are not privacy certification. Same-version WASM parity and exact-package browser tests still required."}
    output.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copyfile(build / name, output / name)
    shutil.copyfile(operator_config, output / "required-operators.config")
    (output / "runtime.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--build", type=Path, required=True, help="Configured build directory containing CMakeCache.txt")
    parser.add_argument("--operator-config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(bundle(args.source, args.build, args.operator_config, args.output), indent=2))
