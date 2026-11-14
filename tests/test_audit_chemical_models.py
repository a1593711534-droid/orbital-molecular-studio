"""Audit regressions exercised through the public engine entry point."""
import itertools
import unittest

import numpy as np

from chemistry import ChemistryError, VALENCE_ELECTRONS, process


def models(smiles):
    preview = process({"action": "inspect", "smiles": smiles})
    if not preview["valid"]:
        raise AssertionError(preview["message"])
    initial = process({"smiles": smiles, "samples": 1})
    yield initial
    yield process({"graph": initial["graph"], "samples": 1})
    for action in ["analyze", "optimize"]:
        yield process({"action": action, "molblock": initial["molblock"], "stereoGraph": initial["graph"]})


def angles_at_center(model):
    center = max(model["atoms"], key=lambda atom: atom["degree"])
    rays = [np.subtract(atom["position"], center["position"]) for atom in model["atoms"] if atom != center]
    return [np.degrees(np.arccos(np.clip(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b), -1, 1)))
            for a, b in itertools.combinations(rays, 2)]


class AuditChemicalModels(unittest.TestCase):
    def test_pyramidal_and_bent_anions(self):
        for smiles, angle, lone in [("[O-]Cl=O", 116.5, 2), ("[O-]Cl(=O)=O", 109.47, 1),
                                   ("[O-]Br(=O)=O", 109.47, 1), ("[CH3-]", 109.47, 1)]:
            with self.subTest(smiles=smiles):
                for model in models(smiles):
                    np.testing.assert_allclose(angles_at_center(model), angle, atol=.02)
                    self.assertIsNone(model["energy"])
                    center = max(model["atoms"], key=lambda a: a["degree"])
                    self.assertEqual(len(center["lonePairs"]), lone)
                if lone == 2:
                    np.testing.assert_allclose([b["length"] for b in model["bonds"]], 1.567, atol=.0001)
        cation = process({"smiles":"[CH3+]"})
        np.testing.assert_allclose(angles_at_center(cation), 120., atol=.02)

    def test_nitrous_oxide_contributors_retain_identity_and_pi_occupation(self):
        for smiles in ["N#[N+][O-]", "[N-]=[N+]=O", "O=[N+]=[N-]", "[18O-][N+]#N"]:
            with self.subTest(smiles=smiles):
                for model in models(smiles):
                    np.testing.assert_allclose(angles_at_center(model), 180., atol=.01)
                    for bond in model["bonds"]:
                        elements = {model["atoms"][i]["element"] for i in [bond["a"], bond["b"]]}
                        self.assertAlmostEqual(bond["length"], 1.1282 if elements == {"N"} else 1.1842, delta=.0001)
                    resonance = model["resonance"]
                    self.assertEqual([group["piElectrons"] for group in resonance["groups"]], [4, 4])
                    self.assertEqual(len(resonance["states"]), 3)
                    self.assertEqual(resonance["states"][0]["bondOrders"], [b["order"] for b in model["bonds"]])
                    self.assertEqual(sum(p["kind"] == "localized" for a in model["atoms"] for p in a["lonePairs"]), 2)
                    self.assertIsNone(model["energy"])

    def test_no2_radical_spelling_and_charge_controls(self):
        for smiles in ["N(=O)[O]", "O=[N+][O-]", "[18O]N=O"]:
            for model in models(smiles):
                self.assertEqual(model["electronicState"]["multiplicity"], 2)
                self.assertEqual(model["electronicState"]["unpairedElectrons"], 1)
                np.testing.assert_allclose(angles_at_center(model), 134.1, atol=.01)
                for state in model["resonance"]["states"]:
                    self.assertEqual(sum(state["radicalCounts"]), 1)
                    for i, atom in enumerate(model["atoms"]):
                        orders = sum(state["bondOrders"][b["id"]] for b in model["bonds"] if i in [b["a"], b["b"]])
                        self.assertEqual(orders + 2*state["lonePairCounts"][i] + state["radicalCounts"][i],
                                         VALENCE_ELECTRONS[atom["element"]] - state["atomCharges"][i])
        nitrite = process({"smiles": "[O-]N=O"})
        self.assertNotIn("electronicState", nitrite)
        np.testing.assert_allclose(angles_at_center(nitrite), 117.5, atol=.01)

    def test_contributor_independent_drawings_and_input_state(self):
        cases = [("[18O-][O+]=O", "[18O]=[O+][O-]", 1.5),
                 ("O=S=O", "[O-][S+]=O", 1.5),
                 ("[O-]S(=O)(=O)[O-]", "[O-][S+2]([O-])([O-])[O-]", 1.5)]
        for a, b, expected_order in cases:
            for smiles in [a, b]:
                with self.subTest(smiles=smiles):
                    for model in models(smiles):
                        resonance = model["resonance"]
                        group, = resonance["equivalentBondGroups"]
                        self.assertEqual(group["bondIds"], [bond["id"] for bond in model["bonds"]])
                        self.assertEqual(group["order"], expected_order)
                        self.assertEqual(resonance["states"][0]["atomCharges"], [atom["charge"] for atom in model["atoms"]])
                        self.assertEqual(resonance["states"][0]["bondOrders"], [bond["order"] for bond in model["bonds"]])
                        for state in resonance["states"]:
                            self.assertEqual(sum(state["atomCharges"]), model["charge"])
                            electrons = sum(VALENCE_ELECTRONS[atom["element"]] for atom in model["atoms"]) - model["charge"]
                            self.assertEqual(2*(sum(state["bondOrders"]) + sum(state["lonePairCounts"])), electrons)

    def test_single_ion_model_and_invalid_charge(self):
        for smiles, count in [("[H-]", 1), ("[2H-]", 1), ("[O-2]", 4), ("[Cl-]", 4), ("[H+]", 0)]:
            for model in models(smiles):
                self.assertIsNone(model["energy"])
                self.assertEqual(len(model["atoms"][0]["lonePairs"]), count)
                self.assertEqual(model["resonance"]["states"][0]["lonePairCounts"], [count])
        self.assertFalse(process({"action":"inspect", "smiles":"[F-3]"})["valid"])
        with self.assertRaisesRegex(ChemistryError, "單原子離子"):
            process({"smiles":"[F-3]"})

    def test_quantitative_reference_and_torsion_limit(self):
        for model in models("S=C=S"):
            np.testing.assert_allclose([b["length"] for b in model["bonds"]], 1.554, atol=.0001)
            self.assertIsNone(model["energy"])
        for model in models("OO"):
            self.assertIsNotNone(model["energy"])
            self.assertTrue(any("119.8°" in w and "111.5°" in w for w in model["warnings"]))
