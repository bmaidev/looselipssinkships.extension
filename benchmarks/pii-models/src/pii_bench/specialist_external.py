"""Prepare a document-disjoint Nemotron curriculum for four contextual PSI labels.

The source is CC-BY-4.0, authored by NVIDIA. Revision is immutable. Only explicit
source labels are mapped; other sensitive categories are not claimed as covered.
"""

from __future__ import annotations

import argparse
import ast
from collections import Counter
import hashlib
import json
from pathlib import Path

from .dataset import iter_jsonl, validate_record
from .specialist import tokens
from .taxonomy import family_for, risk_for


SOURCE_REVISION = "b70ffaf5ff39e079776134c5bf4381f00a9fd1ed"
SOURCE_MAP = {"race_ethnicity": "RACE_ETHNICITY", "religious_belief": "RELIGION",
              "political_view": "POLITICAL_AFFILIATION", "sexuality": "SEXUAL_ORIENTATION"}


def prepare(train_parquet: Path, test_parquet: Path, curriculum: Path, output: Path,
            train_limit: int = 12000, eval_limit: int = 1500, test_offset: int = 0,
            exclude_evaluation: Path | None = None) -> dict:
    import pyarrow.parquet as pq

    if train_limit < 1 or eval_limit < 1 or test_offset < 0:
        raise ValueError("Sample limits must be positive and test offset nonnegative")
    output.mkdir(parents=True, exist_ok=True)
    by_split = {split: [] for split in ("train", "calibration", "test")}
    seen = set()
    training_source_uids = set()
    excluded_uids = ({record["metadata"]["source_uid"] for record in iter_jsonl(exclude_evaluation)}
                     if exclude_evaluation else set())
    rejected = Counter()
    source_labels = Counter()
    for source_split, path in (("train", train_parquet), ("test", test_parquet)):
        for batch in pq.ParquetFile(path).iter_batches(batch_size=512):
            for item in batch.to_pylist():
                if source_split == "train":
                    training_source_uids.add(item["uid"])
                elif item["uid"] in training_source_uids:
                    rejected["test_uid_also_present_in_source_training"] += 1
                    continue
                if source_split == "test" and item["uid"] in excluded_uids:
                    rejected["source_uid_reserved_for_prior_evaluation"] += 1
                    continue
                text = item["text"]
                digest = hashlib.sha256(" ".join(text.casefold().split()).encode()).hexdigest()
                if digest in seen:
                    rejected["duplicate_document"] += 1
                    continue
                seen.add(digest)
                raw_spans = ast.literal_eval(item["spans"]) if isinstance(item["spans"], str) else item["spans"]
                source_labels.update(span["label"] for span in raw_spans)
                selected = [span for span in raw_spans if span["label"] in SOURCE_MAP]
                if any(not 0 <= span["start"] < span["end"] <= len(text)
                       or text[span["start"]:span["end"]].casefold() != span["text"].casefold()
                       for span in selected):
                    rejected["bad_source_offsets"] += 1
                    continue
                # The source training shard supplies training and calibration.
                # Its test shard is never mixed into either partition.
                uid_digest = hashlib.sha256(item["uid"].encode()).hexdigest()
                split = "test" if source_split == "test" else (
                    "calibration" if int(uid_digest[:8], 16) % 5 == 0 else "train")
                # Retain a deterministic fraction of negatives; never assign a
                # label from dictionary matches or from an evaluated model.
                if not selected and int(digest[8:16], 16) % 10:
                    continue
                pieces = tokens(text)
                if not pieces:
                    continue
                centre = selected[0]["start"] if selected else 0
                centre_index = next((index for index, (_, _, end) in enumerate(pieces) if end > centre), 0)
                low = max(0, centre_index - 32)
                high = min(len(pieces), low + 96)
                start, end = pieces[low][1], pieces[high - 1][2]
                if any(span["start"] < start < span["end"] or span["start"] < end < span["end"] for span in selected):
                    rejected["window_bisects_entity"] += 1
                    continue
                entities = [{"start": span["start"] - start, "end": span["end"] - start,
                             "label": SOURCE_MAP[span["label"]],
                             "family": family_for(SOURCE_MAP[span["label"]]),
                             "risk": risk_for(SOURCE_MAP[span["label"]])}
                            for span in selected if start <= span["start"] and span["end"] <= end]
                record = {"id": f"nemotron-psi-{source_split}-{item['uid']}-{digest[:16]}",
                          "text": text[start:end], "entities": sorted(entities, key=lambda span: span["start"]),
                          "domain": item["domain"], "language": "en",
                          "slices": ["external", "psi" if entities else "negative", f"source:{source_split}"],
                          "metadata": {"synthetic": True, "source": "nvidia/Nemotron-PII",
                                       "revision": SOURCE_REVISION, "source_split": source_split,
                                       "source_uid": item["uid"], "source_text_sha256": digest,
                                       "source_window": [start, end], "split": split,
                                       "annotation_scope": "four explicitly mapped sensitive attributes only"}}
                try:
                    validate_record(record)
                except ValueError:
                    rejected["invalid_or_overlapping_spans"] += 1
                    continue
                by_split[split].append(record)
    manifest = {"source": "https://huggingface.co/datasets/nvidia/Nemotron-PII",
                "author": "NVIDIA", "license": "CC-BY-4.0", "revision": SOURCE_REVISION,
                "label_map": SOURCE_MAP, "test_offset": test_offset,
                "excluded_evaluation_sha256": hashlib.sha256(exclude_evaluation.read_bytes()).hexdigest() if exclude_evaluation else None,
                "rejected": dict(rejected), "source_labels": dict(source_labels),
                "files": {}, "curriculum_parent": json.loads((curriculum / "manifest.json").read_text())}
    # Exclude duplicate rendered windows across source documents and splits too.
    seen_windows = set()
    for split, records in by_split.items():
        records.sort(key=lambda record: hashlib.sha256(record["id"].encode()).hexdigest())
        limit = train_limit if split == "train" else eval_limit
        sampled = []
        skipped = 0
        for record in records:
            key = " ".join(record["text"].casefold().split())
            if key in seen_windows:
                continue
            seen_windows.add(key)
            if split == "test" and skipped < test_offset:
                skipped += 1
                continue
            sampled.append(record)
            if len(sampled) >= limit:
                break
        # Keep the independent authored training/calibration examples for the
        # remaining labels; external test evaluation contains only external rows.
        if split != "test":
            sampled.extend(iter_jsonl(curriculum / f"{split}.jsonl"))
        digest = hashlib.sha256()
        counts = Counter()
        with (output / f"{split}.jsonl").open("wb") as handle:
            for record in sampled:
                data = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
                digest.update(data)
                handle.write(data)
                counts.update(span["label"] for span in record["entities"])
        manifest["files"][split] = {"records": len(sampled), "sha256": digest.hexdigest(), "labels": dict(counts)}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-parquet", type=Path, required=True)
    parser.add_argument("--test-parquet", type=Path, required=True)
    parser.add_argument("--curriculum", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--train-limit", type=int, default=4000)
    parser.add_argument("--eval-limit", type=int, default=1500)
    parser.add_argument("--test-offset", type=int, default=0)
    parser.add_argument("--exclude-evaluation", type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.train_parquet, args.test_parquet, args.curriculum, args.output,
                             args.train_limit, args.eval_limit, args.test_offset, args.exclude_evaluation), indent=2))
