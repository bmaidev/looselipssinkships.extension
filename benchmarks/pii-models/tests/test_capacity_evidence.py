import hashlib
import json
from pathlib import Path
import unittest

from pii_bench.release import evaluate_release
from pii_bench.tiny_finetune import ENCODERS


class CapacityEvidenceTests(unittest.TestCase):
    def test_retained_failure_binds_the_pinned_candidate_and_cannot_pass_release(self):
        root = Path(__file__).resolve().parents[1]
        evidence = json.loads((root / 'evidence/compact-capacity-results-2026-10-17.json').read_text())
        self.assertFalse(evidence['release_eligible'])
        self.assertEqual(evidence['decision'], 'reject-for-release')
        training = evidence['training']
        self.assertEqual((training['repository'], training['revision']), ENCODERS['mini'])
        study = evidence['study']
        self.assertEqual(training['weights_sha256'], study['locked_plan']['artifacts']['mini']['weights_sha256'])
        plan_path = 'evidence/compact-capacity-plan-2026-10-17.json'
        self.assertEqual(hashlib.sha256((root / plan_path).read_bytes()).hexdigest(),
                         evidence['analysis_inputs_sha256'][plan_path])
        self.assertEqual(evidence['pretraining_plan']['training']['train_sha256'],
                         training['training_manifest']['files']['train']['sha256'])
        self.assertEqual(study['paired']['test:mini-vs-tiny:primary']['minimum_scores'],
                         {'first': .95, 'second': .99})
        for candidate in ('tiny', 'mini'):
            metrics = study['results'][f'test:{candidate}']['primary']
            result = evaluate_release(metrics, {})
            self.assertFalse(result['eligible'])
            self.assertIn('weighted_recall_lower_95', result['failed_gates'])
