"""Incremental input feedback must be cheap, clear and safe to embed."""
import unittest
import re
from unittest.mock import patch
from xml.etree import ElementTree

from chemistry import process, Chem, rdMolDraw2D


def inspect(smiles):
    return process({"action": "inspect", "smiles": smiles})


class InspectTests(unittest.TestCase):
    def test_preview_uses_true_cip_annotations(self):
        draw = rdMolDraw2D.PrepareAndDrawMolecule
        annotations = []
        def capture(drawer, molecule, *args, **kwargs):
            annotations.append({a.GetIdx(): a.GetProp("_CIPCode") for a in molecule.GetAtoms() if a.HasProp("_CIPCode")})
            return draw(drawer, molecule, *args, **kwargs)
        with patch("chemistry.rdMolDraw2D.PrepareAndDrawMolecule", side_effect=capture):
            for smiles in ["C1CC1[C@H](F)C1CCC1", "F[C@H]1CC[C@H](O)CC1"]:
                self.assertTrue(inspect(smiles)["valid"])
        self.assertEqual(annotations, [{3: "S"}, {1: "r", 4: "r"}])

    def test_unrepresentable_models_are_rejected_in_preview_and_generation(self):
        from chemistry import ChemistryError
        cases = [("N->B", "配位鍵"), ("C~C", "未指定鍵級"),
                 ("[999CH4]", "同位素"), ("[65549CH4]", "同位素"),
                 ("[CH4+256]", "形式電荷"), ("[CH260]", "氫原子數"),
                 ("[CH3]", "自由基"), ("[Na+].[Cl-]", "相連分子"), ("F[C@SP1](Cl)(Br)I", "四面體")]
        for smiles, message in cases:
            with self.subTest(smiles=smiles):
                result = inspect(smiles)
                self.assertFalse(result["valid"])
                self.assertIn(message, result["message"])
                with self.assertRaisesRegex(ChemistryError, message):
                    process({"smiles": smiles, "samples": 1})

    def test_valid_isotopes_and_absolute_stereo_remain_supported(self):
        for smiles in ["[13CH4]", "[2H]O[2H]", "OO", "C[C@H](F)[C@H](Cl)Br"]:
            with self.subTest(smiles=smiles):
                self.assertTrue(inspect(smiles)["valid"])

    def test_graph_atom_numbers_cannot_wrap_to_a_different_species(self):
        from chemistry import ChemistryError
        for field, value in [("charge", 256), ("isotope", 65549), ("explicitHs", 260)]:
            graph = {"atoms": [{"id": 0, "element": "C", field: value}], "bonds": []}
            with self.subTest(field=field), self.assertRaises(ChemistryError):
                process({"graph": graph, "samples": 1})

    def test_valid_structure_has_formula_counts_svg_and_index_notes(self):
        result = inspect("CCO")
        self.assertTrue(result["valid"])
        self.assertEqual(result["formula"], "C2H6O")
        self.assertEqual((result["atomCount"], result["bondCount"]), (9, 8))
        self.assertTrue(result["atomCountIncludesHydrogen"])
        self.assertEqual((result["heavyAtomCount"], result["inputAtomCount"]), (3, 3))
        self.assertEqual(result["canonicalSmiles"], "CCO")
        root = ElementTree.fromstring(result["svg"])
        self.assertEqual(root.tag, "{http://www.w3.org/2000/svg}svg")
        self.assertIn("class='note'", result["svg"])
        self.assertTrue(any("二維" in warning for warning in result["warnings"]))

    def test_single_heavy_atom_hydrides_show_every_hydrogen_bond(self):
        for smiles, atoms, bonds in [("[NH4+]", 5, 4), ("N", 4, 3), ("O", 3, 2), ("C", 5, 4)]:
            with self.subTest(smiles=smiles):
                result = inspect(smiles)
                self.assertTrue(result["valid"])
                self.assertEqual((result["atomCount"], result["bondCount"]), (atoms, bonds))
                self.assertEqual(result["heavyAtomCount"], 1)
                visible_bonds = set(re.findall(r"\bbond-(\d+)\b", result["svg"]))
                self.assertEqual(len(visible_bonds), bonds)
                model = process({"action": "generate", "smiles": smiles, "samples": 1})
                self.assertEqual((len(model["atoms"]), len(model["bonds"])), (atoms, bonds))

    def test_expanded_hydrogens_have_no_input_index_and_original_atoms_keep_theirs(self):
        draw = rdMolDraw2D.PrepareAndDrawMolecule
        depictions = []

        def capture(drawer, molecule, *args, **kwargs):
            depictions.append(Chem.Mol(molecule))
            return draw(drawer, molecule, *args, **kwargs)

        with patch("chemistry.rdMolDraw2D.PrepareAndDrawMolecule", side_effect=capture):
            previews = []
            for smiles in ["[NH4+]", "[2H][NH3+]", "CCO"]:
                previews.append(inspect(smiles))
                self.assertTrue(previews[-1]["valid"])
        ammonium, isotope, ethanol = depictions
        self.assertEqual(ammonium.GetNumAtoms(), 5)
        self.assertEqual(isotope.GetAtomWithIdx(0).GetIsotope(), 2)
        self.assertEqual(isotope.GetAtomWithIdx(1).GetSymbol(), "N")
        for preview, expected in zip(previews, [[("0", "1")], [("0", "1"), ("1", "2")]]):
            root = ElementTree.fromstring(preview["svg"])
            notes = [(node.get("data-input-atom"), node.text) for node in root if node.get("data-input-atom") is not None]
            self.assertEqual(notes, expected)
        self.assertEqual(ethanol.GetNumAtoms(), 3)
        self.assertEqual([a.GetProp("atomNote") for a in ethanol.GetAtoms()], ["1", "2", "3"])

    def test_isotope_hydrogens_are_not_doubled_or_lost(self):
        for smiles, atoms, bonds in [("[2H]O[2H]", 3, 2), ("[2H][NH3+]", 5, 4), ("[13CH4]", 5, 4)]:
            with self.subTest(smiles=smiles):
                result = inspect(smiles)
                self.assertTrue(result["valid"])
                self.assertEqual((result["atomCount"], result["bondCount"]), (atoms, bonds))
                self.assertEqual(result["canonicalSmiles"], Chem.MolToSmiles(Chem.MolFromSmiles(smiles, sanitize=False)))

    def test_lone_atom_index_is_anchored_and_unsupported_atoms_remain_rejected(self):
        result = inspect("[Cl-]")
        self.assertTrue(result["valid"])
        self.assertEqual((result["atomCount"], result["bondCount"]), (1, 0))
        root = ElementTree.fromstring(result["svg"])
        notes = [node for node in root if "note" in node.get("class", "").split()]
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0].text, "1")
        self.assertEqual(notes[0].get("text-anchor"), "middle")
        self.assertIn("atom-0", notes[0].get("class"))
        self.assertFalse(inspect("[Ne]")["valid"])
        self.assertFalse(inspect("[NH4+].[Cl-]")["valid"])

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
        for text in ["[Fe]", "[CH3]", "CC.O", "C" * 81, "ClP(F)(F)(F)F"]:
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
