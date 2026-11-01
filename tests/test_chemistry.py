import math
import unittest
import numpy as np
from rdkit import Chem
from rdkit.Chem import rdMolTransforms, AllChem
from rdkit.Geometry import Point3D
from chemistry import process, ChemistryError


def model(smiles, samples=3):
    return process({"smiles": smiles, "samples": samples})


def mol_of(data):
    return Chem.MolFromMolBlock(data["molblock"], removeHs=False)


def angle(data, a, b, c):
    mol = mol_of(data)
    return rdMolTransforms.GetAngleDeg(mol.GetConformer(), a, b, c)


class ChemistryTests(unittest.TestCase):
    def test_methane_tetrahedral(self):
        m = model("C")
        self.assertEqual(m["formula"], "CH4")
        self.assertEqual(m["atoms"][0]["hybridization"], "SP3")
        self.assertAlmostEqual(angle(m, 1, 0, 2), 109.47, delta=.2)
        self.assertEqual(len(m["atoms"][0]["lonePairs"]), 0)

    def test_water_bent_with_two_lone_pairs(self):
        m = model("O")
        self.assertEqual(m["formula"], "H2O")
        self.assertAlmostEqual(angle(m, 1, 0, 2), 104.5, delta=2.5)
        self.assertEqual(len(m["atoms"][0]["lonePairs"]), 2)
        pairs = [np.array(p["direction"]) for p in m["atoms"][0]["lonePairs"]]
        self.assertLess(float(pairs[0] @ pairs[1]), 0)

    def test_ammonia_pyramidal(self):
        m = model("N")
        self.assertEqual(len(m["atoms"][0]["lonePairs"]), 1)
        self.assertGreater(angle(m, 1, 0, 2), 100)
        self.assertLess(angle(m, 1, 0, 2), 115)
        xyz = np.array([a["position"] for a in m["atoms"]])
        self.assertGreater(abs(np.linalg.det(xyz[1:] - xyz[0])), .1)

    def test_ethene_planar_and_pi_locked(self):
        m = model("C=C")
        points = np.array([a["position"] for a in m["atoms"]])
        self.assertLess(np.linalg.svd(points - points.mean(axis=0))[1][-1], .01)
        self.assertFalse(m["bonds"][0]["rotatable"])
        with self.assertRaises(ChemistryError):
            process({"action": "rotate", "molblock": m["molblock"], "bond": [0, 1], "angle": 30})

    def test_triple_bond_linear_and_locked(self):
        m = model("C#N")
        self.assertAlmostEqual(angle(m, 1, 0, 2), 180, delta=.2)
        self.assertFalse(m["bonds"][0]["rotatable"])
        self.assertEqual(len(m["atoms"][1]["lonePairs"]), 1)

    def test_e_z_geometry(self):
        e = mol_of(model("F/C=C/F"))
        z = mol_of(model("F/C=C\\F"))
        de = abs(rdMolTransforms.GetDihedralDeg(e.GetConformer(), 0, 1, 2, 3))
        dz = abs(rdMolTransforms.GetDihedralDeg(z.GetConformer(), 0, 1, 2, 3))
        self.assertGreater(de, 170)
        self.assertLess(dz, 10)

    def test_chiral_roundtrip_graph(self):
        m = model("C[C@H](O)F")
        rebuilt = process({"graph": m["graph"], "samples": 2})
        self.assertEqual(m["smiles"], rebuilt["smiles"])
        self.assertTrue(m["stereoSummary"]["centers"])
        self.assertEqual(m["stereoSummary"]["centers"], rebuilt["stereoSummary"]["centers"])

    def test_ez_roundtrip_graph(self):
        for smiles in ["F/C=C/F", "F/C=C\\F"]:
            m = model(smiles)
            rebuilt = process({"graph": m["graph"], "samples": 2})
            self.assertEqual(m["smiles"], rebuilt["smiles"])

    def test_amide_lock_and_delocalized_pair(self):
        m = model("CC(=O)N")
        cn = next(b for b in m["bonds"] if {b["a"], b["b"]} == {1, 3})
        self.assertFalse(cn["rotatable"])
        self.assertEqual(m["atoms"][3]["lonePairs"][0]["kind"], "delocalized")
        with self.assertRaises(ChemistryError):
            process({"action": "rotate", "molblock": m["molblock"], "bond": [1, 3], "angle": 20})

    def test_aromatic_ring_lock_and_lp(self):
        pyridine = model("c1ccncc1")
        self.assertTrue(all(not b["rotatable"] for b in pyridine["bonds"] if b["aromatic"]))
        self.assertEqual(pyridine["atoms"][3]["lonePairs"][0]["kind"], "localized")
        pyrrole = model("c1cc[nH]c1")
        self.assertEqual(pyrrole["atoms"][3]["lonePairs"][0]["kind"], "delocalized")

    def test_ring_geometry_and_lock(self):
        m = model("C1CCCCC1")
        points = np.array([a["position"] for a in m["atoms"] if a["element"] == "C"])
        self.assertGreater(np.linalg.svd(points - points.mean(axis=0))[1][-1], .2)
        self.assertTrue(all(not b["rotatable"] for b in m["bonds"] if b["inRing"]))

    def test_butane_rotate_and_maintain_bond_lengths(self):
        m = model("CCCC")
        result = process({"action": "rotate", "molblock": m["molblock"], "bond": [1, 2], "angle": 60})
        old, new = mol_of(m), mol_of(result)
        a = rdMolTransforms.GetDihedralDeg(old.GetConformer(), 0, 1, 2, 3)
        b = rdMolTransforms.GetDihedralDeg(new.GetConformer(), 0, 1, 2, 3)
        diff = (b - a + 180) % 360 - 180
        self.assertAlmostEqual(abs(diff), 60, delta=.05)
        for before, after in zip(m["bonds"], result["bonds"]):
            self.assertAlmostEqual(before["length"], after["length"], delta=.001)
        self.assertNotAlmostEqual(m["energy"], result["energy"], delta=.01)

    def test_conjugated_single_has_barrier_warning(self):
        m = model("C=CC=C")
        single = next(b for b in m["bonds"] if b["a"] == 1 and b["b"] == 2)
        self.assertTrue(single["rotatable"])
        self.assertTrue(single["conjugated"])

    def test_formal_charge_lone_pair_count(self):
        self.assertEqual(len(model("[NH4+]")["atoms"][0]["lonePairs"]), 0)
        self.assertEqual(len(model("[O-]C=O")["atoms"][0]["lonePairs"]), 3)

    def test_invalid_valence_rejected(self):
        with self.assertRaises(ChemistryError):
            model("C(C)(C)(C)(C)C")
        with self.assertRaises(ChemistryError):
            model("N(=O)(=O)=O")

    def test_radicals_and_metals_and_fragments_rejected(self):
        for smiles in ["[CH3]", "[Fe]", "CC.O"]:
            with self.subTest(smiles=smiles), self.assertRaises(ChemistryError):
                model(smiles)

    def test_unspecified_stereo_warned(self):
        m = model("CC(O)F")
        self.assertTrue(any("未指定" in w for w in m["warnings"]))
        alkene = model("FC=CF")
        self.assertTrue(any("E/Z" in w for w in alkene["warnings"]))

    def test_conformer_exports_correspond(self):
        m = model("CCCCCC", 8)
        self.assertGreater(len(m["conformers"]), 1)
        self.assertEqual([c["energy"] for c in m["conformers"]], sorted(c["energy"] for c in m["conformers"]))
        for conformer in m["conformers"]:
            mol = Chem.MolFromMolBlock(conformer["molblock"], removeHs=False)
            self.assertLess(np.max(np.abs(np.array(conformer["positions"]) - mol.GetConformer().GetPositions())), .0001)

    def test_optimize_and_analyze(self):
        m = model("CCO")
        optimized = process({"action": "optimize", "molblock": m["molblock"]})
        analyzed = process({"action": "analyze", "molblock": m["molblock"]})
        self.assertEqual(m["formula"], optimized["formula"])
        self.assertAlmostEqual(m["energy"], analyzed["energy"], delta=.01)
        self.assertLessEqual(optimized["energy"], analyzed["energy"] + .001)

    def test_graph_validation(self):
        with self.assertRaises(ChemistryError):
            process({"graph": {"atoms": [{"id": 0, "element": "C"}], "bonds": [{"a":0,"b":0,"order":1}]}})

    def test_analyze_rejects_2d_instead_of_claiming_3d(self):
        mol = Chem.MolFromSmiles("CCO")
        AllChem.Compute2DCoords(mol)
        with self.assertRaises(ChemistryError):
            process({"action": "analyze", "molblock": Chem.MolToMolBlock(mol)})

    def test_analyze_rejects_coincident_bonded_atoms(self):
        mol = mol_of(model("CC"))
        mol.GetConformer().SetAtomPosition(1, mol.GetConformer().GetAtomPosition(0))
        with self.assertRaises(ChemistryError):
            process({"action": "analyze", "molblock": Chem.MolToMolBlock(mol)})

    def test_isotope_graph_ids_preserve_original_selection(self):
        m = model("[2H]C(O)F")
        for atom in m["graph"]["atoms"]:
            source = m["atoms"][atom["id"]]
            self.assertEqual(atom["element"], source["element"])
            self.assertEqual(atom["isotope"], source["isotope"])
        rebuilt = process({"graph": m["graph"], "samples": 1})
        self.assertEqual(m["smiles"], rebuilt["smiles"])

    def test_co2_uses_documented_reference_geometry(self):
        m = model("O=C=O")
        self.assertIn("NIST", m["method"])
        self.assertIsNone(m["energy"])
        self.assertAlmostEqual(angle(m, 0, 1, 2), 180, delta=.001)
        for bond in m["bonds"]:
            self.assertAlmostEqual(bond["length"], 1.1621, delta=.00001)
            self.assertFalse(bond["rotatable"])
        self.assertEqual([len(a["lonePairs"]) for a in m["atoms"]], [2, 0, 2])
        self.assertIn("cccbdb.nist.gov", m["geometrySource"]["referenceUrl"])

    def test_co2_import_preserved_and_optimize_restores_reference(self):
        m = model("O=[13C]=O")
        mol = mol_of(m)
        center = next(a.GetIdx() for a in mol.GetAtoms() if a.GetSymbol() == "C")
        oxygen = [a.GetIdx() for a in mol.GetAtoms() if a.GetSymbol() == "O"]
        mol.GetConformer().SetAtomPosition(oxygen[0], Point3D(1.3, .2, 0))
        block = Chem.MolToMolBlock(mol)
        imported = process({"action": "analyze", "molblock": block, "stereoGraph": m["graph"]})
        self.assertAlmostEqual(imported["bonds"][0]["length"], math.hypot(1.3, .2), delta=.0001)
        self.assertIsNone(imported["energy"])
        self.assertEqual(imported["atoms"][center]["isotope"], 13)
        optimized = process({"action": "optimize", "molblock": block, "stereoGraph": m["graph"]})
        self.assertAlmostEqual(angle(optimized, oxygen[0], center, oxygen[1]), 180, delta=.01)
        self.assertTrue(all(abs(b["length"] - 1.1621) < .00001 for b in optimized["bonds"]))
        self.assertIsNone(optimized["energy"])
        self.assertEqual(optimized["atoms"][center]["isotope"], 13)

    def test_acetylene_linear_geometry(self):
        m = model("C#C")
        self.assertAlmostEqual(angle(m, 2, 0, 1), 180, delta=.05)
        self.assertAlmostEqual(angle(m, 0, 1, 3), 180, delta=.05)
        self.assertAlmostEqual(m["bonds"][0]["length"], 1.20, delta=.02)

    def test_bf3_planar_with_explicit_uff_distance_limitation(self):
        m = model("FB(F)F")
        for a, b in [(0, 2), (0, 3), (2, 3)]:
            self.assertAlmostEqual(angle(m, a, 1, b), 120, delta=.05)
        self.assertEqual(len(m["atoms"][1]["lonePairs"]), 0)
        self.assertIn("UFF", m["method"])
        self.assertTrue(any("含硼" in w and "誤差" in w for w in m["warnings"]))

    def test_ammonium_tetrahedral_without_lone_pairs(self):
        m = model("[NH4+]")
        self.assertEqual(m["charge"], 1)
        self.assertEqual(len(m["atoms"][0]["lonePairs"]), 0)
        self.assertAlmostEqual(angle(m, 1, 0, 2), 109.47, delta=.05)

    def test_unvalidated_high_electron_domain_centers_rejected(self):
        for smiles in ["FS(F)(F)F", "FS(F)(F)(F)(F)F", "FP(F)(F)(F)F", "FCl(F)F", "F[I-](F)(F)F"]:
            with self.subTest(smiles=smiles), self.assertRaisesRegex(ChemistryError, "超過四個電子域"):
                model(smiles)

    def test_phosphate_sulfate_remain_tetrahedral_and_delocalized(self):
        for smiles, symbol in [("[O-]P(=O)([O-])[O-]", "P"), ("[O-]S(=O)(=O)[O-]", "S")]:
            m = model(smiles)
            center = next(a["id"] for a in m["atoms"] if a["element"] == symbol)
            oxygens = [a["id"] for a in m["atoms"] if a["element"] == "O"]
            for a, b in [(oxygens[0], oxygens[1]), (oxygens[0], oxygens[2]), (oxygens[1], oxygens[3])]:
                self.assertAlmostEqual(angle(m, a, center, b), 109.47, delta=.1)
            self.assertEqual(len(m["atoms"][center]["lonePairs"]), 0)
            lengths = [b["length"] for b in m["bonds"]]
            self.assertLess(max(lengths)-min(lengths), .002)

    def test_carboxylate_equal_bonds_and_lewis_pair_counts(self):
        m = model("[O-]C(=O)C")
        self.assertEqual(len(m["atoms"][0]["lonePairs"]), 3)
        self.assertEqual(len(m["atoms"][2]["lonePairs"]), 2)
        co_lengths = [b["length"] for b in m["bonds"] if {b["a"], b["b"]} in [{0, 1}, {1, 2}]]
        self.assertLess(abs(co_lengths[0] - co_lengths[1]), .005)
        self.assertTrue(any("Lewis 共振式" in w for w in m["warnings"]))

    def test_internal_coordinate_roundtrip_preserves_unspecified_stereo(self):
        for smiles in ["CC(O)F", "FC=CF"]:
            m = model(smiles)
            for action in ["analyze", "optimize"]:
                rebuilt = process({"action": action, "molblock": m["molblock"], "stereoGraph": m["graph"]})
                self.assertEqual(rebuilt["smiles"], m["smiles"])
                self.assertFalse(rebuilt["stereoSummary"]["centers"])
                self.assertFalse(rebuilt["stereoSummary"]["doubleBonds"])
                self.assertTrue(any("未指定" in w for w in rebuilt["warnings"]))

    def test_internal_coordinate_roundtrip_keeps_defined_stereo(self):
        for smiles in ["C[C@H](O)F", "F/C=C/F", "F/C=C\\F"]:
            m = model(smiles)
            rebuilt = process({"action": "analyze", "molblock": m["molblock"], "stereoGraph": m["graph"]})
            self.assertEqual(rebuilt["smiles"], m["smiles"])
            self.assertEqual(rebuilt["stereoSummary"], m["stereoSummary"])

    def test_internal_metadata_does_not_override_changed_topology_or_chirality(self):
        m = model("C[C@H](O)F")
        mol = mol_of(m)
        for i, p in enumerate(mol.GetConformer().GetPositions()):
            mol.GetConformer().SetAtomPosition(i, Point3D(-float(p[0]), float(p[1]), float(p[2])))
        with self.assertRaisesRegex(ChemistryError, "四面體"):
            process({"action": "analyze", "molblock": Chem.MolToMolBlock(mol), "stereoGraph": m["graph"]})
        other = model("CCO")
        with self.assertRaisesRegex(ChemistryError, "不一致"):
            process({"action": "analyze", "molblock": m["molblock"], "stereoGraph": other["graph"]})

    def test_external_mol_warns_about_inferred_stereo(self):
        m = model("CC(O)F")
        imported = process({"action": "analyze", "molblock": m["molblock"]})
        self.assertTrue(any("由檔案三維座標推導" in w for w in imported["warnings"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
