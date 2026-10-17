"""Lock calibration choices before evaluating a separate contextual PSI test file.

All candidates and both operating points are retained, including failures. The
fixed low threshold is diagnostic only. No result from this authored study can
authorise production promotion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from .metrics import calibrate_threshold, compare_predictions, score_predictions, write_json
from .specialist import predict_file
from .tiny_finetune import TinyPredictor


THRESHOLDS = (.1, .3, .5, .7, .9, .95, .99)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(data: Path, candidates: dict[str, Path], output: Path, regression: Path | None = None) -> dict:
    if len(candidates) < 2 or any(not name or not name.replace("-", "").isalnum() for name in candidates):
        raise ValueError("Provide at least two uniquely named candidates with alphanumeric/hyphen names")
    if output.exists() and any(output.iterdir()):
        raise FileExistsError("Study output must be fresh; retained evidence cannot be overwritten")
    manifest = json.loads((data / "manifest.json").read_text())
    for split in ("calibration", "test"):
        if sha256(data / f"{split}.jsonl") != manifest["files"][split]["sha256"]:
            raise ValueError(f"{split} checksum mismatch")
    output.mkdir(parents=True, exist_ok=True)
    calibrations, artifacts = {}, {}
    for name, directory in candidates.items():
        verification = json.loads((directory / "onnx-verification.json").read_text())
        artifact = sha256(directory / "model.onnx")
        if artifact != verification["sha256"]:
            raise ValueError(f"{name} graph checksum mismatch")
        metadata = json.loads((directory / "training.json").read_text())
        artifacts[name] = {"artifact_sha256": artifact, "tokenizer_sha256": sha256(directory / "tokenizer.json"),
                           "weights_sha256": metadata["weights_sha256"], "label_scheme": metadata.get("label_scheme", "typed"),
                           "artifact_bytes": (directory / "model.onnx").stat().st_size,
                           "training": {key: metadata.get(key) for key in ("selected_epoch", "history", "training_seconds",
                                                                        "training_parameters", "trainer_sha256", "repository", "revision")},
                           "training_dataset_sha256": metadata["training_manifest"]["files"]["train"]["sha256"]}
        predictions = output / f"{name}.calibration.predictions.jsonl"
        predict_file(directory, data / "calibration.jsonl", predictions, "onnx", predictor_factory=TinyPredictor)
        calibration = calibrate_threshold(data / "calibration.jsonl", predictions,
                                          thresholds=THRESHOLDS, calibration_partition="all")
        calibrations[name] = calibration
        write_json(output / f"{name}.calibration.json", calibration)
    plan = {"schema_version": 1, "release_eligible": False, "artifacts": artifacts,
            "calibration_sha256": manifest["files"]["calibration"]["sha256"],
            "test_sha256": manifest["files"]["test"]["sha256"],
            "regression_sha256": sha256(regression) if regression else None,
            "threshold_grid": THRESHOLDS, "calibration": calibrations,
            "calibration_prediction_sha256": {name: sha256(output / f"{name}.calibration.predictions.jsonl") for name in candidates},
            "study_code_sha256": sha256(Path(__file__)),
            "operating_points": {"primary": "utility-constrained threshold per candidate, or absent if infeasible",
                                 "diagnostic": "fixed 0.1; not eligible for promotion"},
            "limitations": "Authored synthetic transfer; only 15 PSI labels, names unscored. Regression data previously viewed. Native timings are not browser evidence."}
    # This write occurs before any test prediction or test scoring call.
    locked = output / "locked-plan.json"
    write_json(locked, plan)
    print(json.dumps({"locked_plan_sha256": sha256(locked), "thresholds": {
        name: selection["selected"]["threshold"] if selection["feasible"] else None
        for name, selection in calibrations.items()}}), flush=True)
    results, paired = {}, {}
    for dataset_name, dataset in (("test", data / "test.jsonl"), ("regression", regression)):
        if dataset is None:
            continue
        for name, directory in candidates.items():
            predictions = output / f"{name}.{dataset_name}.predictions.jsonl"
            predict_file(directory, dataset, predictions, "onnx", predictor_factory=TinyPredictor)
            points = {"diagnostic": .1}
            if calibrations[name]["feasible"]:
                points["primary"] = calibrations[name]["selected"]["threshold"]
            results[f"{dataset_name}:{name}"] = {}
            for point, threshold in points.items():
                metrics = score_predictions(dataset, predictions, minimum_score=threshold, bootstrap_rounds=1000)
                metrics["run"]["prediction_sha256"] = sha256(predictions)
                metrics["evaluation"]["declared_dataset_role"] = dataset_name
                metrics["evaluation"]["locked_plan_sha256"] = sha256(locked)
                write_json(output / f"{name}.{dataset_name}.{point}.metrics.json", metrics)
                results[f"{dataset_name}:{name}"][point] = metrics
        baseline = next(iter(candidates))
        for name in list(candidates)[1:]:
            for point in ("primary", "diagnostic"):
                if any(point not in results[f"{dataset_name}:{member}"] for member in (baseline, name)):
                    continue
                difference = compare_predictions(
                    dataset, output / f"{baseline}.{dataset_name}.predictions.jsonl", output / f"{name}.{dataset_name}.predictions.jsonl",
                    first_minimum_score=results[f"{dataset_name}:{baseline}"][point]["evaluation"]["minimum_score"],
                    second_minimum_score=results[f"{dataset_name}:{name}"][point]["evaluation"]["minimum_score"], rounds=1000)
                paired[f"{dataset_name}:{name}-vs-{baseline}:{point}"] = difference
    study = {"schema_version": 1, "release_eligible": False, "locked_plan": plan,
             "locked_plan_sha256": sha256(locked), "manifest": manifest, "results": results, "paired": paired}
    write_json(output / "study.json", study)
    return study


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--candidate", action="append", required=True, help="NAME=MODEL_DIRECTORY; first is the baseline")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--regression", type=Path)
    args = parser.parse_args()
    pairs = [item.split("=", 1) for item in args.candidate]
    if any(len(pair) != 2 for pair in pairs) or len({pair[0] for pair in pairs}) != len(pairs):
        parser.error("Candidates must have distinct NAME=MODEL_DIRECTORY specifications")
    result = run(args.data, {name: Path(directory) for name, directory in pairs}, args.output, args.regression)
    print(json.dumps({"study_sha256": sha256(args.output / "study.json"), "results": {
        key: {point: {"recall": metric["safety"]["weighted_recall"],
                      "clean_negative_rate": metric["utility"]["clean_negative_document_rate"],
                      "over_redaction_rate": metric["utility"]["over_redaction_rate"]}
              for point, metric in values.items()} for key, values in result["results"].items()}}, indent=2))
