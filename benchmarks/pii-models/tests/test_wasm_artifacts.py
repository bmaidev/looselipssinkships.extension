from pathlib import Path
import subprocess
import unittest


class WasmArtifactTests(unittest.TestCase):
    def test_local_model_runtime_integrity_guards(self):
        script = Path(__file__).with_name("check_wasm_artifacts.mjs")
        result = subprocess.run(["node", "--test", str(script)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
