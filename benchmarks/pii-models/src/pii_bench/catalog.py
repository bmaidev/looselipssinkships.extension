from __future__ import annotations

import json
from pathlib import Path
import re


COMMIT_SHA = re.compile(r"[0-9a-f]{40}")


def load_catalog(path: Path, *, allow_moving_revision: bool = False) -> dict:
    catalog = json.loads(path.read_text(encoding="utf-8"))
    candidates = catalog.get("candidates", [])
    ids = [candidate.get("id") for candidate in candidates]
    if not candidates or any(not candidate_id for candidate_id in ids):
        raise ValueError("Candidate catalog is empty or contains an item without an ID")
    if len(ids) != len(set(ids)):
        raise ValueError("Candidate catalog contains duplicate IDs")
    for candidate in candidates:
        candidate_id = candidate["id"]
        if not candidate.get("name") or not candidate.get("adapter") or not candidate.get("license"):
            raise ValueError(f"{candidate_id}: name, adapter, and license are required")
        if (
            candidate.get("repository")
            and not allow_moving_revision
            and not COMMIT_SHA.fullmatch(str(candidate.get("revision", "")))
        ):
            raise ValueError(f"{candidate_id}: repository candidates require an immutable 40-character commit SHA")
        artifact_mb = candidate.get("artifact_mb")
        if artifact_mb is not None and float(artifact_mb) < 0:
            raise ValueError(f"{candidate_id}: artifact_mb cannot be negative")
        threshold = candidate.get("threshold")
        if threshold is not None and not 0 <= float(threshold) <= 1:
            raise ValueError(f"{candidate_id}: threshold must be between 0 and 1")
        if candidate.get("requires_remote_code") and candidate.get("release_eligible") is True:
            raise ValueError(f"{candidate_id}: remote-code candidates cannot be release eligible")
        if candidate.get("adapter") == "screened-out" and candidate.get("release_eligible") is not False:
            raise ValueError(f"{candidate_id}: screened-out candidates cannot be release eligible")
    return catalog


def candidate_by_id(catalog: dict, candidate_id: str) -> dict:
    for candidate in catalog["candidates"]:
        if candidate["id"] == candidate_id:
            return candidate
    raise ValueError(f"Unknown candidate: {candidate_id}")


def runnable_candidates(catalog: dict) -> list[dict]:
    supported = {"extension", "transformers-js", "onnx-token", "huggingface-token", "gliner", "presidio"}
    return [candidate for candidate in catalog["candidates"] if candidate["adapter"] in supported]


def validate_for_run(candidate: dict, allow_moving_revision: bool) -> None:
    if candidate.get("repository") and not candidate.get("revision") and not allow_moving_revision:
        raise ValueError(
            f"{candidate['id']} has no immutable revision. Resolve and record a commit SHA, "
            "or use --allow-moving-revision for an explicitly exploratory run."
        )
