"""E/Z editing is checked against independently inferred 3D stereochemistry."""
import copy
import unittest

from rdkit import Chem
from rdkit.Chem import rdCIPLabeler, rdMolTransforms
from chemistry import process, ChemistryError


def generate(smiles):
    return process({"action": "generate", "smiles": smiles, "samples": 2})


def doubles(model):
    return [bond for bond in model["bonds"] if bond["order"] == 2]


def assign(model, value, which=0):
    bond = doubles(model)[which]
    return process({"action": "set_stereo", "graph": model["graph"],
                    "bond": [bond["a"], bond["b"]], "stereo": value, "samples": 2})


def actual_labels(block):
    molecule = Chem.MolFromMolBlock(block, removeHs=False)
    Chem.RemoveStereochemistry(molecule)
    Chem.AssignStereochemistryFrom3D(molecule, replaceExistingTags=True)
    for item in list(molecule.GetAtoms()) + list(molecule.GetBonds()):
        if item.HasProp("_CIPCode"):
            item.ClearProp("_CIPCode")
    rdCIPLabeler.AssignCIPLabels(molecule)
    atoms = {a.GetIdx(): a.GetProp("_CIPCode") for a in molecule.GetAtoms() if a.HasProp("_CIPCode")}
    bonds = {b.GetIdx(): b.GetProp("_CIPCode") for b in molecule.GetBonds() if b.HasProp("_CIPCode")}
    return atoms, bonds


class StereoEditingTests(unittest.TestCase):
    def test_atom_by_atom_butene_then_set_both_actual_isomers(self):
        model = generate("C")
        for number in range(1, 4):
            graph = copy.deepcopy(model["graph"])
            graph["atoms"].append({"id": number, "element": "C", "charge": 0})
            graph["bonds"].append({"a": number-1, "b": number, "order": 1})
            model = process({"graph": graph, "samples": 1})
        graph = copy.deepcopy(model["graph"])
        graph["bonds"][1]["order"] = 2
        model = process({"graph": graph, "samples": 1})
        self.assertEqual(doubles(model)[0]["stereoControl"]["current"], "unspecified")
        for value, expected in [("Z", 0), ("E", 180)]:
            model = assign(model, value)
            bond = doubles(model)[0]
            self.assertTrue(bond["stereoControl"]["cisTrans"])
            self.assertEqual(bond["stereoControl"]["current"], value)
            self.assertFalse(bond["rotatable"])
            for conformer in model["conformers"]:
                molecule = Chem.MolFromMolBlock(conformer["molblock"], removeHs=False)
                angle = abs(rdMolTransforms.GetDihedralDeg(molecule.GetConformer(), 0, 1, 2, 3))
                self.assertAlmostEqual(angle, expected, delta=3)
                self.assertEqual(actual_labels(conformer["molblock"])[1][bond["id"]], value)

    def test_clearing_stays_unspecified_through_analyze_optimize_and_graph(self):
        model = assign(generate("CC=CC"), "Z")
        model = assign(model, "unspecified")
        self.assertEqual(model["smiles"], "CC=CC")
        for action in ["analyze", "optimize"]:
            model = process({"action": action, "molblock": model["molblock"], "stereoGraph": model["graph"]})
            self.assertEqual(doubles(model)[0]["stereoControl"]["current"], "unspecified")
            self.assertEqual(model["smiles"], "CC=CC")
        rebuilt = process({"graph": model["graph"], "samples": 1})
        self.assertEqual(doubles(rebuilt)[0]["stereoControl"]["current"], "unspecified")

    def test_edited_configuration_survives_saved_graph_and_mol(self):
        for value in ["E", "Z"]:
            model = assign(generate("CC=CC"), value)
            for action in ["analyze", "optimize"]:
                model = process({"action": action, "molblock": model["molblock"], "stereoGraph": model["graph"]})
                self.assertEqual(doubles(model)[0]["stereoControl"]["current"], value)
                self.assertEqual(actual_labels(model["molblock"])[1][doubles(model)[0]["id"]], value)

    def test_nonsequential_reordered_source_ids(self):
        graph = {"atoms": [{"id": 90, "element": "C"}, {"id": 40, "element": "C"},
                           {"id": 71, "element": "C"}, {"id": 12, "element": "C"}],
                 "bonds": [{"a": 12, "b": 40, "order": 1}, {"a": 40, "b": 71, "order": 2},
                           {"a": 71, "b": 90, "order": 1}]}
        for endpoints in [[40, 71], [71, 40]]:
            model = process({"action": "set_stereo", "graph": graph, "bond": endpoints, "stereo": "Z", "samples": 1})
            bond = doubles(model)[0]
            self.assertEqual(bond["stereoControl"]["current"], "Z")
            self.assertEqual(actual_labels(model["molblock"])[1][bond["id"]], "Z")

    def test_other_explicit_double_bond_and_chiral_center_are_preserved(self):
        original = generate("C[C@H](F)C/C=C/C/C=C/C")
        old_centers, old_bonds = actual_labels(original["molblock"])
        model = assign(original, "Z")
        centers, bonds = actual_labels(model["molblock"])
        self.assertEqual(centers, old_centers)
        first, second = doubles(model)
        self.assertEqual(bonds[first["id"]], "Z")
        self.assertEqual(bonds[second["id"]], old_bonds[second["id"]])

    def test_conjugated_other_assignment_is_preserved(self):
        original = generate("C/C=C/C=C/C")
        model = assign(original, "Z")
        actual = actual_labels(model["molblock"])[1]
        self.assertEqual(actual[doubles(model)[0]["id"]], "Z")
        self.assertEqual(actual[doubles(model)[1]["id"]], "E")

    def test_general_substitution_uses_true_cip_not_chosen_neighbor_order(self):
        for smiles in ["CC(F)=C(Cl)C", "CCC(C)=C(C)CC", "CC=NOC"]:
            for value in ["E", "Z"]:
                with self.subTest(smiles=smiles, value=value):
                    model = assign(generate(smiles), value)
                    bond = doubles(model)[0]
                    self.assertFalse(bond["stereoControl"]["cisTrans"])
                    self.assertEqual(bond["stereoControl"]["current"], value)
                    self.assertEqual(actual_labels(model["molblock"])[1][bond["id"]], value)

    def test_no_ez_for_equivalent_terminal_ring_or_cumulative_centers(self):
        for smiles in ["C=C", "C=CC", "CC(C)=CC", "C1=CCCCC1", "CC=C=CC", "CC=O"]:
            with self.subTest(smiles=smiles):
                model = generate(smiles)
                for index, bond in enumerate(doubles(model)):
                    self.assertFalse(bond["stereoControl"]["editable"])
                    self.assertTrue(bond["stereoControl"]["reason"])
                    with self.assertRaises(ChemistryError):
                        assign(model, "E", index)

    def test_pi_rotation_stays_locked_after_stereo_change(self):
        model = assign(generate("CC=CC"), "Z")
        bond = doubles(model)[0]
        with self.assertRaises(ChemistryError):
            process({"action": "rotate", "molblock": model["molblock"], "stereoGraph": model["graph"],
                     "bond": [bond["a"], bond["b"]], "angle": 180})

    def test_invalid_targets_and_values_fail_without_mutating_input(self):
        model = generate("CC=CC")
        original = copy.deepcopy(model["graph"])
        for endpoints, stereo in [([0, 1], "Z"), ([0, 999], "E"), ([1, 1], "Z"), ([1], "E"), ([1, 2], "cis")]:
            with self.subTest(endpoints=endpoints, stereo=stereo), self.assertRaises(ChemistryError):
                process({"action": "set_stereo", "graph": model["graph"], "bond": endpoints, "stereo": stereo})
        self.assertEqual(model["graph"], original)


if __name__ == "__main__":
    unittest.main()
