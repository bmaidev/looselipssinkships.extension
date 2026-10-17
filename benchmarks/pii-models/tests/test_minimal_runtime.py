import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.bundle_runtime import REQUIRED_FLAGS, read_flags
from pii_bench.minimal_runtime import prepare


class MinimalRuntimeTests(unittest.TestCase):
    def test_missing_or_unsafe_build_flags_never_attest_a_safe_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "CMakeCache.txt"
            for missing in (None, *REQUIRED_FLAGS):
                rows = {name: value for name, value in REQUIRED_FLAGS.items() if name != missing}
                path.write_text("\n".join(f"{name}:BOOL={value}" for name, value in rows.items()))
                if missing is None:
                    self.assertEqual(read_flags(path), rows)
                else:
                    with self.assertRaisesRegex(ValueError, "build flag"):
                        read_flags(path)
            rows = {**REQUIRED_FLAGS, "onnxruntime_USE_TELEMETRY": "ON"}
            path.write_text("\n".join(f"{name}:BOOL={value}" for name, value in rows.items()))
            with self.assertRaises(ValueError):
                read_flags(path)

    def test_conversion_rejects_overwrites_and_corrupt_graph_before_optional_imports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source", root / "output"
            source.mkdir()
            output.mkdir()
            (output / "evidence.json").write_text("{}")
            with self.assertRaises(FileExistsError):
                prepare(source, output)
            (source / "model.onnx").write_bytes(b"corrupt")
            (source / "onnx-verification.json").write_text(json.dumps({"sha256": "a" * 64}))
            with self.assertRaisesRegex(ValueError, "checksum"):
                prepare(source, root / "fresh")
