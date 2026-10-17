from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.catalog import load_catalog


ROOT = Path(__file__).resolve().parents[1]


class CatalogTests(unittest.TestCase):
    def test_governed_catalog_has_twenty_valid_candidates(self):
        catalog = load_catalog(ROOT / "candidates.json")
        self.assertEqual(len(catalog["candidates"]), 20)

    def test_repository_revision_must_be_immutable_commit(self):
        candidate = {
            "id": "moving",
            "name": "Moving ref",
            "adapter": "huggingface-token",
            "license": "Apache-2.0",
            "repository": "example/model",
            "revision": "main",
            "release_eligible": False,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text(json.dumps({"candidates": [candidate]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "immutable"):
                load_catalog(path)

    def test_remote_code_cannot_be_release_eligible(self):
        candidate = {
            "id": "remote",
            "name": "Remote code",
            "adapter": "remote-code-custom",
            "license": "MIT",
            "repository": "example/model",
            "revision": "a" * 40,
            "requires_remote_code": True,
            "release_eligible": True,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text(json.dumps({"candidates": [candidate]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "remote-code"):
                load_catalog(path)


if __name__ == "__main__":
    unittest.main()
