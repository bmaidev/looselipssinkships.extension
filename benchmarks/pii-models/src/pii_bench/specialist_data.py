"""Independent synthetic curriculum for a small contextual PSI research head.

The vocabulary and templates are authored here, independently of dataset.py.
Values and sentence templates are partitioned before rendering. This is a
controlled feasibility experiment; external, human-reviewed data is still needed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import random

from .dataset import validate_record
from .taxonomy import family_for, risk_for


VERSION = "psi-curriculum-1"
# First eight values train, next two calibrate, final two test. No phrase crosses
# partitions, including negative mentions of that phrase.
PHRASES = {
    "HEALTH_CONDITION": ["rheumatoid arthritis", "chronic kidney disease", "asthma", "multiple sclerosis", "coeliac disease", "atrial fibrillation", "psoriasis", "sleep apnoea", "ulcerative colitis", "Parkinson disease", "systemic lupus", "chronic pancreatitis"],
    "MEDICATION": ["metformin", "warfarin", "salbutamol", "methotrexate", "atorvastatin", "amoxicillin", "prednisolone", "omeprazole", "rivaroxaban", "hydroxychloroquine", "azathioprine", "duloxetine"],
    "DISABILITY": ["hearing loss", "a spinal cord injury", "cerebral palsy", "an intellectual disability", "a learning disability", "a communication impairment", "a neurological disability", "a limb difference", "a cognitive impairment", "muscular dystrophy", "a developmental disability", "a sensory disability"],
    "MENTAL_HEALTH": ["obsessive compulsive disorder", "clinical depression", "panic disorder", "schizophrenia", "an eating disorder", "dissociative disorder", "psychosis", "social anxiety disorder", "schizoaffective disorder", "persistent depressive disorder", "complex trauma", "agoraphobia"],
    "GENETIC_INFO": ["a pathogenic BRCA2 variant", "a Huntington gene expansion", "a CFTR mutation", "a familial cancer mutation", "an APOE genotype", "a hereditary haemochromatosis variant", "a Lynch syndrome mutation", "a chromosome deletion", "a PALB2 variant", "a mitochondrial mutation", "a pathogenic CHEK2 variant", "a chromosomal duplication"],
    "RACE_ETHNICITY": ["Kurdish", "Samoan", "Yolngu", "Punjabi", "Assyrian", "Karen", "Tibetan", "Pasifika", "Dinka", "Torres Strait Islander", "Yazidi", "Burmese"],
    "RELIGION": ["Sikh", "Bahai", "Jain", "Zoroastrian", "Atheist", "Anglican", "Orthodox", "Catholic", "Quaker", "Rastafarian", "Seventh-day Adventist", "Druze"],
    "POLITICAL_AFFILIATION": ["a National Party supporter", "a socialist campaign organiser", "a conservative party activist", "a libertarian party member", "an independent candidate donor", "a progressive party delegate", "a local election campaign worker", "an environmental party organiser", "a republican movement member", "a monarchist lobby member", "a democratic socialist organiser", "a centrist party volunteer"],
    "TRADE_UNION": ["the United Workers Union", "the Transport Workers Union", "the Australian Education Union", "the Electrical Trades Union", "the Maritime Union", "the Finance Sector Union", "the Rail Tram and Bus Union", "the Media Entertainment and Arts Alliance", "the Australian Workers Union", "the Health Services Union", "the Independent Education Union", "the Flight Attendants Association"],
    "SEXUAL_ORIENTATION": ["pansexual", "asexual", "queer", "same sex attracted", "heterosexual", "demisexual", "aromantic", "questioning their sexuality", "homosexual", "sexually fluid", "biromantic", "greysexual"],
    "CRIMINAL_RECORD": ["a prior fraud conviction", "a burglary sentence", "an outstanding arrest warrant", "a drug possession charge", "a criminal trespass conviction", "a suspended prison sentence", "a pending theft prosecution", "a conviction for dangerous driving", "a historical robbery conviction", "a current bail condition", "a money laundering conviction", "an unresolved arson charge"],
    "VICTIM_SAFEGUARDING": ["living at a confidential shelter", "subject to a protection order", "escaping domestic abuse", "a survivor of trafficking", "receiving witness protection", "at risk from a violent partner", "a survivor of sexual assault", "in emergency protective accommodation", "relocating after stalking", "under confidential police protection", "hiding from an abusive relative", "receiving crisis protection"],
    "FINANCIAL_HARDSHIP": ["in mortgage arrears", "unable to afford groceries", "facing eviction for unpaid rent", "in personal bankruptcy", "unable to pay electricity bills", "receiving emergency food relief", "in severe debt distress", "behind on essential repayments", "unable to meet loan repayments", "seeking insolvency assistance", "at risk of home repossession", "unable to afford essential medicine"],
    "INCOME": ["an annual income of $31700", "a weekly benefit of $428", "a salary of $68400", "a fortnightly pension of $971", "a monthly wage of $2980", "a yearly income of $52750", "a weekly allowance of $316", "a monthly benefit of $1840", "an annual salary of $76300", "a weekly wage of $1190", "a fortnightly income of $1635", "an annual benefit of $24700"],
    "CHILD_STATUS": ["a child in foster care", "an unaccompanied minor", "a child under guardianship", "a minor in residential care", "a child receiving protection services", "a schoolchild in temporary care", "a minor under a care order", "a child in kinship care", "a minor receiving family support", "a child subject to a care plan", "a young person in statutory care", "a minor with a court appointed guardian"],
}

# Templates contain no category cues, so classification cannot be solved by
# memorising an explicit label prefix. Positive and public mentions share phrases.
TEMPLATES = {
    "train": {
        "positive": ["In a private appointment, {name} disclosed {value}.", "The confidential record for {name} states {value}.", "Caseworker note: {name} reported {value} yesterday.", "Please keep this private: {name} is associated with {value}.", "During intake, {name} confirmed {value}.", "Personal file for {name}: {value}.", "{name} requested help regarding {value}.", "Our client {name} has confidential information: {value}."],
        "negative": ["The public information session discusses {value}.", "This general training manual covers {value}.", "Search the library catalogue for information about {value}.", "The fictional plot includes a discussion of {value}.", "No client is identified in this public article about {value}.", "The staff seminar explains the topic {value}.", "A public policy briefing examines {value}.", "The course syllabus includes {value}."],
    },
    "calibration": {
        "positive": ["Restricted assessment concerning {name}: {value}.", "The individual {name} privately told our adviser about {value}."],
        "negative": ["The community textbook has a chapter on {value}.", "Anonymous survey topics include {value}; no respondent is named."],
    },
    "test": {
        "positive": ["Sensitive handover for {name}; the person described {value}.", "For the eyes of the assigned worker only: {name}, {value}."],
        "negative": ["The open access educational resource explains {value}.", "General awareness campaign theme: {value}; this describes no individual."],
    },
}
NAMES = {
    "train": ["Amira Haddou", "Felix Moreno", "Nikhil Desai", "Keira Walsh", "Dara Sok", "Leila Mansour"],
    "calibration": ["Rosa Almeida", "Tenzin Dorji"],
    "test": ["Mina Takahashi", "Emilio Duarte"],
}


def curriculum_records(split: str, count: int, seed: int = 20261018):
    if split not in TEMPLATES:
        raise ValueError(f"Unknown curriculum split: {split}")
    rng = random.Random(f"{seed}:{split}")
    bounds = {"train": (0, 8), "calibration": (8, 10), "test": (10, 12)}[split]
    labels = list(PHRASES)
    seen_texts: set[str] = set()
    for index in range(count):
        label = labels[index % len(labels)]
        value = rng.choice(PHRASES[label][bounds[0]:bounds[1]])
        positive = (index // len(labels)) % 2 == 0
        kind = "positive" if positive else "negative"
        template = rng.choice(TEMPLATES[split][kind])
        name = rng.choice(NAMES[split])
        if index % 7 == 0:
            value = value.upper()
        text = template.format(name=name, value=value)
        if text in seen_texts:
            continue
        seen_texts.add(text)
        entities = []
        if positive:
            start = text.index(value)
            entities = [{"start": start, "end": start + len(value), "label": label,
                         "family": family_for(label), "risk": risk_for(label)}]
        record = {
            "id": f"{VERSION}-{split}-{index:06d}", "text": text,
            "entities": entities, "language": "en-AU", "domain": "specialist_curriculum",
            "slices": ["psi", kind, f"curriculum:{split}"],
            "metadata": {"synthetic": True, "generator": VERSION, "split": split,
                         "seed": seed, "annotation_scope": "sensitive attributes only; names are unscored"},
        }
        validate_record(record)
        yield record


def write_curriculum(directory: Path, train_count: int = 12000) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    manifest = {"version": VERSION, "annotation_scope": "PSI attributes only", "files": {}}
    for split, count in (("train", train_count), ("calibration", 1200), ("test", 1200)):
        digest = hashlib.sha256()
        written = 0
        with (directory / f"{split}.jsonl").open("wb") as output:
            for record in curriculum_records(split, count):
                data = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
                digest.update(data)
                output.write(data)
                written += 1
        manifest["files"][split] = {"records": written, "sha256": digest.hexdigest()}
    (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest
