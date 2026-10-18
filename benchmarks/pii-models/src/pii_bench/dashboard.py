"""Deterministic, dependency-free dashboard export from retained evidence.

No model execution, inference, new significance tests or manufactured intervals.
Comparison groups are curated study designs, never a cross-corpus leaderboard.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil

from .release import evaluate_release
from .taxonomy import DEFINITIONS

ROOT = Path(__file__).resolve().parents[2]
FILES = {
    name: f"{name}-results-2026-10-17.json"
    for name in ("specialist", "context", "compact-capacity", "rules-union", "minimal-runtime")
}
METRICS = {
    "weighted_recall": ("safety", "weighted_recall", .995, "lower"),
    "document_full_protection_rate": ("safety", "document_full_protection_rate", .98, "lower"),
    "clean_negative_document_rate": ("utility", "clean_negative_document_rate", .98, "lower"),
    "over_redaction_rate": ("utility", "over_redaction_rate", .02, "upper"),
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Evidence contains a non-finite or non-numeric measurement")
    return value


def pointer(*parts: str) -> str:
    return "/" + "/".join(part.replace("~", "~0").replace("/", "~1") for part in parts)


def normalize(metrics: dict, *, key: str, label: str, operating: str, source: str, location: str) -> dict:
    run, evaluation = metrics["run"], metrics["evaluation"]
    digest = run.get("dataset_sha256")
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise ValueError("Every displayed accuracy result needs a dataset binding")
    scores = {}
    for name, (section, field, target, direction) in METRICS.items():
        interval = metrics.get("confidence_intervals", {}).get(name, {})
        value = number(metrics.get(section, {}).get(field))
        low, high = number(interval.get("low_95")), number(interval.get("high_95"))
        for item in (value, low, high):
            if item is not None and not 0 <= item <= 1:
                raise ValueError("Proportion outside [0,1]")
        if low is not None and high is not None and low > high:
            raise ValueError("Inverted uncertainty interval")
        bound = low if direction == "lower" else high
        state = "unknown" if bound is None else ("meets-bound" if (bound >= target if direction == 'lower' else bound <= target) else "fails-bound")
        scores[name] = {"value": value, "low": low, "high": high, "rounds": interval.get("rounds"),
                        "target": target, "direction": direction, "bound_status": state}
    review = evaluate_release(metrics, {})
    return {"id": key, "label": label, "operating": operating, "candidate_id": run["candidate_id"],
            "dataset_sha256": digest, "evaluation": evaluation, "scores": scores,
            "threshold": run.get("member_minimum_scores") or evaluation.get("minimum_score"),
            "artifact_sha256": run.get("artifact_sha256"), "prediction_sha256": run.get("prediction_sha256"),
            "counts": metrics.get("counts", {}), "cluster_guardrails": metrics.get("cluster_guardrails", {}),
            "by_label": metrics.get("by_label", {}), "by_family": metrics.get("by_family", {}),
            "partial_gate_audit": review, "release_eligible": False,
            "source": source, "pointer": location}


def cohort(key: str, title: str, scope: str, limitations: list[str], rows: list[dict], pairs=None) -> dict:
    if not rows:
        raise ValueError("Empty comparison group")
    identities = {(row['dataset_sha256'], row['evaluation'].get('partition'),
                   row['evaluation'].get('partition_scheme'), row['evaluation'].get('records')) for row in rows}
    if len(identities) != 1:
        raise ValueError("Comparison group mixes dataset, partition, scheme or sample size")
    return {"id": key, "title": title, "scope": scope, "limitations": limitations,
            "rows": rows, "pairs": pairs or [], "independent_confirmation": False}


def build_data(root: Path = ROOT) -> dict:
    evidence = root / 'evidence'
    docs = {key: json.loads((evidence / name).read_text()) for key, name in FILES.items()}
    sources = [{"id": key, "file": filename, "sha256": sha(evidence / filename),
                "bytes": (evidence / filename).stat().st_size} for key, filename in FILES.items()]
    groups = []
    common = ["Previously viewed synthetic evaluation data; not fresh independent confirmation.",
              "Intervals describe resampling under supplied source/text groups, not real-world certainty.",
              "No human-adjudicated evaluation or exact packaged-browser release dossier supplied."]
    for study, title in (("compact-capacity", "Encoder capacity"), ("context", "Counterfactual training")):
        doc = docs[study].get('study', docs[study])
        for role, subtitle in (("test", "Authored context stress test"), ("regression", "External four-category regression")):
            rows = []
            for result_key, points in doc['results'].items():
                dataset_role, candidate = result_key.split(':')
                if dataset_role != role:
                    continue
                names = {'mini': 'BERT-Mini · typed', 'tiny': 'BERT-Tiny v2 · typed',
                         'typed': 'BERT-Tiny v2 · typed', 'agnostic': 'BERT-Tiny v2 · agnostic',
                         'baseline': 'BERT-Tiny v1 · control'}
                for op, metrics in points.items():
                    prefix = ('study', 'results') if study == 'compact-capacity' else ('results',)
                    rows.append(normalize(metrics, key=f'{study}-{role}-{candidate}-{op}', label=names[candidate],
                        operating=op, source=study, location=pointer(*prefix, result_key, op)))
            pairs = [{"name": k, "result": v} for k, v in doc.get('paired', {}).items() if k.startswith(role + ':')]
            caveats = (["15 PSI labels; names unscored. 60 clusters per label, below the 100-label support gate.",
                        "Counterfactual pairs share source clusters; 1,800 rows are not 1,800 independent observations."] if role == 'test' else
                       ["Four PSI categories only: race/ethnicity, religion, political affiliation, sexuality.",
                        "This source set was initially reserved; repeated development use makes current comparisons exploratory."])
            groups.append(cohort(f'{study}-{role}', f'{title} / {subtitle}',
                'Native CPU · PSI specialist research', [*caveats, *common], rows, pairs))
    specialist = docs['specialist']
    specs = (
        ('broad', 'Broad PII/PSI ensembles', ['broad_baseline', 'broad_budgeted_proposal', 'broad_coverage_proposal'],
         ['Rules + Masker Mini', 'Baseline + specialists · budgeted', 'Baseline + specialists · permissive'],
         ['44 labels, shared generator and development overlap; not a sealed confirmatory holdout.',
          'Only 14 independent negative text groups; thousands of repeated rows cannot establish cleanliness.',
          'Historical calibration constrained character over-redaction, not the newer joint clean-negative constraint.']),
        ('external', 'Initial specialist / external PSI', ['external_literal', 'external_byte_head', 'external_tiny_int8', 'external_ensemble'],
         ['Training-value dictionary', 'Byte-CNN fine-tune', 'BERT-Tiny v1 · INT8', 'Dictionary + byte head + BERT'],
         ['Four categories only; historical confirmation is now regression data after repeated reuse.',
          'Historically selected operating points do not satisfy the newer joint utility rule.']),
        ('authored', 'Initial specialist / authored transfer', ['authored_tiny_int8'], ['BERT-Tiny v1 · INT8'],
         ['288 authored rows; template/name-disjoint, but two exact attribute values overlap augmented training.',
          'Single retained candidate, not a comparative leaderboard.']),
    )
    for key, title, keys, names, warnings in specs:
        rows = [normalize(specialist['metrics'][item], key=f'specialist-{item}', label=name, operating='historical',
                          source='specialist', location=pointer('metrics', item)) for item, name in zip(keys, names)]
        pairs = ([{"name": 'Historical ensemble minus dictionary', 'result': specialist['paired_comparison']}]
                 if key == 'external' else [])
        groups.append(cohort('specialist-' + key, title, 'Historical research · not current release selection',
                             [*warnings, *common], rows, pairs))
    rules = docs['rules-union']
    groups.append(cohort('rules-union', 'Live rules / overlap fix', 'Rules only · source regression',
        ['20,000-row full-corpus coverage check; displayed accuracy is the 16,274-row test partition.',
         'Same sparse-negative diversity limitation as the broad corpus; not all 20,000 rows are independent.', *common],
        [normalize(rules[k], key='rules-' + k, label=label, operating='historical', source='rules-union', location=pointer(k))
         for k, label in (('before', 'Rules · before'), ('after', 'Rules · after'))],
        [{'name': 'After minus before', 'result': rules['paired']}]))
    runtime = docs['minimal-runtime']
    groups.append(cohort('runtime-parity', 'Runtime / same-model detection parity', 'Node/WASM · prepared Python tokenizer windows',
        ['Same weights; not a model improvement or complete JavaScript-tokenizer validation.',
         'No real Chrome/Edge extension measurements. Corpus covers four PSI categories only.', *common],
        [normalize(runtime['pair']['scores'][key], key='runtime-' + key, label=name, operating='historical',
                   source='minimal-runtime', location=pointer('pair', 'scores', key))
         for key, name in (('first', 'Default WASM · ONNX'), ('second', 'Reduced WASM · ORT'))],
        [{'name': 'Reduced minus default', 'result': runtime['pair']['paired']}]))
    catalog = json.loads((root / 'candidates.json').read_text())
    return {"schema_version": 1, "evidence_date": '2026-10-17', "release_eligible": False,
            "groups": groups, "sources": sources, "rules_coverage": rules['coverage'],
            "runtime": {"host": runtime['host'], "runs": [{"variant": row['variant'], "repetition": row['repetition'],
                "peak_rss_mib": row['report']['os_peak_rss_mib'], "cold_start_ms": row['report']['cold_start_ms'],
                "runtime_bytes": row['report']['runtime_artifact']['total_bytes'],
                "p95_256_ms": next(m['p95_ms'] for m in row['report']['measurements'] if m['tokens'] == 256)}
                for row in runtime['matrix']['results']], "span_parity": runtime['pair']['span_parity'],
                "blockers": runtime['known_release_blockers']},
            "labels": [{"id": key, "family": value.family, "risk": value.risk} for key, value in DEFINITIONS.items()],
            "catalog": [{k: row.get(k) for k in ('id', 'name', 'tier', 'repository', 'revision', 'license', 'rationale')}
                        for row in catalog['candidates']],
            "catalog_sha256": sha(root / 'candidates.json'), "exporter_sha256": sha(Path(__file__))}


def build(output: Path, root: Path = ROOT) -> dict:
    data = build_data(root)
    frontend = root / 'dashboard'
    # Dedicated generated directory only. Do not recursively clear any path.
    output.mkdir(parents=True, exist_ok=True)
    for name in ('index.html', 'dashboard.css', 'dashboard.js'):
        shutil.copyfile(frontend / name, output / name)
    source_dir = output / 'evidence'
    source_dir.mkdir(exist_ok=True)
    for filename in FILES.values():
        shutil.copyfile(root / 'evidence' / filename, source_dir / filename)
    shutil.copyfile(root / 'PROTOCOL.md', source_dir / 'PROTOCOL.md')
    shutil.copyfile(root / 'candidates.json', source_dir / 'candidates.json')
    data['protocol_sha256'] = sha(root / 'PROTOCOL.md')
    payload = json.dumps(data, ensure_ascii=True, sort_keys=True, allow_nan=False).replace('<', '\\u003c')
    (output / 'evidence-data.js').write_text('globalThis.LLSS_EVIDENCE = ' + payload + ';\n')
    manifest = {"schema_version": 1, "release_eligible": False, "exporter_sha256": sha(Path(__file__)),
                "files": {str(p.relative_to(output)): sha(p) for p in sorted(output.rglob('*'))
                          if p.is_file() and p.name != 'integrity.json'}}
    (output / 'integrity.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    return {"groups": len(data['groups']), "rows": sum(len(g['rows']) for g in data['groups']),
            "output": str(output), "release_eligible": False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dashboard/dist')
    args = parser.parse_args()
    print(json.dumps(build(args.output)))
