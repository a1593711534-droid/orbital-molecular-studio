"""Chemical identity and Cartesian coordinates at the editor's API boundaries."""
import copy
import unittest

import numpy as np
from rdkit import Chem
from rdkit.Chem import AllChem, rdCIPLabeler, rdMolTransforms

from chemistry import ChemistryError, process


def generate(smiles, samples=1):
    return process({"action": "generate", "smiles": smiles, "samples": samples})


def from_project(model, action="analyze"):
    return process({"action": action, "molblock": model["molblock"], "stereoGraph": model["graph"]})


def coordinate_labels(block):
    mol = Chem.MolFromMolBlock(block, removeHs=False)
    Chem.RemoveStereochemistry(mol)
    Chem.AssignStereochemistryFrom3D(mol, replaceExistingTags=True)
    rdCIPLabeler.AssignCIPLabels(mol)
    return tuple(tuple((item.GetIdx(), item.GetProp("_CIPCode")) for item in items if item.HasProp("_CIPCode"))
                 for items in (mol.GetAtoms(), mol.GetBonds()))


class AuditStereoTests(unittest.TestCase):
    def test_project_preserves_hydrogen_policy_including_explicit_zero(self):
        for smiles in ["[O-][N+](=O)[O-]", "[NH4+]", "[OH-]", "[2H]O", "CCO"]:
            with self.subTest(smiles=smiles):
                original = generate(smiles)
                def policy(model):
                    return {a["id"]: (a["explicitHs"], a["noImplicit"]) for a in model["graph"]["atoms"]}
                rebuilt = from_project(original)
                self.assertEqual(policy(rebuilt), policy(original))
                self.assertEqual(policy(from_project(rebuilt, "optimize")), policy(original))
                if smiles.startswith("[O-]"):
                    for model in [original, rebuilt]:
                        graph = copy.deepcopy(model["graph"])
                        graph["atoms"][0]["charge"] = 0
                        with self.assertRaisesRegex(ChemistryError, "自由基"):
                            process({"graph": graph})
        old = generate("O")
        for atom in old["graph"]["atoms"]:
            del atom["explicitHs"], atom["noImplicit"]
        self.assertEqual(from_project(old)["formula"], "H2O")
        inconsistent = generate("[NH4+]")
        inconsistent["graph"]["atoms"][0]["explicitHs"] = 3
        with self.assertRaisesRegex(ChemistryError, "氫原子數"):
            from_project(inconsistent)

    def test_unspecified_stereoisomers_are_not_ranked_together(self):
        for smiles, expected_count in [("CC=CC", (0, 1)), ("CC(F)C(Cl)C", (2, 0))]:
            with self.subTest(smiles=smiles):
                model = generate(smiles, 32)
                labels = {coordinate_labels(conf["molblock"]) for conf in model["conformers"]}
                self.assertEqual(len(labels), 1)
                self.assertEqual(tuple(map(len, labels.pop())), expected_count)
                self.assertIn("第一個取樣構型", " ".join(model["warnings"]))
                self.assertFalse(model["stereoSummary"]["centers"])
                self.assertFalse(model["stereoSummary"]["doubleBonds"])
                for conf in model["conformers"]:
                    reopened = from_project({**model, "molblock": conf["molblock"]})
                    self.assertEqual(reopened["smiles"], model["smiles"])
                energies = [conf["energy"] for conf in model["conformers"]]
                self.assertEqual(energies, sorted(energies))
        for smiles, label in [("C/C=C/C", "E"), ("C/C=C\\C", "Z")]:
            for conf in generate(smiles, 8)["conformers"]:
                self.assertEqual(coordinate_labels(conf["molblock"])[1], ((1, label),))

    def test_project_reopens_ligand_label_on_idealized_pcl5(self):
        original = generate("ClP(Cl)(Cl)(Cl)[37Cl]")
        for action in ["analyze", "optimize"]:
            model = from_project(original, action)
            self.assertEqual(model["smiles"], original["smiles"])
            self.assertEqual([a["id"] for a in model["atoms"] if a["isotope"] == 37], [5])
            self.assertEqual(generate(model["smiles"])["geometrySource"]["model"], "AX5")
        original["graph"]["atoms"][1]["chiralTag"] = int(Chem.ChiralType.CHI_TRIGONALBIPYRAMIDAL)
        with self.assertRaisesRegex(ChemistryError, "四面體"):
            from_project(original)

    def test_explicit_atropisomeric_axis_cannot_be_silently_lost(self):
        smiles = "Fc1cccc(Cl)c1-c1c(Br)cccc1I"
        model = generate(smiles)
        for seed, stereo in [(5, Chem.BondStereo.STEREOATROPCW), (14, Chem.BondStereo.STEREOATROPCCW)]:
            mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
            self.assertEqual(AllChem.EmbedMolecule(mol, randomSeed=seed), 0)
            axis = next(b for b in mol.GetBonds() if not b.IsInRing()
                        and b.GetBeginAtom().GetIsAromatic() and b.GetEndAtom().GetIsAromatic())
            ends = [axis.GetBeginAtomIdx(), axis.GetEndAtomIdx()]
            axis.SetStereo(stereo)
            block = Chem.MolToMolBlock(mol, forceV3000=True)
            # Confirm the fixture carries the CTfile wedge marking the axis.
            self.assertEqual(Chem.MolFromMolBlock(block, removeHs=False).GetBondWithIdx(axis.GetIdx()).GetStereo(), stereo)
            for action in ["analyze", "optimize", "rotate"]:
                with self.subTest(stereo=stereo, action=action), self.assertRaisesRegex(ChemistryError, "軸立體"):
                    process({"action": action, "molblock": block, "bond": ends, "angle": 180})
            graph = copy.deepcopy(model["graph"])
            next(b for b in graph["bonds"] if {b["a"], b["b"]} == set(ends))["stereo"] = int(stereo)
            with self.assertRaisesRegex(ChemistryError, "軸立體"):
                process({"graph": graph})

    def test_reference_atom_priority_recurses_before_comparing_isotopes(self):
        for smiles, label, angle in [("[13CH3]/C(CF)=C(/F)Cl", "E", 180),
                                     ("[13CH3]/C(CF)=C(\\F)Cl", "Z", 0)]:
            with self.subTest(smiles=smiles):
                model = generate(smiles)
                double = next(b for b in model["bonds"] if b["order"] == 2)
                control = double["stereoControl"]
                self.assertEqual(control["current"], label)
                self.assertEqual(control["referenceAtoms"], [2, 6])
                conf = Chem.MolFromMolBlock(model["molblock"], removeHs=False).GetConformer()
                actual = rdMolTransforms.GetDihedralDeg(conf, 2, double["a"], double["b"], 6)
                self.assertAlmostEqual(abs(actual), angle, delta=3)

    def test_nonbonded_overlap_is_rejected_before_assigning_geometry(self):
        for smiles, endpoint in [("C", "H"), ("F[Xe](F)(F)F", "F")]:
            with self.subTest(smiles=smiles):
                model = generate(smiles)
                mol = Chem.MolFromMolBlock(model["molblock"], removeHs=False)
                a, b = [atom.GetIdx() for atom in mol.GetAtoms() if atom.GetSymbol() == endpoint][:2]
                self.assertIsNone(mol.GetBondBetweenAtoms(a, b))
                conf = mol.GetConformer()
                conf.SetAtomPosition(a, conf.GetAtomPosition(b))
                for action in ["analyze", "optimize"]:
                    with self.assertRaisesRegex(ChemistryError, "重疊"):
                        process({"action": action, "molblock": Chem.MolToMolBlock(mol)})

    def test_cartesian_frame_survives_mol_xyz_and_project_round_trips(self):
        model = generate("CCO")
        mol = Chem.MolFromMolBlock(model["molblock"], removeHs=False)
        conf = mol.GetConformer()
        positions = conf.GetPositions() + [10, -6, 3]
        for i, point in enumerate(positions):
            conf.SetAtomPosition(i, point)
        imported = process({"action": "analyze", "molblock": Chem.MolToMolBlock(mol)})
        for result in [imported, from_project(imported)]:
            with self.subTest(method=result["method"]):
                np.testing.assert_allclose([a["position"] for a in result["atoms"]], positions, atol=1e-6)
                mol_positions = Chem.MolFromMolBlock(result["molblock"], removeHs=False).GetConformer().GetPositions()
                np.testing.assert_allclose(mol_positions, positions, atol=1e-5)
                xyz_positions = Chem.MolFromXYZBlock(result["xyz"]).GetConformer().GetPositions()
                np.testing.assert_allclose(xyz_positions, positions, atol=1e-6)

    def test_rotations_need_off_axis_atoms_on_both_sides(self):
        for smiles, ends in [("N#CC#N", [1, 2]), ("CC#N", [0, 1])]:
            with self.subTest(smiles=smiles):
                model = generate(smiles)
                bond = next(b for b in model["bonds"] if {b["a"], b["b"]} == set(ends))
                self.assertFalse(bond["rotatable"])
                with self.assertRaisesRegex(ChemistryError, "共線"):
                    process({"action": "rotate", "molblock": model["molblock"], "bond": ends, "angle": 90})
        butyne = generate("CC#CC")
        self.assertTrue(butyne["bonds"][0]["rotatable"])

    def test_ignored_markers_reported_in_preview_and_generation(self):
        for smiles, warn in [("C[C@H](C)O", True), ("C/C=C(/C)C", True), ("C/C", True),
                             ("C/C=C/C", False), ("N[C@@H](C)C(=O)O", False)]:
            with self.subTest(smiles=smiles):
                for result in [process({"action": "inspect", "smiles": smiles}), generate(smiles)]:
                    self.assertEqual(any("已忽略" in note for note in result["warnings"]), warn)
