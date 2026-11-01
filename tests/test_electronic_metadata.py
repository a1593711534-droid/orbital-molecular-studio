"""Chemical invariants for formula display and resonance presentation data."""
import unittest

import numpy as np
from rdkit import Chem
from rdkit.Chem import rdMolTransforms
from rdkit.Geometry import Point3D

from chemistry import OZONE_BOND_ANGLE, OZONE_BOND_LENGTH, VALENCE_ELECTRONS, process


def model(smiles):
    return process({"smiles": smiles, "samples": 1})


class FormulaMetadataTests(unittest.TestCase):
    def test_conventional_ammonium_keeps_hill_index(self):
        for action in ["inspect", "generate"]:
            m = process({"smiles": "[NH4+]", "action": action, "samples": 1})
            self.assertEqual(m["formula"], "H4N+")
            self.assertEqual(m["displayFormula"], "NH4+")
            self.assertEqual(m["charge"], 1)
            self.assertEqual([(p["element"], p["count"]) for p in m["formulaParts"]], [("N", 1), ("H", 4)])

    def test_conventional_simple_molecules_and_ions(self):
        for smiles, formula, charge in [("N", "NH3", 0), ("O", "H2O", 0),
                                        ("[OH-]", "OH-", -1), ("O[O-]", "HO2-", -1),
                                        ("[O-][N+](=O)[O-]", "NO3-", -1),
                                        ("[O-]P([O-])([O-])=O", "PO4-3", -3),
                                        ("C[N+](=O)[O-]", "CH3NO2", 0)]:
            with self.subTest(smiles=smiles):
                m = process({"smiles": smiles, "action": "inspect"})
                self.assertTrue(m["valid"])
                self.assertEqual(m["displayFormula"], formula)
                self.assertEqual(m["charge"], charge)

    def test_isotope_mass_numbers_and_counts_are_separate(self):
        m = model("[15NH4+]")
        self.assertEqual(m["displayFormula"], "[15N]H4+")
        self.assertEqual(m["formulaParts"][0], {"element": "N", "isotope": 15, "count": 1})
        heavy_water = model("[2H]O[2H]")
        self.assertEqual(heavy_water["displayFormula"], "[2H]2O")
        self.assertEqual(heavy_water["formulaParts"][0], {"element": "H", "isotope": 2, "count": 2})

    def test_explicit_and_implicit_hydrogens_agree_between_preview_and_model(self):
        for smiles in ["[2H]OC", "[13CH3]C(=O)O", "[NH4+]", "c1cc[nH]c1"]:
            with self.subTest(smiles=smiles):
                preview = process({"action": "inspect", "smiles": smiles})
                generated = model(smiles)
                self.assertEqual(preview["formulaParts"], generated["formulaParts"])
                self.assertEqual(preview["displayFormula"], generated["displayFormula"])
                self.assertEqual(sum(p["count"] for p in generated["formulaParts"]), len(generated["atoms"]))


class ResonanceMetadataTests(unittest.TestCase):
    def test_symmetric_oxygen_bonds_are_grouped(self):
        cases = [("[O-][O+]=O", [0, 1], 2, 4, 1.5),
                 ("C[N+](=O)[O-]", [1, 2], 2, 4, 1.5),
                 ("CC(=O)[O-]", [1, 2], 2, 4, 1.5),
                 ("[O-][N+](=O)[O-]", [0, 1, 2], 3, 6, 4 / 3)]
        for smiles, bonds, state_count, pi_electrons, order in cases:
            with self.subTest(smiles=smiles):
                r = model(smiles)["resonance"]
                self.assertFalse(r["truncated"])
                self.assertEqual(len(r["states"]), state_count)
                self.assertEqual(r["groups"][0]["piElectrons"], pi_electrons)
                self.assertEqual(len(r["equivalentBondGroups"]), 1)
                self.assertEqual(r["equivalentBondGroups"][0]["bondIds"], bonds)
                self.assertAlmostEqual(r["equivalentBondGroups"][0]["order"], order)

    def test_input_contributor_does_not_change_equivalence(self):
        for smiles in ["[O-][O+]=O", "O=[O+][O-]", "C[N+]([O-])=O", "CC([O-])=O"]:
            with self.subTest(smiles=smiles):
                m = model(smiles)
                r = m["resonance"]
                self.assertEqual(len(r["equivalentBondGroups"]), 1)
                self.assertEqual(len(r["equivalentBondGroups"][0]["bondIds"]), 2)
                original = r["states"][r["inputFormStateIndex"]]
                self.assertEqual(original["atomCharges"], [a["charge"] for a in m["atoms"]])
                self.assertEqual(original["bondOrders"], [b["order"] for b in m["bonds"]])

    def test_carboxylic_oh_and_carbonyl_are_not_equivalent(self):
        for smiles in ["C(=O)O", "CC(=O)O", "COC=O", "CC(=O)N"]:
            with self.subTest(smiles=smiles):
                m = model(smiles)
                self.assertEqual(m["resonance"]["equivalentBondGroups"], [])
                self.assertEqual(m["resonance"]["groups"][0]["piElectrons"], 4)
                self.assertEqual(len(m["resonance"]["groups"][0]["donorAtomIds"]), 1)

    def test_isotope_labels_prevent_false_symmetry(self):
        m = model("[18O-][O+]=O")
        self.assertEqual(len(m["resonance"]["states"]), 2)
        self.assertEqual(m["resonance"]["equivalentBondGroups"], [])
        self.assertEqual(m["atoms"][0]["isotope"], 18)

    def test_aromatic_kekule_alternatives_are_retained(self):
        m = model("c1ccccc1")
        r = m["resonance"]
        self.assertEqual(len(r["states"]), 2)
        self.assertNotEqual(r["states"][0]["bondOrders"], r["states"][1]["bondOrders"])
        self.assertEqual(len(r["equivalentBondGroups"]), 1)
        self.assertEqual(len(r["equivalentBondGroups"][0]["bondIds"]), 6)
        self.assertEqual(r["groups"][0]["piElectrons"], 6)
        # The source graph and exports remain aromatic, not a rewritten hybrid.
        self.assertTrue(all(b["aromatic"] for b in m["bonds"][:6]))
        self.assertEqual(m["smiles"], "c1ccccc1")

    def test_aromatic_heteroatom_bonds_are_not_all_equivalent(self):
        m = model("c1ccncc1")
        groups = m["resonance"]["equivalentBondGroups"]
        self.assertEqual(sorted(len(g["bondIds"]) for g in groups), [2, 2, 2])
        self.assertEqual(m["resonance"]["groups"][0]["piElectrons"], 6)

    def test_all_contributors_conserve_charge_and_valence_electrons(self):
        for smiles in ["[O-][O+]=O", "C[N+](=O)[O-]", "[O-][N+](=O)[O-]",
                       "CC(=O)[O-]", "CC(=O)O", "CC(=O)N", "c1ccccc1", "c1cc[nH]c1"]:
            with self.subTest(smiles=smiles):
                m = model(smiles)
                electrons = sum(VALENCE_ELECTRONS[a["element"]] for a in m["atoms"]) - m["charge"]
                for state in m["resonance"]["states"]:
                    self.assertEqual(len(state["atomCharges"]), len(m["atoms"]))
                    self.assertEqual(len(state["lonePairCounts"]), len(m["atoms"]))
                    self.assertEqual(len(state["bondOrders"]), len(m["bonds"]))
                    self.assertEqual(sum(state["atomCharges"]), m["charge"])
                    self.assertEqual(2 * (sum(state["bondOrders"]) + sum(state["lonePairCounts"])), electrons)

    def test_saturated_molecule_has_no_invented_pi_system(self):
        for smiles in ["C", "O", "N", "CCO"]:
            with self.subTest(smiles=smiles):
                r = model(smiles)["resonance"]
                self.assertEqual(r["groups"], [])
                self.assertEqual(r["equivalentBondGroups"], [])
                self.assertEqual(len(r["states"]), 1)


class OzoneGeometryTests(unittest.TestCase):
    def test_generated_ozone_uses_equal_reference_bonds_and_no_forcefield_energy(self):
        m = model("[O-][O+]=O")
        self.assertEqual(m["geometrySource"]["type"], "experimental-reference")
        self.assertIsNone(m["energy"])
        self.assertTrue(all(c["energy"] is None for c in m["conformers"]))
        for bond in m["bonds"]:
            self.assertAlmostEqual(bond["length"], OZONE_BOND_LENGTH, places=5)
        mol = Chem.MolFromMolBlock(m["molblock"], removeHs=False)
        self.assertAlmostEqual(rdMolTransforms.GetAngleDeg(mol.GetConformer(), 0, 1, 2), OZONE_BOND_ANGLE, delta=.01)
        self.assertEqual(sum(len(a["lonePairs"]) for a in m["atoms"]), 6)
        self.assertEqual(sum(p["kind"] == "localized" for a in m["atoms"] for p in a["lonePairs"]), 5)

    def test_analyze_preserves_imported_geometry_optimize_applies_reference(self):
        m = model("[O-][O+]=O")
        mol = Chem.MolFromMolBlock(m["molblock"], removeHs=False)
        custom = np.array([[1.45, .1, .4], [0., 0., 0.], [-.8, 1.1, -.1]])
        for i, p in enumerate(custom):
            mol.GetConformer().SetAtomPosition(i, Point3D(*map(float, p)))
        block = Chem.MolToMolBlock(mol)
        imported = process({"action": "analyze", "molblock": block})
        self.assertEqual(imported["geometrySource"]["type"], "imported")
        self.assertIsNone(imported["energy"])
        np.testing.assert_allclose(np.array([a["position"] for a in imported["atoms"]]), custom - custom.mean(axis=0), atol=1e-6)
        optimized = process({"action": "optimize", "molblock": block})
        self.assertEqual(optimized["geometrySource"]["type"], "experimental-reference")
        self.assertIsNone(optimized["energy"])
        for bond in optimized["bonds"]:
            self.assertAlmostEqual(bond["length"], OZONE_BOND_LENGTH, places=5)

    def test_reference_ozone_is_supported_by_input_preview_and_graph_builder(self):
        preview = process({"action": "inspect", "smiles": "[O-][O+]=O"})
        self.assertTrue(preview["valid"])
        original = model("[O-][O+]=O")
        rebuilt = process({"graph": original["graph"], "samples": 1})
        self.assertEqual(rebuilt["smiles"], original["smiles"])
        self.assertEqual(rebuilt["geometrySource"], original["geometrySource"])
        self.assertEqual(rebuilt["resonance"], original["resonance"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
