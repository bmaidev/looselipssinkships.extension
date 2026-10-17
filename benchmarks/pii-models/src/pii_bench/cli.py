from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .catalog import candidate_by_id, load_catalog, runnable_candidates, validate_for_run
from .dataset import LEGACY_PARTITION_SCHEME, PARTITION_SCHEME, audit_dataset, validate_dataset, write_dataset
from .metrics import calibrate_ensemble, calibrate_threshold, compare_predictions, score_predictions, write_json
from .report import load_results, render_markdown
from .runner import combine_predictions, run_candidate


BENCHMARK_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CATALOG = BENCHMARK_ROOT / "candidates.json"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="pii-bench", description="Australian PII/PSI local-model benchmark")
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate = subparsers.add_parser("generate", help="Generate the deterministic synthetic corpus")
    generate.add_argument("--output", type=Path, required=True)
    generate.add_argument("--records", type=int, default=20_000)
    generate.add_argument("--seed", type=int, default=20261017)
    generate.add_argument("--manifest", type=Path)

    validate = subparsers.add_parser("validate", help="Validate offsets, taxonomy, IDs, and checksum")
    validate.add_argument("--dataset", type=Path, required=True)
    validate.add_argument("--sha256")
    audit = subparsers.add_parser("audit-dataset", help="Audit repetition and calibration/test leakage")
    audit.add_argument("--dataset", type=Path, required=True)

    catalog = subparsers.add_parser("catalog", help="List the governed candidate matrix")
    catalog.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    catalog.add_argument("--runnable", action="store_true")
    catalog.add_argument("--json", action="store_true")

    run = subparsers.add_parser("run", help="Run and cache predictions for one candidate")
    run.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    run.add_argument("--candidate", required=True)
    run.add_argument("--dataset", type=Path, required=True)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--cache-dir", type=Path)
    run.add_argument("--warmup-records", type=int, default=3)
    run.add_argument("--allow-moving-revision", action="store_true")
    run.add_argument("--allow-remote-code", action="store_true")

    score = subparsers.add_parser("score", help="Score cached predictions")
    score.add_argument("--dataset", type=Path, required=True)
    score.add_argument("--predictions", type=Path, required=True)
    score.add_argument("--output", type=Path, required=True)
    score.add_argument("--bootstrap-rounds", type=int, default=500)
    score.add_argument("--bootstrap-seed", type=int, default=20261017)
    score.add_argument("--partition", choices=("all", "calibration", "test"), default="all")
    score.add_argument("--minimum-score", type=float, default=0.0)
    score.add_argument("--partition-scheme", choices=(PARTITION_SCHEME, LEGACY_PARTITION_SCHEME), default=PARTITION_SCHEME)
    compare = subparsers.add_parser("compare", help="Paired cluster bootstrap comparison of two cached runs")
    compare.add_argument("--dataset", type=Path, required=True)
    compare.add_argument("--first", type=Path, required=True)
    compare.add_argument("--second", type=Path, required=True)
    compare.add_argument("--first-minimum-score", type=float, default=0.0)
    compare.add_argument("--second-minimum-score", type=float, default=0.0)
    compare.add_argument("--partition", choices=("all", "calibration", "test"), default="all")
    compare.add_argument("--rounds", type=int, default=1000)
    compare.add_argument("--output", type=Path, required=True)

    calibrate = subparsers.add_parser("calibrate", help="Select a confidence threshold on calibration records")
    calibrate.add_argument("--dataset", type=Path, required=True)
    calibrate.add_argument("--predictions", type=Path, required=True)
    calibrate.add_argument("--output", type=Path, required=True)
    calibrate.add_argument("--threshold", type=float, action="append", required=True)
    calibrate.add_argument("--max-over-redaction", type=float, default=0.02)
    calibrate.add_argument("--bootstrap-seed", type=int, default=20261017)
    calibrate.add_argument("--calibration-partition", choices=("calibration", "all"), default="calibration",
                           help="Use all only for a separately supplied calibration-only file")
    calibrate.add_argument("--partition-scheme", choices=(PARTITION_SCHEME, LEGACY_PARTITION_SCHEME), default=PARTITION_SCHEME)

    calibrate_members = subparsers.add_parser(
        "calibrate-ensemble", help="Grid-search ensemble member thresholds on calibration records"
    )
    calibrate_members.add_argument("--dataset", type=Path, required=True)
    calibrate_members.add_argument("--predictions", type=Path, action="append", required=True)
    calibrate_members.add_argument(
        "--thresholds",
        action="append",
        required=True,
        help="Comma-separated threshold grid for the corresponding predictions file",
    )
    calibrate_members.add_argument("--strategy", choices=("union", "precedence"), default="union")
    calibrate_members.add_argument("--max-over-redaction", type=float, default=0.02)
    calibrate_members.add_argument("--output", type=Path, required=True)
    calibrate_members.add_argument("--partition-scheme", choices=(PARTITION_SCHEME, LEGACY_PARTITION_SCHEME), default=PARTITION_SCHEME)
    calibrate_members.add_argument("--calibration-partition", choices=("calibration", "all"), default="calibration")

    ensemble = subparsers.add_parser("ensemble", help="Compose cached candidate predictions without rerunning models")
    ensemble.add_argument("--predictions", type=Path, action="append", required=True)
    ensemble.add_argument("--member-minimum-score", type=float, action="append")
    ensemble.add_argument("--strategy", choices=("union", "precedence"), default="union")
    ensemble.add_argument("--output", type=Path, required=True)

    report = subparsers.add_parser("report", help="Render a comparable Markdown scorecard")
    report.add_argument("metrics", type=Path, nargs="+")
    report.add_argument("--output", type=Path, required=True)
    return parser


def _print_json(value: object) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True))


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    if args.command == "generate":
        manifest = write_dataset(args.output, args.records, args.seed)
        if args.manifest:
            write_json(args.manifest, {**manifest, "dataset": str(args.output)})
        _print_json(manifest)
    elif args.command == "validate":
        _print_json(validate_dataset(args.dataset, args.sha256))
    elif args.command == "audit-dataset":
        _print_json(audit_dataset(args.dataset))
    elif args.command == "catalog":
        catalog = load_catalog(args.catalog)
        candidates = runnable_candidates(catalog) if args.runnable else catalog["candidates"]
        if args.json:
            _print_json(candidates)
        else:
            for candidate in candidates:
                pin = candidate.get("revision") or "UNPINNED"
                print(f"{candidate['id']:<34} {candidate['adapter']:<20} {candidate['license']:<26} {pin}")
    elif args.command == "run":
        catalog = load_catalog(args.catalog, allow_moving_revision=args.allow_moving_revision)
        candidate = candidate_by_id(catalog, args.candidate)
        validate_for_run(candidate, args.allow_moving_revision)
        _print_json(
            run_candidate(
                candidate,
                args.dataset,
                args.output,
                BENCHMARK_ROOT,
                cache_dir=args.cache_dir,
                warmup_records=args.warmup_records,
                allow_remote_code=args.allow_remote_code,
            )
        )
    elif args.command == "score":
        result = score_predictions(
            args.dataset,
            args.predictions,
            bootstrap_rounds=args.bootstrap_rounds,
            bootstrap_seed=args.bootstrap_seed,
            partition=args.partition,
            minimum_score=args.minimum_score,
            partition_scheme=args.partition_scheme,
        )
        write_json(args.output, result)
        _print_json(result)
    elif args.command == "compare":
        result = compare_predictions(args.dataset, args.first, args.second,
                                     first_minimum_score=args.first_minimum_score,
                                     second_minimum_score=args.second_minimum_score,
                                     partition=args.partition, rounds=args.rounds)
        write_json(args.output, result)
        _print_json(result)
    elif args.command == "calibrate":
        result = calibrate_threshold(
            args.dataset,
            args.predictions,
            thresholds=args.threshold,
            max_over_redaction=args.max_over_redaction,
            bootstrap_seed=args.bootstrap_seed,
            calibration_partition=args.calibration_partition,
            partition_scheme=args.partition_scheme,
        )
        write_json(args.output, result)
        _print_json(result)
    elif args.command == "calibrate-ensemble":
        threshold_grids = [
            [float(value) for value in specification.split(",") if value.strip()]
            for specification in args.thresholds
        ]
        result = calibrate_ensemble(
            args.dataset,
            args.predictions,
            threshold_grids=threshold_grids,
            max_over_redaction=args.max_over_redaction,
            strategy=args.strategy,
            partition_scheme=args.partition_scheme,
            calibration_partition=args.calibration_partition,
        )
        write_json(args.output, result)
        _print_json(result)
    elif args.command == "ensemble":
        _print_json(
            combine_predictions(
                args.predictions,
                args.output,
                args.strategy,
                minimum_scores=args.member_minimum_score,
            )
        )
    elif args.command == "report":
        content = render_markdown(load_results(args.metrics))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
        print(args.output)
    else:
        raise AssertionError(args.command)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
