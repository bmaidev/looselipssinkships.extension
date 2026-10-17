"""Authored counterfactual PSI curriculum; no model-generated gold labels.

Each scenario pairs identical attribute vocabulary in person-linked and public
contexts. Mixed documents repeat the attribute twice but label only its personal
occurrence. Names are deliberately unscored: this is a PSI-only experiment.
Grammar/value/name banks are partitioned before rendering. Shared authorship and
synthetic scaffolding mean this is a transfer test, not release confirmation.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import random

from .dataset import iter_jsonl, validate_record
from .specialist_data import PHRASES
from .taxonomy import family_for, risk_for


VERSION = "psi-context-counterfactual-v2"
# Fresh authored vocabulary. First two calibrate, last two test. These are not
# guaranteed absent from pretrained weights or the external training corpus.
HELD_VALUES = {
    "HEALTH_CONDITION": ["chronic migraine", "ankylosing spondylitis", "pulmonary fibrosis", "myasthenia gravis"],
    "MEDICATION": ["bisoprolol", "lamotrigine", "apixaban", "levothyroxine"],
    "DISABILITY": ["a visual processing disability", "a permanent speech impairment", "a physical disability", "a psychosocial disability"],
    "MENTAL_HEALTH": ["generalised anxiety disorder", "bipolar II disorder", "borderline personality disorder", "postnatal depression"],
    "GENETIC_INFO": ["a pathogenic ATM variant", "a hereditary RET mutation", "a pathogenic MSH6 variant", "a familial MYH7 mutation"],
    "RACE_ETHNICITY": ["Hmong", "Amazigh", "Romani", "Tigrayan"],
    "RELIGION": ["Unitarian", "Coptic Christian", "Shinto", "Taoist"],
    "POLITICAL_AFFILIATION": ["a regional political party treasurer", "an antiwar campaign member", "a social democratic party donor", "a rural political movement organiser"],
    "TRADE_UNION": ["the Community and Public Sector Union", "the Australian Manufacturing Workers Union", "the National Tertiary Education Union", "the Australian Nursing and Midwifery Federation"],
    "SEXUAL_ORIENTATION": ["bisexual", "lesbian", "omnisexual", "androsexual"],
    "CRIMINAL_RECORD": ["a prior perjury conviction", "a pending embezzlement charge", "a stalking conviction", "an aggravated burglary charge"],
    "VICTIM_SAFEGUARDING": ["receiving confidential stalking support", "in a protected relocation programme", "escaping coercive control", "living in a family violence refuge"],
    "FINANCIAL_HARDSHIP": ["unable to afford school meals", "in rent arrears", "facing disconnection for unpaid gas bills", "unable to pay for transport to appointments"],
    "INCOME": ["a monthly income of $2146", "a weekly pension of $537", "an annual wage of $41980", "a fortnightly benefit of $862"],
    "CHILD_STATUS": ["a child under an interim care order", "a minor in supported accommodation", "a child in emergency foster placement", "a minor awaiting a guardianship hearing"],
}

# The presence of a person's name or the word "public" must not be sufficient:
# both occur in positive and negative examples. Denials and historical records
# about a specified person remain sensitive under this conservative gold policy.
GRAMMARS = {
    "train": {
        "personal": [
            "{name}'s intake response: {value}.",
            "{name} told the worker about {value}.",
            "Update the individual assessment for {name}: {value}.",
            "{name} said, 'This concerns me personally: {value}.'",
            "The case notes associate {name} with {value}.",
            "Recorded against client {name}: {value}.",
            "{name} asked us to remove {value} from their personal file.",
            "Historical information about {name}: {value}.",
            "{name} denies the entry about {value} in their record.",
            "{name}'s circumstances include {value}.",
            "Do not share {name}'s disclosure of {value}.",
            "In the public hearing, {name} disclosed {value} about themself.",
            "The applicant {name} ticked the option '{value}'.",
            "{name} wrote {value} on their own assessment form.",
            "{name} asked for personal assistance concerning {value}.",
            "The answer given by {name} was {value}.",
        ],
        "public": [
            "{name} wrote a general guide explaining {value}.",
            "Training plan for {name}: read the textbook entry on {value}.",
            "{name} asked whether our public resources cover {value}.",
            "The presenter {name} defined {value}; no personal history was discussed.",
            "{name} reviewed the bibliography for an article on {value}.",
            "Glossary editor: {name}. Entry to check: {value}.",
            "{name} requested anonymous statistics about {value}.",
            "{name} is compiling a public reading list about {value}.",
            "The fictional novel recommended by {name} mentions {value}.",
            "The lesson prepared by {name} describes {value} in general terms.",
            "{name} corrected the spelling of {value} in the dictionary.",
            "Policy workshop facilitated by {name}: general discussion of {value}.",
            "The question from {name} concerned the definition of {value}, not an individual.",
            "{name} translated an educational leaflet about {value}.",
            "Search query entered by librarian {name}: reference books on {value}.",
            "{name} labelled the reference shelf '{value}'.",
        ],
    },
    "calibration": {
        "personal": [
            "The handover identifies {name}'s personal situation as {value}.",
            "Attribute recorded for the individual {name}: {value}.",
            "{name} objected to their record revealing {value}.",
            "{name} confirmed that {value} applied to them last year.",
            "Case review concerning {name}; disclosed information: {value}.",
            "Public testimony by {name} about their own {value}.",
        ],
        "public": [
            "{name} catalogued an open educational resource discussing {value}.",
            "Webinar host {name} introduced a theoretical discussion of {value}.",
            "{name} asked for a definition of the phrase {value}.",
            "Study notes authored by {name} explain the concept {value}.",
            "{name} checked a fictional script containing the expression {value}.",
            "{name} selected {value} as a generic seminar topic, without naming a subject.",
        ],
    },
    "test": {
        "personal": [
            "For the assigned adviser: {name} reported {value} in their own circumstances.",
            "The entry in {name}'s individual profile reads '{value}'.",
            "{name} disputes our earlier statement that they have {value}.",
            "At the open meeting, {name} revealed their personal experience of {value}.",
            "The person seeking help, {name}, described {value} as part of their history.",
            "A note specifically about {name}, not general training: {value}.",
        ],
        "public": [
            "{name} proofread a reference chapter whose subject is {value}.",
            "A museum display curated by {name} explains {value} without discussing any visitor.",
            "{name}'s lecture slides give a general explanation of {value}.",
            "{name} compared dictionary descriptions of {value} for a language exercise.",
            "A hypothetical exercise distributed by {name} asks students to define {value}.",
            "{name} supplied the publisher with a subject heading: {value}.",
        ],
    },
}
NAMES = {
    "train": ["Asha Example", "Louis Sample", "Noura Fiction", "Étienne Demo", "Mika Test", "Sam Placeholder", "王示例", "Sofía Example"],
    "calibration": ["Dalia Sample", "Ewan Fiction", "Noémie Test", "Ren Example"],
    "test": ["Inez Placeholder", "Omar Demo", "Léonie Sample", "陳範例"],
}
PREFIXES = ("", "Case management\n", "Meeting notes\n", "📝 Worker handover\n", "Referral review\n", "Service desk\n")


def records(split: str, pairs: int, seed: int = 20261019):
    if split not in GRAMMARS or pairs < 1:
        raise ValueError("Expected a known split and positive pair count")
    rng = random.Random(f"{VERSION}:{seed}:{split}")
    labels = list(PHRASES)
    seen = set()
    emitted = 0
    for attempt in range(pairs * 100):
        label = labels[emitted % len(labels)]
        values = PHRASES[label][:8] if split == "train" else HELD_VALUES[label][:2] if split == "calibration" else HELD_VALUES[label][2:]
        value = rng.choice(values)
        name = rng.choice(NAMES[split])
        personal = rng.choice(GRAMMARS[split]["personal"]).format(name=name, value="⟦TARGET⟧")
        public = rng.choice(GRAMMARS[split]["public"]).format(name=name, value=value)
        prefix = rng.choice(PREFIXES)
        # Expose the same attribute in a public and personal clause in half the
        # positives; both orders occur. The paired negative has no personal clause.
        mixed = emitted % 2 == 0
        if mixed:
            public_second = rng.choice(GRAMMARS[split]["public"]).format(name=name, value=value)
            if emitted % 4 == 0:
                positive, negative = public + "\n" + personal, public + "\n" + public_second
            else:
                positive, negative = personal + "\n" + public, public_second + "\n" + public
        else:
            positive, negative = personal, public
        positive, negative = prefix + positive, prefix + negative
        start = positive.index("⟦TARGET⟧")
        positive = positive.replace("⟦TARGET⟧", value)
        normalized = [" ".join(text.casefold().split()) for text in (positive, negative)]
        if any(text in seen for text in normalized):
            continue
        seen.update(normalized)
        group = hashlib.sha256(f"{VERSION}:{split}:{seed}:{attempt}".encode()).hexdigest()[:24]
        for kind, text, gold in (("positive", positive, [{"start": start, "end": start + len(value), "label": label,
                                                          "family": family_for(label), "risk": risk_for(label)}]),
                                 ("negative", negative, [])):
            item = {"id": f"{VERSION}-{group}-{kind}", "text": text, "entities": gold,
                    "domain": "community_context_counterfactual", "language": "en-AU",
                    "slices": ["psi", kind, "mixed_context" if mixed else "single_context", f"context:{split}"],
                    "metadata": {"synthetic": True, "source": VERSION, "source_uid": group, "split": split,
                                 "generator": VERSION, "seed": seed, "counterfactual_label": label,
                                 "attribute_value": value,
                                 "annotation_scope": "15 PSI labels only; names unscored; person-specific denials and historical disclosures protected"}}
            validate_record(item)
            yield item
        emitted += 1
        if emitted == pairs:
            return
    raise ValueError(f"Requested {pairs} pairs exceeds distinct renderings for {split}; generated {emitted}")


def write(directory: Path, train_pairs: int = 6000, evaluation_pairs: int = 900,
          external_parent: Path | None = None) -> dict:
    """Never read an external test file; preserve only its train/calibration rows."""
    if train_pairs < 1 or evaluation_pairs < 1:
        raise ValueError("Pair counts must be positive")
    if any((directory / name).exists() for name in ("train.jsonl", "calibration.jsonl", "test.jsonl", "manifest.json")):
        raise FileExistsError("Refusing to overwrite an existing corpus; choose a fresh output directory")
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {"version": VERSION, "seed": 20261019, "files": {}, "release_eligible": False,
                "limitations": "Authored synthetic grammar/value/name transfer test, not independent release confirmation; external source has only four PSI labels.",
                "gold_policy": "Person-linked attributes including denial, history and public self-disclosure are positive; general reference mentions are negative; names unscored."}
    parent_manifest = json.loads((external_parent / "manifest.json").read_text()) if external_parent else None
    if parent_manifest:
        manifest["external_parent"] = parent_manifest
    seen_text = {}
    seen_uid = {}
    for split, pairs in (("train", train_pairs), ("calibration", evaluation_pairs), ("test", evaluation_pairs)):
        rows = list(records(split, pairs))
        external_count = 0
        if external_parent and split != "test":
            path = external_parent / f"{split}.jsonl"
            if hashlib.sha256(path.read_bytes()).hexdigest() != parent_manifest["files"][split]["sha256"]:
                raise ValueError("External parent checksum mismatch")
            for item in iter_jsonl(path):
                if item["metadata"].get("source") != "nvidia/Nemotron-PII":
                    continue
                if item["metadata"].get("split") != split or item["metadata"].get("source_split") != "train":
                    raise ValueError("Refusing external test/mispartitioned input")
                rows.append(item)
                external_count += 1
        digest = hashlib.sha256()
        counts = Counter()
        negatives = 0
        with (directory / f"{split}.jsonl").open("wb") as handle:
            for item in rows:
                validate_record(item)
                text = " ".join(item["text"].casefold().split())
                uid = (item["metadata"].get("source"), item["metadata"].get("source_uid", item["id"]))
                if text in seen_text or (uid in seen_uid and seen_uid[uid] != split):
                    raise ValueError("Duplicate normalized text or cross-split source group")
                seen_text[text] = split
                seen_uid[uid] = split
                data = (json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
                handle.write(data)
                digest.update(data)
                counts.update(entity["label"] for entity in item["entities"])
                negatives += not item["entities"]
        manifest["files"][split] = {"sha256": digest.hexdigest(), "records": len(rows),
                                     "negative_documents": negatives, "labels": dict(counts), "external_records": external_count}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--external-parent", type=Path)
    parser.add_argument("--train-pairs", type=int, default=6000)
    parser.add_argument("--evaluation-pairs", type=int, default=900)
    args = parser.parse_args()
    print(json.dumps(write(args.output, args.train_pairs, args.evaluation_pairs, args.external_parent), indent=2))
