from __future__ import annotations

from pathlib import Path
import unittest

from pii_bench.adapters import ExtensionAdapter


BENCHMARK_ROOT = Path(__file__).resolve().parents[1]


class ExtensionAdapterTests(unittest.TestCase):
    def test_executes_production_regex_with_original_offsets(self):
        adapter = ExtensionAdapter(BENCHMARK_ROOT, "regex")
        try:
            text = "🔒 Email test.person@example.com now"
            spans = adapter.predict(text, "sample")
            email = next(span for span in spans if span["label"] == "EMAIL")
            self.assertEqual(text[email["start"] : email["end"]], "test.person@example.com")
        finally:
            adapter.close()

    def test_hybrid_adds_name_detection(self):
        adapter = ExtensionAdapter(BENCHMARK_ROOT, "hybrid")
        try:
            spans = adapter.predict("Dear John Smith, welcome.", "sample")
            self.assertTrue(any(span["label"] == "PERSON" for span in spans))
        finally:
            adapter.close()


if __name__ == "__main__":
    unittest.main()
