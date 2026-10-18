import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pii_bench.dashboard import FILES, METRICS, ROOT, build, build_data, cohort, normalize, number


class DashboardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = build_data()

    def test_every_displayed_number_resolves_to_its_exact_source_pointer(self):
        self.assertEqual(len(self.data['groups']), 9)
        self.assertEqual(sum(len(group['rows']) for group in self.data['groups']), 32)
        self.assertEqual(len(self.data['labels']), 44)
        self.assertEqual(len(self.data['catalog']), 20)
        sources = {key: json.loads((ROOT / 'evidence' / name).read_text()) for key, name in FILES.items()}
        for group in self.data['groups']:
            self.assertFalse(group['independent_confirmation'])
            identities = set()
            for row in group['rows']:
                original = sources[row['source']]
                for key in row['pointer'].strip('/').split('/'):
                    original = original[key.replace('~1', '/').replace('~0', '~')]
                for metric, (section, field, _, _) in METRICS.items():
                    self.assertEqual(row['scores'][metric]['value'], original[section][field])
                    self.assertEqual(row['scores'][metric]['low'], original.get('confidence_intervals', {}).get(metric, {}).get('low_95'))
                    self.assertEqual(row['scores'][metric]['high'], original.get('confidence_intervals', {}).get(metric, {}).get('high_95'))
                self.assertFalse(row['release_eligible'])
                self.assertFalse(row['partial_gate_audit']['eligible'])
                identities.add((row['dataset_sha256'], row['evaluation']['partition'], row['evaluation']['partition_scheme']))
            self.assertEqual(len(identities), 1)

    def test_missing_intervals_stay_unknown_and_zero_recall_stays_zero(self):
        old = next(g for g in self.data['groups'] if g['id'] == 'specialist-broad')['rows'][0]
        self.assertIsNone(old['scores']['clean_negative_document_rate']['low'])
        self.assertEqual(old['scores']['clean_negative_document_rate']['bound_status'], 'unknown')
        current = next(g for g in self.data['groups'] if g['id'] == 'compact-capacity-test')
        for row in current['rows']:
            if row['operating'] == 'primary':
                self.assertEqual(row['scores']['weighted_recall']['value'], 0)
                self.assertEqual(row['scores']['weighted_recall']['bound_status'], 'fails-bound')

    def test_cross_dataset_partition_scheme_and_sample_count_comparisons_are_rejected(self):
        original = self.data['groups'][0]['rows'][0]
        for field, value in (('partition', 'calibration'), ('partition_scheme', 'different'), ('records', 999)):
            altered = copy.deepcopy(original)
            altered['evaluation'][field] = value
            with self.assertRaisesRegex(ValueError, 'mixes dataset'):
                cohort('bad', 'bad', 'bad', [], [original, altered])
        altered = copy.deepcopy(original)
        altered['dataset_sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            cohort('bad', 'bad', 'bad', [], [original, altered])

    def test_nan_infinity_booleans_and_invalid_proportions_never_render_as_measurements(self):
        for bad in (True, False, float('nan'), float('inf'), '0.5'):
            with self.assertRaises(ValueError):
                number(bad)
        document = json.loads((ROOT / 'evidence' / FILES['rules-union']).read_text())['after']
        document['safety']['weighted_recall'] = 1.01
        with self.assertRaises(ValueError):
            normalize(document, key='bad', label='bad', operating='historical', source='rules-union', location='/after')

    def test_output_is_reproducible_and_downloads_have_exact_source_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'dist'
            build(output)
            first = (output / 'integrity.json').read_bytes()
            build(output)
            self.assertEqual(first, (output / 'integrity.json').read_bytes())
            manifest = json.loads(first)
            for name, expected in manifest['files'].items():
                self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest(), expected)
            for source in self.data['sources']:
                self.assertEqual(hashlib.sha256((output / 'evidence' / source['file']).read_bytes()).hexdigest(), source['sha256'])
            text = (output / 'evidence-data.js').read_text()
            payload = json.loads(text.removeprefix('globalThis.LLSS_EVIDENCE = ').removesuffix(';\n'))
            self.assertFalse(payload['release_eligible'])
            self.assertEqual(len(payload['runtime']['runs']), 9)
