"""Incremental input feedback must be cheap, clear and safe to embed."""
import unittest
from unittest.mock import patch
from xml.etree import ElementTree

from chemistry import process


def inspect(smiles):
    return process({"action": "inspect", "smiles": smiles})


class InspectTests(unittest.TestCase):
    def test_valid_structure_has_formula_counts_svg_and_index_notes(self):
        result = inspect("CCO")
        self.assertTrue(result["valid"])
        self.assertEqual(result["formula"], "C2H6O")
        self.assertEqual((result["atomCount"], result["bondCount"]), (3, 2))
        self.assertEqual(result["canonicalSmiles"], "CCO")
        root = ElementTree.fromstring(result["svg"])
        self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
        self.assertIn("class='note'", result["svg"])
        self.assertTrue(any("二維" in warning for warning in result["warnings"]))

    def test_inspect_never_embeds_or_minimizes(self):
        with patch("chemistry.AllChem.EmbedMultipleConfs", side_effect=AssertionError("3D called")), \
             patch("chemistry._field", side_effect=AssertionError("force-field created")), \
             patch("chemistry.AllChem.MMFFOptimizeMolecule", side_effect=AssertionError("minimize called")):
            self.assertTrue(inspect("CC(O)C")["valid"])

    def test_partial_branch_and_bracket_feedback(self):
        for text, clue in [("C(C", "支鏈"), ("[NH4+", "]"), ("CC)", "多了一個"), ("C()", "支鏈內")]:
            with self.subTest(text=text):
                result = inspect(text)
                self.assertFalse(result["valid"])
                self.assertIsNone(result["svg"])
                self.assertIn(clue, result["message"])

    def test_ring_numbers_not_confused_with_bracket_hydrogens_or_isotopes(self):
        for text in ["[NH4+]", "[13CH3]CO", "C1CCCCC1", "C%12CCCCC%12", "C%(1)CCCCC1"]:
            with self.subTest(text=text):
                self.assertTrue(inspect(text)["valid"])
        for text in ["C1CC", "C%12CC"]:
            self.assertIn("尚未配對", inspect(text)["message"])
        self.assertIn("兩位數字", inspect("C%1")["message"])

    def test_pending_bond_has_specific_feedback(self):
        for text in ["C=", "C#", "C-", "C/", "C\\"]:
            with self.subTest(text=text):
                self.assertIn("還沒有接上原子", inspect(text)["message"])

    def test_bad_valence_identifies_atom(self):
        result = inspect("C(C)(C)(C)(C)C")
        self.assertFalse(result["valid"])
        self.assertIn("第 1 個 C", result["message"])
        self.assertIn("鍵太多", result["message"])

    def test_empty_non_text_or_excessive_input_is_not_an_exception(self):
        for text in ["", "   ", None, 12, {"text": "C"}, "C" * 4001]:
            with self.subTest(text=str(text)[:20]):
                result = inspect(text)
                self.assertFalse(result["valid"])
                self.assertTrue(result["message"])

    def test_generation_scope_limits_are_shared(self):
        for text in ["[Fe]", "[CH3]", "CC.O", "C" * 81, "FP(F)(F)(F)F"]:
            with self.subTest(text=text[:20]):
                self.assertFalse(inspect(text)["valid"])

    def test_svg_cannot_contain_user_active_content(self):
        for text in ["<svg onload=alert(1)>", "C <script>alert(1)</script>", "[C<script>]"]:
            result = inspect(text)
            self.assertFalse(result["valid"])
            self.assertIsNone(result["svg"])
        svg = inspect("C[C@H](O)F")["svg"]
        self.assertNotIn("<script", svg.lower())
        self.assertNotIn("foreignobject", svg.lower())
        self.assertNotRegex(svg, r"\son\w+\s*=")

    def test_stereo_and_aromatic_structure_roundtrip(self):
        for text in [r"C/C=C\C", "C/C=C/C", "c1ccccc1", "C[C@H](O)F"]:
            with self.subTest(text=text):
                result = inspect(text)
                self.assertTrue(result["valid"])
                self.assertEqual(result["canonicalSmiles"], text)


if __name__ == "__main__":
    unittest.main()
