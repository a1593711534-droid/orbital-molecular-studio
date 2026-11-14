"""Cross-entry-point regressions for introductory molecular geometry."""
import itertools
import unittest

import numpy as np
from rdkit import Chem
from rdkit.Geometry import Point3D

from chemistry import ChemistryError, VALENCE_ELECTRONS, process


def generate(smiles):
    return process({"smiles": smiles, "samples": 1})


def angles(directions):
    return sorted(round(np.degrees(np.arccos(np.clip(np.dot(a, b), -1, 1))))
                  for a, b in itertools.combinations(directions, 2))


class EducationalGeometryTests(unittest.TestCase):
    def assert_electron_count(self, model):
        electrons = sum(VALENCE_ELECTRONS[a["element"]] for a in model["atoms"]) - model["charge"]
        for state in model["resonance"]["states"]:
            self.assertEqual(sum(state["atomCharges"]), model["charge"])
            self.assertEqual(2 * (sum(state["bondOrders"]) + sum(state["lonePairCounts"]))
                             + sum(state["radicalCounts"]), electrons)

    def test_vsepr_counts_shapes_and_roundtrips(self):
        templates = [
            ("Cl[Be]Cl", "BeCl2", "AX2", 0, [180]),
            ("FB(F)F", "BF3", "AX3", 0, [120] * 3),
            ("FP(F)(F)(F)F", "PF5", "AX5", 0, [90]*6 + [120]*3 + [180]),
            ("ClP(Cl)(Cl)(Cl)Cl", "PCl5", "AX5", 0, [90]*6 + [120]*3 + [180]),
            ("FS(F)(F)F", "SF4", "AX4E", 1, [90]*4 + [120,180]),
            ("FCl(F)F", "ClF3", "AX3E2", 2, [90,90,180]),
            ("FBr(F)F", "BrF3", "AX3E2", 2, [90,90,180]),
            ("F[Xe]F", "XeF2", "AX2E3", 3, [180]),
            ("F[Xe](F)(F)F", "XeF4", "AX4E2", 2, [90]*4 + [180]*2),
            ("FS(F)(F)(F)(F)F", "SF6", "AX6", 0, [90]*12 + [180]*3),
        ]
        for smiles, formula, ax, pair_count, expected in templates:
            with self.subTest(formula=formula):
                preview = process({"action":"inspect", "smiles":smiles})
                self.assertTrue(preview["valid"], preview["message"])
                self.assertEqual(preview["displayFormula"], formula)
                original = generate(smiles)
                rebuilt = process({"graph":original["graph"], "samples":1})
                restored = process({"action":"optimize", "molblock":original["molblock"],
                                    "stereoGraph":original["graph"]})
                for model in (original, rebuilt, restored):
                    self.assertEqual(model["geometrySource"]["type"], "idealized-vsepr")
                    self.assertEqual(model["geometrySource"]["model"], ax)
                    self.assertIsNone(model["energy"])
                    center = max(model["atoms"], key=lambda a: a["degree"])
                    position = np.asarray(center["position"])
                    vectors = [np.asarray(a["position"])-position for a in model["atoms"] if a is not center]
                    directions = [v/np.linalg.norm(v) for v in vectors]
                    self.assertEqual(angles(directions), expected)
                    lone = [np.asarray(p["direction"]) for p in center["lonePairs"]]
                    self.assertEqual(len(lone), pair_count)
                    self.assertTrue(all(np.dot(p, v) < .001 for p in lone for v in directions))
                    self.assert_electron_count(model)

    def test_open_shell_state_is_distinct_from_lewis_radicals(self):
        for smiles, electrons, multiplicity, lewis_radicals in [
                ("O=O", 12, 3, 0), ("[18O]=O", 12, 3, 0),
                ("[N]=O", 11, 2, 1), ("O=[N+][O-]", 17, 2, 1)]:
            with self.subTest(smiles=smiles):
                original = generate(smiles)
                for model in (original, process({"graph":original["graph"]}),
                              process({"action":"analyze", "molblock":original["molblock"]})):
                    state = model["electronicState"]
                    self.assertEqual(state["multiplicity"], multiplicity)
                    self.assertEqual(state["unpairedElectrons"], multiplicity-1)
                    self.assertEqual(sum(a["radicals"] for a in model["atoms"]), lewis_radicals)
                    self.assertEqual(sum(VALENCE_ELECTRONS[a["element"]] for a in model["atoms"]), electrons)
                    self.assertEqual(model["resonance"]["groups"], [])
                    self.assertIsNone(model["energy"])
                    self.assert_electron_count(model)
        self.assertNotIn("electronicState", generate("OO"))  # H2O2
        self.assertNotIn("electronicState", generate("N=O"))  # HNO

    def test_reference_lengths_and_optimize(self):
        for smiles, length in [("N#N",1.0977), ("[H][H]",.7414), ("ClCl",1.9879),
                               ("Cl",1.2746), ("[C-]#[O+]",1.1282), ("O=O",1.2075),
                               ("[N]=O",1.1508), ("O=[N+][O-]",1.193), ("O=S=O",1.432),
                               ("[C-]#N",1.177), ("[O-]N=O",1.25)]:
            with self.subTest(smiles=smiles):
                original = generate(smiles)
                for m in (original, process({"action":"optimize","molblock":original["molblock"]})):
                    self.assertEqual(m["geometrySource"]["type"], "experimental-reference")
                    self.assertTrue(all(abs(b["length"]-length) < .0001 for b in m["bonds"]))
                    self.assertIsNone(m["energy"])
        for smiles, expected in [("O=[N+][O-]", 134), ("O=S=O",120)]:
            model = generate(smiles)
            pos = np.array([a["position"] for a in model["atoms"]])
            vectors = pos[[0,2]]-pos[1]
            self.assertEqual(angles([v/np.linalg.norm(v) for v in vectors]), [expected])

    def test_import_preserves_coordinates_and_assigns_lone_pairs_after_permutation(self):
        model = generate("FS(F)(F)F")
        mol = Chem.MolFromMolBlock(model["molblock"], removeHs=False, sanitize=False)
        pos = np.array(mol.GetConformer().GetPositions()) + [12., -6., 3.]
        pos[[0,4]] = pos[[4,0]]  # exchange an axial and an equatorial F coordinate
        for i,p in enumerate(pos):
            mol.GetConformer().SetAtomPosition(i,Point3D(*map(float,p)))
        result = process({"action":"analyze","molblock":Chem.MolToMolBlock(mol)})
        np.testing.assert_allclose([a["position"] for a in result["atoms"]], pos, atol=.0001)
        self.assertEqual(result["geometrySource"]["type"], "imported")
        center = result["atoms"][1]
        lp = np.asarray(center["lonePairs"][0]["direction"])
        for j in (0,2,3,4):
            direction = pos[j]-pos[1]
            self.assertLess(np.dot(lp,direction/np.linalg.norm(direction)), .001)

    def test_equivalent_terminal_oxygens_keep_integer_lewis_contributors(self):
        for smiles, count, order in [("[O-]S(=O)(=O)[O-]",6,1.5), ("[O-]P(=O)([O-])[O-]",4,1.25),
                                     ("[O-]S(=O)[O-]",3,4/3), ("O=[N+][O-]",2,1.5),
                                     ("[O-][S+]=O",2,1.5)]:
            with self.subTest(smiles=smiles):
                model = generate(smiles)
                resonance = model["resonance"]
                self.assertEqual(len(resonance["states"]), count)
                group, = resonance["equivalentBondGroups"]
                self.assertEqual(len(group["bondIds"]), len(model["bonds"]))
                self.assertAlmostEqual(group["order"], order)
                self.assert_electron_count(model)

    def test_ions_and_boundaries(self):
        for smiles, charge in [("[Na+]",1), ("[K+]",1), ("[Mg+2]",2), ("[Ca+2]",2),
                               ("[Al+3]",3), ("[Cl-]",-1), ("[Br-]",-1)]:
            with self.subTest(smiles=smiles):
                model = generate(smiles)
                self.assertEqual(model["geometrySource"]["type"], "isolated-ion")
                self.assertEqual(model["charge"], charge)
                self.assertEqual(len(model["atoms"]), 1)
                self.assertEqual(model["bonds"], [])
                self.assert_electron_count(model)
        for smiles in ["[Na+].[Cl-]", "[Na]Cl", "C(C)(C)(C)(C)C", "FCl(F)(F)F", "[CH3]"]:
            with self.subTest(smiles=smiles):
                self.assertFalse(process({"action":"inspect","smiles":smiles})["valid"])
                with self.assertRaises(ChemistryError):
                    generate(smiles)
