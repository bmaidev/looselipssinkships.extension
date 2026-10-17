import json
import contextlib
import io
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from pii_bench.context_study import run, sha256


class ContextStudyTests(unittest.TestCase):
    def test_retained_evidence_binds_plan_and_never_claims_release_eligibility(self):
        path = Path(__file__).resolve().parents[1] / "evidence/context-results-2026-10-17.json"
        study = json.loads(path.read_text())
        plan = study["locked_plan"]
        encoded = (json.dumps(plan, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode()
        self.assertEqual(hashlib.sha256(encoded).hexdigest(), study["locked_plan_sha256"])
        self.assertFalse(study["release_eligible"])
        for name, points in study["results"].items():
            role, candidate = name.split(":")
            for point, metric in points.items():
                self.assertEqual(metric["evaluation"]["locked_plan_sha256"], study["locked_plan_sha256"])
                self.assertEqual(metric["evaluation"]["declared_dataset_role"], role)
                self.assertEqual(metric["run"]["artifact_sha256"], plan["artifacts"][candidate]["artifact_sha256"])
                self.assertFalse(metric["run"]["release_eligible"])
                threshold = .1 if point == "diagnostic" else plan["calibration"][candidate]["selected"]["threshold"]
                self.assertEqual(metric["evaluation"]["minimum_score"], threshold)

    def test_all_choices_are_locked_before_any_test_predictions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data, output = root / "data", root / "study"
            data.mkdir()
            manifest = {"files": {}}
            for split in ("calibration", "test"):
                path = data / f"{split}.jsonl"
                path.write_text("{}\n")
                manifest["files"][split] = {"sha256": sha256(path)}
            (data / "manifest.json").write_text(json.dumps(manifest))
            candidates = {}
            for name in ("baseline", "new"):
                model = root / name
                model.mkdir()
                (model / "model.onnx").write_bytes(name.encode())
                (model / "tokenizer.json").write_text("{}")
                (model / "onnx-verification.json").write_text(json.dumps({"sha256": sha256(model / "model.onnx")}))
                (model / "training.json").write_text(json.dumps({
                    "weights_sha256": "a" * 64, "training_manifest": {"files": {"train": {"sha256": "b" * 64}}}}))
                candidates[name] = model
            calls = []

            def predict(model, dataset, predictions, *args, **kwargs):
                if dataset.stem == "test":
                    self.assertTrue((output / "locked-plan.json").exists())
                    plan = json.loads((output / "locked-plan.json").read_text())
                    self.assertEqual(set(plan["calibration"]), set(candidates))
                    self.assertTrue(all(item["selected"]["threshold"] == .7 for item in plan["calibration"].values()))
                calls.append(dataset.stem)
                predictions.write_text("{}\n")

            def score(*args, minimum_score, **kwargs):
                return {"run": {}, "evaluation": {"minimum_score": minimum_score}}

            with contextlib.redirect_stdout(io.StringIO()), \
                    patch("pii_bench.context_study.predict_file", side_effect=predict), \
                    patch("pii_bench.context_study.calibrate_threshold", return_value={"feasible": True, "selected": {"threshold": .7}}), \
                    patch("pii_bench.context_study.score_predictions", side_effect=score), \
                    patch("pii_bench.context_study.compare_predictions", return_value={}):
                result = run(data, candidates, output)
            self.assertEqual(calls, ["calibration", "calibration", "test", "test"])
            self.assertFalse(result["release_eligible"])
            self.assertEqual(result["locked_plan_sha256"], sha256(output / "locked-plan.json"))
            self.assertEqual(result["results"]["test:new"]["primary"]["evaluation"]["minimum_score"], .7)
            self.assertEqual(result["results"]["test:new"]["diagnostic"]["evaluation"]["minimum_score"], .1)
            with self.assertRaises(FileExistsError):
                run(data, candidates, output)

    def test_invalid_candidate_names_are_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                run(root, {"../escape": root, "baseline": root}, root / "output")
            self.assertFalse((root / "output").exists())
