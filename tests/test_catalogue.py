"""Run the actual teaching catalogue through preview, generation and the editor graph."""
import json
import re
import shutil
import subprocess
import unittest
from collections import Counter
from pathlib import Path

from chemistry import VALENCE_ELECTRONS, process


ROOT = Path(__file__).resolve().parents[1]
SUBSCRIPT_DIGITS = str.maketrans('₀₁₂₃₄₅₆₇₈₉', '0123456789')
SUPERSCRIPT_DIGITS = str.maketrans('⁰¹²³⁴⁵⁶⁷⁸⁹', '0123456789')


def labelled_composition(formula):
    """Read count subscripts and charge superscripts separately (e.g. SO₄²⁻)."""
    suffix = re.search(r'([⁰¹²³⁴⁵⁶⁷⁸⁹]*)([⁺⁻])$', formula)
    charge = 0
    if suffix:
        magnitude = int(suffix[1].translate(SUPERSCRIPT_DIGITS) or '1')
        charge = magnitude if suffix[2] == '⁺' else -magnitude
        formula = formula[:suffix.start()]
    body = formula.translate(SUBSCRIPT_DIGITS)
    if not re.fullmatch(r'(?:[A-Z][a-z]?\d*)+', body):
        raise ValueError(f'Unsupported catalogue formula: {formula}')
    elements = Counter()
    for symbol, digits in re.findall(r'([A-Z][a-z]?)(\d*)', body):
        elements[symbol] += int(digits or '1')
    return elements, charge


@unittest.skipUnless(shutil.which('node'), 'Node is required to read the frontend catalogue')
class CatalogueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Evaluate the same module as the browser, including the backslash in cis-2-butene.
        script = ("import { CHEMISTRY_EXAMPLES } from './src/chemistryExamples.js'; "
                  "process.stdout.write(JSON.stringify(CHEMISTRY_EXAMPLES));")
        cls.examples = json.loads(subprocess.check_output(
            ['node', '--input-type=module', '-e', script], cwd=ROOT, encoding='utf-8'))

    def test_catalogue_composition_and_identity_survive_editing(self):
        self.assertTrue(self.examples)
        for example in self.examples:
            with self.subTest(name=example['name'], formula=example['formula'], smiles=example['smiles']):
                expected, charge = labelled_composition(example['formula'])
                preview = process({'action': 'inspect', 'smiles': example['smiles']})
                self.assertTrue(preview['valid'], preview['message'])
                self.assertEqual(preview['charge'], charge)
                self.assertEqual({p['element']: p['count'] for p in preview['formulaParts']}, expected)

                model = process({'smiles': example['smiles'], 'samples': 1})
                rebuilt = process({'graph': model['graph'], 'samples': 1})
                project = {'molblock': model['molblock'], 'stereoGraph': model['graph']}
                imported = process({'action': 'analyze', **project})
                optimized = process({'action': 'optimize', **project})
                for old, new in zip(model['atoms'], imported['atoms']):
                    for before, after in zip(old['position'], new['position']):
                        self.assertAlmostEqual(before, after, delta=.001)  # MOL precision
                for result in (model, rebuilt, imported, optimized):
                    self.assertEqual(result['smiles'], model['smiles'])
                    self.assertEqual(result.get('electronicState'), model.get('electronicState'))
                    atoms = result['atoms']
                    self.assertEqual(Counter(a['element'] for a in atoms), expected)
                    self.assertEqual(sum(a['charge'] for a in atoms), charge)
                    self.assertEqual(result['charge'], charge)
                    valence_total = sum(VALENCE_ELECTRONS[s] * n for s, n in expected.items()) - charge
                    for state in result['resonance']['states']:
                        self.assertEqual(sum(state['atomCharges']), charge)
                        radical_count = sum(state['radicalCounts'])
                        lewis_total = 2 * (sum(state['bondOrders']) + sum(state['lonePairCounts'])) + radical_count
                        self.assertEqual(lewis_total, valence_total)

    def test_named_isomers_keep_distinct_structures(self):
        by_name = {e['name']: e for e in self.examples}
        expected = {'乙醇': 'CCO', '二甲醚': 'COC', '順-2-丁烯': 'C/C=C\\C', '反-2-丁烯': 'C/C=C/C'}
        for name, canonical in expected.items():
            with self.subTest(name=name):
                preview = process({'action': 'inspect', 'smiles': by_name[name]['smiles']})
                self.assertEqual(preview['canonicalSmiles'], canonical)


if __name__ == '__main__':
    unittest.main()
