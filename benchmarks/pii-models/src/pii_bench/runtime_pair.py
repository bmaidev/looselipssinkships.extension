"""Compare runtime outputs without treating confidence drift as exact parity."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .metrics import compare_predictions, score_predictions, write_json
from .minimal_runtime import digest


def compare_spans(first: Path, second: Path) -> dict:
    def load(path: Path) -> dict:
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        records = [row for row in rows if "_meta" not in row and "_summary" not in row]
        indexed = {row["id"]: row["spans"] for row in records}
        if len(indexed) != len(records):
            raise ValueError("Duplicate prediction IDs")
        return indexed

    a, b = load(first), load(second)
    if set(a) != set(b):
        raise ValueError("Prediction ID sets differ")
    def boundaries(spans: list, threshold: float = 0) -> list:
        return sorted((s["start"], s["end"], s["label"]) for s in spans if s.get("score", 1) >= threshold)

    same_boundaries = all(boundaries(a[key]) == boundaries(b[key]) for key in a)
    maximum = None
    if same_boundaries:
        sort_key = lambda span: (span["start"], span["end"], span["label"])
        maximum = max((abs(x.get("score", 1) - y.get("score", 1)) for key in a
                       for x, y in zip(sorted(a[key], key=sort_key), sorted(b[key], key=sort_key))), default=0)
    return {"records": len(a), "same_ids": True,
            "same_span_boundaries_and_labels_all_records": same_boundaries,
            "exact_span_and_score_match_records": sum(a[key] == b[key] for key in a),
            "maximum_aligned_score_difference": maximum,
            "differing_records_at_thresholds": {
                str(t): sum(boundaries(a[key], t) != boundaries(b[key], t) for key in a)
                for t in (.1, .3, .5, .7, .9, .95, .99)}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("dataset", "first", "second", "output"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a fresh evidence output")
    result = {"release_eligible": False, "scope": "Paired Node/WASM research; not browser release evidence",
              "inputs_sha256": {name: digest(getattr(args, name)) for name in ("dataset", "first", "second")},
              "span_parity": compare_spans(args.first, args.second),
              "scores": {name: score_predictions(args.dataset, getattr(args, name),
                          minimum_score=.1, bootstrap_rounds=1000) for name in ("first", "second")},
              "paired": compare_predictions(args.dataset, args.first, args.second,
                          first_minimum_score=.1, second_minimum_score=.1, rounds=1000)}
    write_json(args.output, result)
    print(json.dumps(result["span_parity"], indent=2))


if __name__ == "__main__":
    main()
