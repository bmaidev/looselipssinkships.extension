"""Training-only literal-span baseline to check whether a neural head adds value."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import time

from .dataset import iter_jsonl


def run(training_path: Path, dataset: Path, output: Path) -> dict:
    counts = defaultdict(Counter)
    for record in iter_jsonl(training_path):
        if record.get("metadata", {}).get("split") != "train":
            raise ValueError("Literal baseline may only learn from training records")
        for span in record["entities"]:
            counts[record["text"][span["start"]:span["end"]].casefold()][span["label"]] += 1
    labels = {value: sorted(votes, key=lambda key: (-votes[key], key))[0] for value, votes in counts.items()}
    if not labels:
        raise ValueError("Training set has no positive spans")
    ordered = sorted(labels, key=lambda value: (-len(value), value))
    pattern = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(value) for value in ordered) + r")(?!\w)", re.IGNORECASE)

    def match_label(match):
        folded = match.group().casefold()
        if folded in labels:
            return labels[folded]
        # Python's Unicode IGNORECASE also matches dotted/dotless I, whose
        # casefolded strings need not be identical. Keep the common path fast.
        for value in ordered:
            if re.fullmatch(re.escape(value), match.group(), re.IGNORECASE):
                return labels[value]
        raise ValueError("Literal match cannot be mapped back to its training value")
    metadata = {"candidate_id": "psi-training-literal-control", "release_eligible": False,
                "adapter": "literal-research-control", "training_values": len(labels),
                "training_sha256": hashlib.sha256(training_path.read_bytes()).hexdigest(),
                "dataset_sha256": hashlib.sha256(dataset.read_bytes()).hexdigest(),
                "artifact_mb": len(json.dumps(labels).encode()) / 1_000_000}
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    count = 0
    with output.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps({"_meta": metadata}) + "\n")
        for record in iter_jsonl(dataset):
            begin = time.perf_counter()
            spans = [{"start": match.start(), "end": match.end(), "label": match_label(match), "score": 1}
                     for match in pattern.finditer(record["text"])]
            handle.write(json.dumps({"id": record["id"], "spans": spans,
                                     "latency_ms": (time.perf_counter() - begin) * 1000}) + "\n")
            count += 1
        handle.write(json.dumps({"_summary": {"prediction_records": count,
                                               "prediction_elapsed_ms": (time.perf_counter() - started) * 1000}}) + "\n")
    return metadata


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--training", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.training, args.dataset, args.output), indent=2))
