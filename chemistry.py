"""Local molecular geometry engine. Coordinates in Å; MMFF/UFF energies in kcal/mol.

Lone-pair lobes are Lewis/VSEPR teaching glyphs, never computed electron density.
See RDKit Book, Conformer Generation, Molecular Sanitization and Stereochemistry.
"""
from __future__ import annotations

import math
import itertools
import re
from collections import Counter
from typing import Any

import numpy as np
from rdkit import Chem, rdBase
from rdkit.Chem import AllChem, Descriptors, rdMolDescriptors, rdCIPLabeler
from rdkit.Chem import rdDepictor
from rdkit.Chem.Draw import rdMolDraw2D
from rdkit.Geometry import Point3D

SUPPORTED = {"H", "Be", "B", "C", "N", "O", "F", "Na", "Mg", "Al", "Si", "P", "S", "Cl", "K", "Ca", "Br", "I", "Xe"}
VALENCE_ELECTRONS = {"H": 1, "B": 3, "C": 4, "N": 5, "O": 6, "F": 7,
                     "Si": 4, "P": 5, "S": 6, "Cl": 7, "Br": 7, "I": 7,
                     "Be": 2, "Xe": 8, "Na": 1, "Mg": 2, "Al": 3, "K": 1, "Ca": 2}
ISOLATED_IONS = {("H", 1), ("H", -1), ("Na", 1), ("K", 1), ("Mg", 2),
                 ("Ca", 2), ("Al", 3), ("N", -3), ("O", -2), ("S", -2),
                 ("F", -1), ("Cl", -1), ("Br", -1), ("I", -1)}
VSEPR_REFERENCE_URL = "https://openstax.org/books/chemistry-2e/pages/7-6-molecular-structure-and-polarity"
BOND_TYPES = {1: Chem.BondType.SINGLE, 1.5: Chem.BondType.AROMATIC,
              2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}
BASE_WARNING = "座標是孤立分子的力場構象估計，非實驗結構或量子化學結果；孤電子對葉瓣僅示意 Lewis 電子計數與局部方向，並非電子密度。"
CO2_REFERENCE_URL = "https://cccbdb.nist.gov/exp2x.asp?casno=124389&charge=0"
CO2_BOND_LENGTH = 1.1621  # NIST CCCBDB gas-phase experimental Cartesian geometry.
OZONE_REFERENCE_URL = "https://cccbdb.nist.gov/expgeom2x.asp?casno=10028156&charge=0"
OZONE_BOND_LENGTH = 1.278
OZONE_BOND_ANGLE = 116.8

# Deliberately finite educational coverage. A parameterized force field alone
# is not evidence for the geometry of an unfamiliar inorganic compound.
_SQRT3 = math.sqrt(3)
_TBP = [[0., 0., 1.], [0., 0., -1.], [1., 0., 0.], [-.5, _SQRT3/2, 0.], [-.5, -_SQRT3/2, 0.]]
_OCT = [[1., 0., 0.], [-1., 0., 0.], [0., 1., 0.], [0., -1., 0.], [0., 0., 1.], [0., 0., -1.]]
_TET = [[x/math.sqrt(3) for x in v] for v in [[1,1,1], [1,-1,-1], [-1,1,-1], [-1,-1,1]]]
_VSEPR_SHAPES = {
    (2, 0): ("AX2", "直線形", "直線形", [[1.,0.,0.], [-1.,0.,0.]], []),
    (3, 0): ("AX3", "平面三角形", "平面三角形", _TBP[2:], []),
    (4, 0): ("AX4", "四面體", "四面體", _TET, []),
    (3, 1): ("AX3E", "三角錐形", "四面體", _TET[:3], _TET[3:]),
    (5, 0): ("AX5", "三角雙錐", "三角雙錐", _TBP, []),
    (4, 1): ("AX4E", "蹺蹺板形", "三角雙錐", _TBP[:2]+_TBP[3:], _TBP[2:3]),
    (3, 2): ("AX3E2", "T 形", "三角雙錐", _TBP[:3], _TBP[3:]),
    (2, 3): ("AX2E3", "直線形", "三角雙錐", _TBP[:2], _TBP[2:]),
    (6, 0): ("AX6", "八面體", "八面體", _OCT, []),
    (4, 2): ("AX4E2", "平面正方形", "八面體", _OCT[:4], _OCT[4:]),
}


def _teaching_spec(mol):
    """Recognize exact supported stars before sanitization, never arbitrary valence."""
    if not 3 <= mol.GetNumAtoms() <= 7:
        return None
    if any(a.GetIsAromatic() or a.GetNumExplicitHs() or a.GetNumRadicalElectrons() for a in mol.GetAtoms()):
        return None
    centers = [a for a in mol.GetAtoms() if a.GetDegree() == mol.GetNumAtoms()-1 and a.GetDegree() >= 2]
    if len(centers) != 1 or mol.GetNumBonds() != mol.GetNumAtoms()-1:
        return None
    center = centers[0]
    ends = list(center.GetNeighbors())
    if any(a.GetDegree() != 1 for a in ends):
        return None
    symbol, ligands = center.GetSymbol(), {a.GetSymbol() for a in ends}
    degree = len(ends)
    orders = [b.GetBondTypeAsDouble() for b in center.GetBonds()]
    pairs = None
    halides = {("Be", "Cl", 2): 0, ("B", "F", 3): 0, ("B", "Cl", 3): 0,
               ("P", "F", 5): 0, ("P", "Cl", 5): 0, ("S", "F", 4): 1,
               ("S", "F", 6): 0, ("Cl", "F", 3): 2, ("Br", "F", 3): 2,
               ("Xe", "F", 2): 3, ("Xe", "F", 4): 2}
    if len(ligands) == 1 and (symbol, next(iter(ligands)), degree) in halides:
        if all(a.GetFormalCharge() == 0 for a in mol.GetAtoms()) and all(order == 1 for order in orders):
            pairs = halides[(symbol, next(iter(ligands)), degree)]
    if (symbol == "C" and center.GetFormalCharge() == -1 and degree == 3 and ligands == {"H"}
            and all(a.GetFormalCharge() == 0 for a in ends) and all(order == 1 for order in orders)):
        pairs = 1
    oxyanions = {("C", 3, -2): 0, ("N", 3, -1): 0, ("S", 3, 0): 0, ("S", 3, -2): 1,
                 ("S", 4, -2): 0, ("P", 4, -3): 0, ("Cl", 3, -1): 1, ("Br", 3, -1): 1}
    oxy_key = (symbol, degree, sum(a.GetFormalCharge() for a in mol.GetAtoms()))
    if ligands == {"O"} and oxy_key in oxyanions:
        if all((mol.GetBondBetweenAtoms(center.GetIdx(), a.GetIdx()).GetBondTypeAsDouble(), a.GetFormalCharge()) in {(1., -1), (2., 0)} for a in ends):
            if VALENCE_ELECTRONS[symbol] - center.GetFormalCharge() - sum(orders) == 2*oxyanions[oxy_key]:
                # C/N cannot exceed an octet even when a relaxed path exists for Cl.
                if symbol not in {"C", "N"} or sum(orders) <= 4:
                    pairs = oxyanions[oxy_key]
    if pairs is None:
        return None
    model, shape, geometry, directions, lone = _VSEPR_SHAPES[(degree, pairs)]
    return {"center": center.GetIdx(), "ends": [a.GetIdx() for a in ends], "model": model,
            "shape": shape, "electronGeometry": geometry, "directions": directions,
            "loneDirections": lone, "type": "idealized-vsepr"}


def _reference_spec(mol):
    """Verified gas-phase references for species poorly served by organic force fields."""
    if mol.GetNumAtoms() not in {2, 3} or any(a.GetNumExplicitHs() for a in mol.GetAtoms()):
        return None
    symbols = sorted(a.GetSymbol() for a in mol.GetAtoms())
    charges = sorted(a.GetFormalCharge() for a in mol.GetAtoms())
    orders = sorted(b.GetBondTypeAsDouble() for b in mol.GetBonds())
    common = {"type": "experimental-reference"}
    if len(symbols) == 2 and mol.GetNumBonds() == 1:
        neutral_diatomics = {
            ("N", "N", 3.): ("N₂", 1.0977, "7727379"),
            ("H", "H", 1.): ("H₂", .7414, "1333740"),
            ("Cl", "H", 1.): ("HCl", 1.2746, "7647010"),
            ("Cl", "Cl", 1.): ("Cl₂", 1.9879, "7782505"),
        }
        key = (*symbols, orders[0])
        if charges == [0, 0] and key in neutral_diatomics:
            name, length, cas = neutral_diatomics[key]
            return {**common, "name": name, "length": length, "cas": cas}
        if symbols == ["O", "O"] and charges == [0, 0] and orders == [2.]:
            return {**common, "name": "O₂", "length": 1.2075, "cas": "7782447", "multiplicity": 3, "unpaired": 2}
        if symbols == ["N", "O"] and charges == [0, 0] and orders == [2.]:
            return {**common, "name": "NO", "length": 1.1508, "cas": "10102439", "multiplicity": 2, "unpaired": 1}
        if symbols == ["C", "O"] and orders == [3.] and all(a.GetFormalCharge() == (-1 if a.GetSymbol() == "C" else 1) for a in mol.GetAtoms()):
            return {**common, "name": "CO", "length": 1.1282, "cas": "630080"}
        if symbols == ["C", "N"] and orders == [3.] and all(a.GetFormalCharge() == (-1 if a.GetSymbol() == "C" else 0) for a in mol.GetAtoms()):
            return {**common, "name": "CN⁻", "length": 1.177, "referenceUrl": "https://doi.org/10.1063/1.464244",
                    "measurement": "氣相光電子光譜推估 C–N 為 1.177 ± 0.004 Å。"}
    if len(symbols) == 3 and mol.GetNumBonds() == 2:
        center = next((a for a in mol.GetAtoms() if a.GetDegree() == 2), None)
        if center is None:
            return None
        ends = {a.GetSymbol(): a for a in center.GetNeighbors()}
        if center.GetSymbol() == "C" and set(ends) == {"S"} and orders == [2., 2.] and charges == [0, 0, 0]:
            return {**common, "name": "CS₂", "center": center.GetIdx(), "length": 1.554, "angle": 180., "cas": "75150"}
        if center.GetSymbol() == "N" and set(ends) == {"N", "O"} and center.GetFormalCharge() == 1:
            # Check the octet of each named terminus, including the minor N–N≡O contributor.
            if all(a.GetFormalCharge() == a.GetBonds()[0].GetBondTypeAsDouble() - (3 if s == "N" else 2)
                   for s, a in ends.items()) and sum(orders) == 4:
                return {**common, "name": "N₂O", "center": center.GetIdx(), "lengths": {"N": 1.1282, "O": 1.1842},
                        "angle": 180., "cas": "10024972"}
        if set(ends) != {"O"}:
            return None
        if center.GetSymbol() == "Cl" and set(orders) <= {1., 2.} and sum(charges) == -1 and all(
                a.GetFormalCharge() == a.GetBonds()[0].GetBondTypeAsDouble()-2 for a in center.GetNeighbors()):
            return {**common, "name": "ClO₂⁻", "center": center.GetIdx(), "length": 1.567, "angle": 116.5,
                    "referenceUrl": "https://doi.org/10.1016/j.cplett.2007.10.018",
                    "measurement": "氣相光電子光譜的 Franck–Condon 分析推估 Cl–O 為 1.567 ± 0.002 Å，O–Cl–O 為 116.5 ± 0.5°。"}
        if center.GetSymbol() == "N" and orders == [1., 2.] and (
                (center.GetFormalCharge() == 1 and charges == [-1, 0, 1]) or
                (charges == [0, 0, 0] and sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms()) == 1)):
            return {**common, "name": "NO₂", "center": center.GetIdx(), "length": 1.193, "angle": 134.1, "cas": "10102440", "multiplicity": 2, "unpaired": 1}
        if center.GetSymbol() == "N" and orders == [1., 2.] and center.GetFormalCharge() == 0 and charges == [-1, 0, 0]:
            return {**common, "name": "NO₂⁻", "center": center.GetIdx(), "length": 1.25, "angle": 117.5,
                    "referenceUrl": "https://doi.org/10.1021/j100330a017",
                    "measurement": "氣相光電子光譜推估 N–O 為 1.25 ± 0.02 Å，O–N–O 為 117.5 ± 2°。"}
        if center.GetSymbol() == "S" and ((orders == [2., 2.] and charges == [0,0,0]) or (orders == [1.,2.] and charges == [-1,0,1] and center.GetFormalCharge() == 1)):
            return {**common, "name": "SO₂", "center": center.GetIdx(), "length": 1.432, "angle": 119.5, "cas": "7446095"}
    return None


def _is_isolated_ion(mol):
    return (mol.GetNumAtoms() == 1 and mol.GetNumBonds() == 0
            and ((a := mol.GetAtomWithIdx(0)).GetSymbol(), a.GetFormalCharge()) in ISOLATED_IONS
            and a.GetNumExplicitHs() == 0)


def _sanitize(mol):
    spec = _teaching_spec(mol)
    if spec and mol.GetAtomWithIdx(spec["center"]).GetSymbol() in {"Cl", "Br"}:
        # Only the enumerated complete star is exempt from RDKit's organic
        # valence table (which rejects neutral ClF3). No broad valence bypass.
        for atom in mol.GetAtoms():
            atom.SetNoImplicit(True)
        mol.UpdatePropertyCache(strict=False)
        Chem.SanitizeMol(mol, sanitizeOps=Chem.SanitizeFlags.SANITIZE_ALL ^ Chem.SanitizeFlags.SANITIZE_PROPERTIES)
    else:
        Chem.SanitizeMol(mol)


def _without_hydrogens(mol):
    result = Chem.RemoveHs(mol, sanitize=False)
    _sanitize(result)
    return result


def _educational_model(mol, preserve=False):
    spec = _teaching_spec(mol) or _reference_spec(mol)
    ion = _is_isolated_ion(mol)
    if spec is None and not ion:
        raise ChemistryError("沒有適用的教學幾何模型。")
    if not preserve:
        coords = np.zeros((mol.GetNumAtoms(), 3))
        if spec and spec["type"] == "idealized-vsepr":
            c = spec["center"]
            table = Chem.GetPeriodicTable()
            for i, direction in zip(spec["ends"], spec["directions"]):
                # Radius sums establish a display scale only; in particular
                # do not claim equivalent axial/equatorial experimental lengths.
                distance = table.GetRcovalent(mol.GetAtomWithIdx(c).GetAtomicNum()) + table.GetRcovalent(mol.GetAtomWithIdx(i).GetAtomicNum())
                coords[i] = np.array(direction) * distance
        elif spec:
            if mol.GetNumAtoms() == 2:
                coords[1, 0] = spec["length"]
            else:
                c = spec["center"]
                ends = [a.GetIdx() for a in mol.GetAtomWithIdx(c).GetNeighbors()]
                half = math.radians(spec["angle"] / 2)
                for i, sign in zip(ends, [1, -1]):
                    length = spec["lengths"][mol.GetAtomWithIdx(i).GetSymbol()] if "lengths" in spec else spec["length"]
                    coords[i] = length * np.array([sign*math.sin(half), math.cos(half), 0.])
        mol.RemoveAllConformers()
        conf = Chem.Conformer(mol.GetNumAtoms())
        conf.Set3D(True)
        for i, p in enumerate(coords):
            conf.SetAtomPosition(i, Point3D(*map(float, p)))
        mol.AddConformer(conf, assignId=True)
    if ion:
        method, note = "單原子離子 · Lewis 計數", "單原子離子沒有分子鍵角或構象；未模擬溶劑化、離子半徑或鹽類晶格。孤電子對方向為任意繪圖方向。"
        metadata = {"type": "isolated-ion", "energyAvailable": False}
    elif spec["type"] == "idealized-vsepr":
        method = "VSEPR 理想教學幾何 · " + spec["model"]
        note = ("角度為理想 VSEPR 幾何；鍵長只以共價半徑和設定示意尺度，不是實驗鍵長或最佳化結果。"
                "真實孤電子對排斥會使角度偏離理想值；軸向與赤道向鍵長亦可能不同。未採用 d 軌域雜化作為超價成鍵的證據。")
        if mol.GetAtomWithIdx(spec["center"]).GetSymbol() == "Be":
            note += "此為氣相 BeCl₂ 單體的形狀示意；固態結構不同。"
        if mol.GetAtomWithIdx(spec["center"]).GetSymbol() == "P" and any(a.GetSymbol() == "Cl" for a in mol.GetAtoms()):
            note += "此為氣相 PCl₅ 分子示意；固態可形成離子結構。"
        metadata = {key: spec[key] for key in ["type", "model", "shape", "electronGeometry"]}
        metadata.update({"referenceUrl": VSEPR_REFERENCE_URL, "bondLengthModel": "covalent-radius-sum-display-scale", "energyAvailable": False})
        if mol.GetAtomWithIdx(spec["center"]).GetSymbol() == "C" and spec["model"] == "AX3E":
            metadata["referenceUrl"] = "https://doi.org/10.1021/jacs.5b07013"
            note += "甲基負離子的氣相光電子光譜支持三角錐形。"
        if mol.GetAtomWithIdx(spec["center"]).GetSymbol() in {"Cl", "Br"} and spec["model"] == "AX3E":
            metadata["referenceUrl"] = "https://doi.org/10.1103/PhysRev.51.235"
            note += "氯酸根與溴酸根的溶液振動光譜支持三角錐形。"
    else:
        if "cas" in spec:
            method = "NIST 氣相參考幾何 · " + spec["name"]
            note = "採用 NIST CCCBDB 氣相參考幾何。"
            url = f"https://cccbdb.nist.gov/exp2x.asp?casno={spec['cas']}&charge=0"
        else:
            method = "氣相光電子光譜參考幾何 · " + spec["name"]
            note, url = spec["measurement"], spec["referenceUrl"]
        note += "此模型使用參考座標，不提供力場能量。"
        metadata = {"type": spec["type"], "referenceUrl": url, "energyAvailable": False}
        if "lengths" in spec:
            metadata["referenceBondLengths"] = spec["lengths"]
        else:
            metadata["referenceBondLength"] = spec["length"]
        if "angle" in spec:
            metadata["referenceBondAngle"] = spec["angle"]
        if any(a.GetIsotope() for a in mol.GetAtoms()):
            note += "保留同位素標記，幾何近似沿用通常同位素的氣相參考值。"
    if preserve:
        method = "保留輸入座標 · " + method
        metadata["type"] = "imported"
        note += "目前保留匯入座標；按套用參考／理想幾何可重建。"
    result = _serialize(mol, [{"confId": mol.GetConformer().GetId(), "energy": None, "converged": False}], method, [note])
    result["geometrySource"] = metadata
    if spec and spec.get("unpaired"):
        description = (f"{spec['name']} 的基態為{'三重態' if spec['multiplicity'] == 3 else '雙重態'}，有 {spec['unpaired']} 個未成對電子。"
                       "Lewis 圖的鍵、形式電荷與孤電子對僅供電子計數；不代表未成對電子固定在特定原子，亦不顯示未驗證的開殼層 π 軌域。")
        result["electronicState"] = {"multiplicity": spec["multiplicity"], "unpairedElectrons": spec["unpaired"], "description": description}
        result["warnings"].append(description)
    return result


class ChemistryError(ValueError):
    pass


def _formula_metadata(mol):
    """Separate a human-facing formula from the retained Hill index formula.

    Only well-defined conventional families override Hill order. Isotopes are
    kept as separate parts so the UI never confuses a mass number with a count
    or an ionic charge. This is formula formatting, not structure naming.
    """
    counts = Counter((a.GetSymbol(), a.GetIsotope()) for a in mol.GetAtoms())
    counts[("H", 0)] += sum(a.GetTotalNumHs(includeNeighbors=False) for a in mol.GetAtoms())
    counts = Counter({key: value for key, value in counts.items() if value})
    elements = {symbol for symbol, _ in counts}
    order = sorted(elements)
    conventional = False
    if "C" in elements:
        order = [s for s in ["C", "H"] if s in elements] + sorted(elements - {"C", "H"})
    else:
        heavy = elements - {"H"}
        if len(heavy) == 1 and "H" in elements:
            center = next(iter(heavy))
            if center in {"B", "N", "P", "Si"}:
                order, conventional = [center, "H"], True
            elif (center == "O" and Chem.GetFormalCharge(mol) == -1
                  and sum(n for (s, _), n in counts.items() if s == "H") == 1
                  and sum(n for (s, _), n in counts.items() if s == "O") == 1):
                order, conventional = ["O", "H"], True
            elif center in {"O", "S", "F", "Cl", "Br", "I"}:
                order, conventional = ["H", center], True
        centers = elements - {"H", "O"}
        if "O" in elements and len(centers) == 1 and next(iter(centers)) in {"B", "N", "P", "S", "Si", "Cl", "Br", "I"}:
            center = next(iter(centers))
            order, conventional = (["H"] if "H" in elements else []) + [center, "O"], True
    teaching = _teaching_spec(mol)
    if teaching and len(elements) == 2:
        center = mol.GetAtomWithIdx(teaching["center"]).GetSymbol()
        order, conventional = [center, *sorted(elements - {center})], True
    parts = [{"element": symbol, "count": counts[(symbol, isotope)], "isotope": isotope}
             for symbol in order for isotope in sorted(i for s, i in counts if s == symbol)]
    text = "".join((f"[{p['isotope']}{p['element']}]" if p["isotope"] else p["element"])
                   + (str(p["count"]) if p["count"] != 1 else "") for p in parts)
    charge = Chem.GetFormalCharge(mol)
    if charge:
        text += ("+" if charge > 0 else "-") + (str(abs(charge)) if abs(charge) != 1 else "")
    return {"displayFormula": text, "formulaParts": parts, "formulaOrder": "conventional" if conventional else "hill"}


def _input_hint(smiles):
    """Recognize unfinished SMILES without trying to repair its chemistry.

    Bracket contents have their own grammar: isotope numbers and explicit H
    counts must not be mistaken for ring closures. RDKit remains the authority
    for parsing and valence after these incremental-input hints.
    """
    if not smiles:
        return "先加入一個原子，或貼上結構式。"
    if len(smiles) > 4000:
        return "輸入太長，請限制在 4000 個字元內。"
    if any(ch.isspace() for ch in smiles):
        return "結構式內不需要空格；請只保留分子的 SMILES。"
    bracket = False
    branches = 0
    rings = {}
    i = 0
    while i < len(smiles):
        ch = smiles[i]
        if ch == "[":
            if bracket:
                return "方括號不能重疊，請先完成目前的原子。"
            bracket = True
        elif ch == "]":
            if not bracket:
                return "多了一個 ]，請移除或補上前面的 [。"
            bracket = False
        elif not bracket:
            if ch == "(":
                branches += 1
            elif ch == ")":
                branches -= 1
                if branches < 0:
                    return "多了一個 )，請移除或補上支鏈的 (。"
            elif ch.isascii() and ch.isdigit():
                rings[ch] = rings.get(ch, 0) + 1
            elif ch == "%":
                token = re.match(r"%(?:\([0-9]{1,5}\)|[0-9]{2})", smiles[i:])
                if not token:
                    return "環編號尚未完成；% 後需要兩位數字。"
                raw_key = token.group()
                key = str(int(raw_key.strip("%()")))
                rings[key] = rings.get(key, 0) + 1
                i += len(raw_key) - 1
        i += 1
    if bracket:
        return "原子尚未完成，請補上 ]。"
    if branches:
        return "支鏈尚未完成，請加入原子後用 ) 回到主鏈。"
    if "()" in smiles:
        return "支鏈內需要至少一個原子。"
    if smiles[-1] in "-=#:/\\.":
        return "這條鍵還沒有接上原子，請繼續選擇元素。"
    open_rings = [key for key, count in rings.items() if count % 2]
    if open_rings:
        return "環標記 " + "、".join(open_rings) + " 尚未配對，請在另一個原子使用相同編號。"
    return None


def _inspect(payload):
    """Low-cost, side-effect-free input feedback; never embed or optimize 3D."""
    empty = {"valid": False, "svg": None, "formula": None, "atomCount": 0,
             "bondCount": 0, "canonicalSmiles": None, "warnings": []}
    raw = payload.get("smiles", "")
    if not isinstance(raw, str):
        return {**empty, "message": "請輸入文字形式的 SMILES。"}
    smiles = raw.strip()
    hint = _input_hint(smiles)
    if hint:
        return {**empty, "message": hint}
    with rdBase.BlockLogs():
        molecule = Chem.MolFromSmiles(smiles, sanitize=False)
        if molecule is None:
            return {**empty, "message": "目前還不能辨識，請檢查元素符號、括號或鍵的位置。"}
        try:
            _sanitize(molecule)
        except Chem.AtomValenceException as exc:
            match = re.search(r"atom #\s*(\d+)\s+(\w+)", str(exc))
            label = f"第 {int(match[1])+1} 個 {match[2]} 原子" if match else "原子"
            return {**empty, "message": label + "的鍵太多；請減少鍵級，或確認形式電荷。"}
        except (Chem.KekulizeException, Chem.AtomKekulizeException):
            return {**empty, "message": "芳香環尚不完整，請確認環閉合與小寫元素符號。"}
        except Exception:
            return {**empty, "message": "原子價態或鍵的連接不成立，請調整目前的結構。"}
        # Share all existing element, size, radical and connected-component
        # limits with generation. Parameter presence is cheap to check and does
        # not imply successful 3D embedding or experimentally accurate geometry.
        try:
            checked = _read({"smiles": smiles})
            if not (_is_co2(checked) or _is_ozone(checked) or _teaching_spec(checked) or _reference_spec(checked) or _is_isolated_ion(checked)) and not (AllChem.MMFFHasAllMoleculeParams(checked) or AllChem.UFFHasAllMoleculeParams(checked)):
                return {**empty, "message": "這個結構缺少本機力場參數，暫時不能建立三維模型。"}
        except ChemistryError as exc:
            return {**empty, "message": str(exc)}
        # A lone heavy-atom label such as NH4+ hides every bond. Expand the
        # hydrogens in this depiction only; original atoms keep their indices,
        # added H atoms have no input-token number, and the input stays intact.
        compact_notes = molecule.GetNumHeavyAtoms() == 1 or molecule.GetNumAtoms() == 1
        display = (Chem.AddHs(molecule) if molecule.GetNumHeavyAtoms() == 1
                   else Chem.Mol(molecule))
        for atom in display.GetAtoms():
            if atom.GetIdx() < molecule.GetNumAtoms() and not compact_notes:
                atom.SetProp("atomNote", str(atom.GetIdx()+1))
        rdDepictor.Compute2DCoords(display)
        drawer = rdMolDraw2D.MolDraw2DSVG(520, 300)
        options = drawer.drawOptions()
        options.fixedFontSize = 20
        options.annotationFontScale = .8
        options.bondLineWidth = 2
        options.padding = .12
        options.addStereoAnnotation = True
        options.explicitMethyl = True
        # The legacy R/S ranks are only approximate (notably for ring ligands
        # and pseudoasymmetric centers). Use the same true CIP labels as 3D.
        _assign_true_atom_cip(display)
        rdMolDraw2D.PrepareAndDrawMolecule(drawer, display)
        drawer.FinishDrawing()
        svg = drawer.GetDrawingText()
        svg = svg[svg.index("<svg"):]
        if compact_notes:
            # RDKit can place notes far from a lone atom or small hydride.
            # Keep input indices beside their atoms, in the largest bond-free
            # angular gap. Added H atoms never acquire an input-token index.
            notes = []
            for atom in molecule.GetAtoms():
                index = atom.GetIdx()
                point = drawer.GetDrawCoords(index)
                angles = sorted(math.atan2(drawer.GetDrawCoords(n.GetIdx()).y-point.y,
                                          drawer.GetDrawCoords(n.GetIdx()).x-point.x)
                                for n in display.GetAtomWithIdx(index).GetNeighbors())
                angle = math.pi / 2
                if angles:
                    ends = angles[1:] + [angles[0] + 2*math.pi]
                    start, end = max(zip(angles, ends), key=lambda pair: pair[1]-pair[0])
                    angle = (start+end)/2
                x, y = point.x + 32*math.cos(angle), point.y + 32*math.sin(angle)
                notes.append(f'<text class="note atom-{index}" data-input-atom="{index}" '
                             f'x="{x:.2f}" y="{y+4:.2f}" text-anchor="middle" '
                             'font-family="sans-serif" font-size="12" fill="#627867">'
                             f'{index+1}</text>')
            svg = svg.replace("</svg>", "".join(notes) + "</svg>")
        special = _teaching_spec(checked) or _reference_spec(checked)
        notes = ["此為二維連接圖；三維幾何需生成後確認。"]
        if checked.HasProp("_IgnoredStereo"):
            notes.append(checked.GetProp("_IgnoredStereo"))
        if special and special["type"] == "idealized-vsepr":
            notes.append("三維模型使用理想 VSEPR 示意；角度與鍵長不是實驗值，亦不提供力場能量。")
        if special and special.get("unpaired"):
            notes.append("此物種為開殼層；Lewis 連接圖不完整表示其未成對電子或分子軌域。")
        return {"valid": True, "svg": svg,
                "formula": rdMolDescriptors.CalcMolFormula(molecule),
                **_formula_metadata(molecule), "charge": Chem.GetFormalCharge(molecule),
                "atomCount": checked.GetNumAtoms(), "bondCount": checked.GetNumBonds(),
                "atomCountIncludesHydrogen": True, "heavyAtomCount": checked.GetNumHeavyAtoms(),
                "inputAtomCount": molecule.GetNumAtoms(),
                "canonicalSmiles": Chem.MolToSmiles(molecule, isomericSmiles=True),
                "message": "連接結構有效",
                "warnings": notes}


def _reject_high_domain_centers(mol):
    """Availability of force-field parameters does not establish correct geometry.

    RDKit 2025.09.6 tests give a tetrahedral SF4 with MMFF and a severely
    distorted PF5 with UFF. Exclude >4-domain centers until validated electronic
    structure treatment is available. Tetrahedral oxyanions remain in scope.
    This also runs before sanitization so e.g. ClF3 gets an intelligible error.
    """
    if _teaching_spec(mol):
        return
    for atom in mol.GetAtoms():
        if atom.GetSymbol() not in {"Si", "P", "S", "Cl", "Br", "I", "Xe"} or atom.GetIsAromatic() or atom.GetDegree() == 0:
            continue
        hydrogens = atom.GetNumExplicitHs()
        remainder = VALENCE_ELECTRONS[atom.GetSymbol()] - atom.GetFormalCharge() - hydrogens - sum(b.GetBondTypeAsDouble() for b in atom.GetBonds())
        domains = atom.GetDegree() + hydrogens + max(0, remainder / 2)
        if domains > 4.01:
            raise ChemistryError(f"原子 {atom.GetIdx()+1}（{atom.GetSymbol()}）需要超過四個電子域的幾何描述；此結構不在已支援的 VSEPR 教學模板內。可使用 PF₅、PCl₅、SF₄、SF₆、ClF₃、BrF₃、XeF₂ 或 XeF₄ 範例；其他結構仍需經驗證的模型。")


def _is_co2(mol):
    return (mol.GetNumAtoms() == 3 and sorted(a.GetSymbol() for a in mol.GetAtoms()) == ["C", "O", "O"]
            and all(a.GetFormalCharge() == 0 for a in mol.GetAtoms())
            and mol.GetNumBonds() == 2 and all(b.GetBondTypeAsDouble() == 2 for b in mol.GetBonds()))


def _is_ozone(mol):
    if mol.GetNumAtoms() != 3 or mol.GetNumBonds() != 2 or any(a.GetSymbol() != "O" for a in mol.GetAtoms()):
        return False
    center = next((a for a in mol.GetAtoms() if a.GetDegree() == 2), None)
    return (center is not None and center.GetFormalCharge() == 1
            and sorted(a.GetFormalCharge() for a in center.GetNeighbors()) == [-1, 0]
            and sorted(b.GetBondTypeAsDouble() for b in mol.GetBonds()) == [1, 2])


def _ozone_model(mol, preserve=False):
    """Ozone's two equivalent bonds use an explicit gas-phase reference.

    A single charged Lewis contributor is retained for editing and exports;
    it must not force two physically different equilibrium O–O lengths.
    """
    center = next(a.GetIdx() for a in mol.GetAtoms() if a.GetDegree() == 2)
    ends = [a.GetIdx() for a in mol.GetAtomWithIdx(center).GetNeighbors()]
    if not preserve:
        bisector, tangent = np.array([0., 1., 0.]), np.array([1., 0., 0.])
        if mol.GetNumConformers():
            old = np.array(mol.GetConformer().GetPositions())
            u, v = [_unit(old[i] - old[center]) for i in ends]
            bisector = _unit(u + v, _perp(u))
            tangent = _unit(u - v, _perp(bisector))
        half_angle = math.radians(OZONE_BOND_ANGLE / 2)
        mol.RemoveAllConformers()
        conf = Chem.Conformer(3)
        conf.Set3D(True)
        conf.SetAtomPosition(center, Point3D(0., 0., 0.))
        for i, sign in zip(ends, [1, -1]):
            p = OZONE_BOND_LENGTH * (math.cos(half_angle) * bisector + sign * math.sin(half_angle) * tangent)
            conf.SetAtomPosition(i, Point3D(*map(float, p)))
        mol.AddConformer(conf, assignId=True)
    note = "O₃ 的單／雙鍵是 Lewis 共振式的計數；實際平衡結構的兩條 O–O 鍵等價。此處不提供通用力場能量。"
    if preserve:
        method = "保留輸入座標 · O₃（不評估力場能量）"
        note += "目前保留匯入幾何；按最佳化可套用 NIST 氣相參考幾何。"
    else:
        method = "NIST 參考幾何 · O₃"
        note += "目前採用 NIST CCCBDB 氣相實驗參考：O–O 1.278 Å、O–O–O 116.8°；非本機最佳化結果。"
    if any(a.GetIsotope() for a in mol.GetAtoms()):
        note += "同位素標記已保留；參考座標未加入同位素造成的振動平均差異。"
    result = _serialize(mol, [{"confId": mol.GetConformer().GetId(), "energy": None, "converged": not preserve}], method, [note, "參考資料：" + OZONE_REFERENCE_URL])
    result["geometrySource"] = {"type": "imported" if preserve else "experimental-reference", "referenceUrl": OZONE_REFERENCE_URL,
                                "referenceBondLength": OZONE_BOND_LENGTH, "referenceBondAngle": OZONE_BOND_ANGLE, "energyAvailable": False}
    return result


def _co2_model(mol, preserve=False):
    """Use a documented experimental reference, not defective generic CO2 typing."""
    center = next(a.GetIdx() for a in mol.GetAtoms() if a.GetSymbol() == "C")
    oxygen = [a.GetIdx() for a in mol.GetAtoms() if a.GetSymbol() == "O"]
    if not preserve:
        axis = np.array([1., 0., 0.])
        if mol.GetNumConformers():
            old = np.array(mol.GetConformer().GetPositions())
            axis = _unit(old[oxygen[0]] - old[oxygen[1]])
        mol.RemoveAllConformers()
        conf = Chem.Conformer(3)
        conf.Set3D(True)
        conf.SetAtomPosition(center, Point3D(0., 0., 0.))
        conf.SetAtomPosition(oxygen[0], Point3D(*map(float, axis * CO2_BOND_LENGTH)))
        conf.SetAtomPosition(oxygen[1], Point3D(*map(float, -axis * CO2_BOND_LENGTH)))
        mol.AddConformer(conf, assignId=True)
    note = "CO₂ 的通用 MMFF／UFF 鍵長在本版本驗證中不適用；不提供該力場能量。"
    if preserve:
        method = "保留輸入座標 · CO₂（不評估力場能量）"
        note += "目前保留匯入座標；按最佳化可套用 NIST 氣相參考幾何。"
    else:
        method = "NIST 參考幾何 · CO₂"
        note += "目前採用 NIST CCCBDB 氣相實驗參考：C–O 1.1621 Å、O–C–O 180°；非本機最佳化結果。"
    if any(a.GetIsotope() for a in mol.GetAtoms()):
        note += "同位素標記已保留；本參考座標未加入同位素造成的振動平均差異。"
    result = _serialize(mol, [{"confId": mol.GetConformer().GetId(), "energy": None, "converged": not preserve}], method, [note, "參考資料：" + CO2_REFERENCE_URL])
    result["geometrySource"] = {"type": "imported" if preserve else "experimental-reference", "referenceUrl": CO2_REFERENCE_URL,
                                 "referenceBondLength": CO2_BOND_LENGTH, "energyAvailable": False}
    return result


def _unit(v, fallback=None):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    if n < 1e-9:
        return np.asarray(fallback if fallback is not None else [1., 0., 0.])
    return v / n


def _perp(v):
    v = _unit(v)
    axis = np.eye(3)[int(np.argmin(np.abs(v)))]
    return _unit(np.cross(v, axis))


def _graph_atom_integer(value, lower, upper, message):
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ChemistryError(message) from exc
    if (isinstance(value, bool) or isinstance(value, float) and value != number
            or not lower <= number <= upper):
        raise ChemistryError(message)
    return number


def _validate_smiles_atom_numbers(smiles):
    # Validate before the SMILES reader stores isotope, H count and charge
    # in narrow integer fields. The optional molecule name is not chemistry.
    for token in re.findall(r"\[([^\]]*)\]", smiles.split(maxsplit=1)[0]):
        isotope = re.match(r"(\d+)(?=[A-Za-z*])", token)
        if isotope and int(isotope[1]) > 65535:
            raise ChemistryError("同位素質量數無效，請確認同位素標記。")
        hydrogens = re.search(r"H(\d+)", token)
        if hydrogens and int(hydrogens[1]) > 200:
            raise ChemistryError("氫原子數超出此模型的 200 個總原子上限。")
        charge = re.search(r"[+-](\d+)", token)
        if charge and int(charge[1]) > 3:
            raise ChemistryError("形式電荷必須介於 −3 與 +3。")


def _read_graph(graph):
    atoms, bonds = graph.get("atoms", []), graph.get("bonds", [])
    if not atoms or len(atoms) > 200:
        raise ChemistryError("請建立至少一個原子；上限為 80 個重原子、200 個總原子。")
    rw = Chem.RWMol()
    mapping = {}
    for i, data in enumerate(atoms):
        element = str(data.get("element", "C"))
        if element not in SUPPORTED:
            raise ChemistryError(f"目前未支援 {element} 的可靠幾何模型；請使用支援的主族元素。")
        old_id = data.get("id", i)
        if old_id in mapping:
            raise ChemistryError("原子識別碼重複。")
        atom = Chem.Atom(element)
        charge = _graph_atom_integer(data.get("charge", 0), -3, 3, "形式電荷必須介於 −3 與 +3。")
        atom.SetFormalCharge(charge)
        isotope = _graph_atom_integer(data.get("isotope", 0), 0, 65535, "同位素質量數無效，請確認同位素標記。")
        atom.SetIsotope(isotope)
        atom.SetIsAromatic(bool(data.get("aromatic", False)))
        hydrogens = _graph_atom_integer(data.get("explicitHs", 0), 0, 200, "氫原子數無效或超出上限。")
        atom.SetNumExplicitHs(hydrogens)
        atom.SetNoImplicit(bool(data.get("noImplicit", False)))
        tag = int(data.get("chiralTag", 0))
        if tag not in {int(Chem.ChiralType.CHI_UNSPECIFIED), int(Chem.ChiralType.CHI_TETRAHEDRAL_CW),
                       int(Chem.ChiralType.CHI_TETRAHEDRAL_CCW)}:
            raise ChemistryError("此版本僅支援四面體原子立體化學；無法可靠保留其他原子立體標記。")
        atom.SetChiralTag(Chem.ChiralType.values[tag])
        mapping[old_id] = rw.AddAtom(atom)
    seen = set()
    for data in bonds:
        if int(data.get("stereo", 0)) in {int(Chem.BondStereo.STEREOATROPCW), int(Chem.BondStereo.STEREOATROPCCW)}:
            raise ChemistryError("此工作室尚不能保留聯芳基等鍵的軸立體標記，請使用支援軸立體化學的編輯器。")
        try:
            a, b = mapping[data["a"]], mapping[data["b"]]
            order = float(data.get("order", 1))
        except (KeyError, ValueError, TypeError) as exc:
            raise ChemistryError("鍵的端點或鍵級無效。") from exc
        if a == b or tuple(sorted([a, b])) in seen or order not in BOND_TYPES:
            raise ChemistryError("不可自我連接、重複建鍵或使用不支援的鍵級。")
        seen.add(tuple(sorted([a, b])))
        rw.AddBond(a, b, BOND_TYPES[order])
        bond = rw.GetBondBetweenAtoms(a, b)
        if order == 1.5:
            bond.SetIsAromatic(True)
            rw.GetAtomWithIdx(a).SetIsAromatic(True)
            rw.GetAtomWithIdx(b).SetIsAromatic(True)
        direction = int(data.get("bondDir", 0))
        if direction in Chem.BondDir.values:
            bond.SetBondDir(Chem.BondDir.values[direction])
    mol = rw.GetMol()
    _reject_high_domain_centers(mol)
    _sanitize(mol)
    for data in bonds:
        stereo_atoms = data.get("stereoAtoms", [])
        stereo = int(data.get("stereo", 0))
        if len(stereo_atoms) == 2 and all(a in mapping for a in stereo_atoms):
            bond = mol.GetBondBetweenAtoms(mapping[data["a"]], mapping[data["b"]])
            bond.SetStereoAtoms(mapping[stereo_atoms[0]], mapping[stereo_atoms[1]])
            if stereo in Chem.BondStereo.values:
                bond.SetStereo(Chem.BondStereo.values[stereo])
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    return mol


def _read(payload):
    requested_atoms, directed_bonds = [], []
    with rdBase.BlockLogs():
        try:
            if payload.get("graph") is not None:
                mol = _read_graph(payload["graph"])
            elif payload.get("molblock"):
                mol = Chem.MolFromMolBlock(str(payload["molblock"]), removeHs=False, sanitize=False)
            else:
                smiles = str(payload.get("smiles", "")).strip()
                if not smiles or len(smiles) > 4000:
                    raise ChemistryError("請輸入有效的 SMILES，或先建立分子連接圖。")
                _validate_smiles_atom_numbers(smiles)
                mol = Chem.MolFromSmiles(smiles, sanitize=False)
                if mol is not None:
                    requested_atoms = [a.GetIdx() for a in mol.GetAtoms() if a.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED]
                    directed_bonds = [b.GetIdx() for b in mol.GetBonds()
                                      if b.GetBondDir() in {Chem.BondDir.ENDDOWNRIGHT, Chem.BondDir.ENDUPRIGHT}]
            if mol is None:
                raise ChemistryError("無法解析結構：請檢查 SMILES、價數、環閉合與立體化學標記。")
            _reject_high_domain_centers(mol)
            _sanitize(mol)
        except ChemistryError:
            raise
        except Exception as exc:
            raise ChemistryError("化學結構無效：請檢查原子價數、形式電荷、鍵級與芳香環連接。") from exc
    if len(Chem.GetMolFrags(mol)) != 1:
        raise ChemistryError("目前一次計算一個相連分子；離子對或多片段的相對位置不能由此模型可靠決定。")
    if mol.GetNumHeavyAtoms() > 80:
        raise ChemistryError("此版本上限為 80 個重原子，請縮小結構。")
    for atom in mol.GetAtoms():
        if atom.GetSymbol() not in SUPPORTED:
            raise ChemistryError(f"尚未支援 {atom.GetSymbol()} 的可靠幾何模型；此版本不推測金屬配位形狀。")
        if atom.GetSymbol() in {"Na", "K", "Mg", "Ca", "Al"} and not _is_isolated_ion(mol):
            raise ChemistryError("此金屬僅支援常見單原子離子；鹽類晶格、金屬鍵及配位結構不能當作孤立共價分子推算。")
        if atom.GetSymbol() in {"Be", "Xe"} and not _teaching_spec(mol):
            raise ChemistryError("Be／Xe 目前僅支援 BeCl₂、XeF₂、XeF₄ 的理想 VSEPR 教學幾何。")
        if atom.GetIsotope() and Chem.GetPeriodicTable().GetMassForIsotope(atom.GetAtomicNum(), atom.GetIsotope()) <= 0:
            raise ChemistryError(f"原子 {atom.GetIdx()+1} 的同位素質量數沒有可用資料；請確認同位素標記。")
        if atom.GetChiralTag() not in {Chem.ChiralType.CHI_UNSPECIFIED, Chem.ChiralType.CHI_TETRAHEDRAL_CW, Chem.ChiralType.CHI_TETRAHEDRAL_CCW}:
            # RDKit marks coordinate-inferred tags separately from file tags.
            # A template project keeps its requested scope in stereoGraph.
            spec = _teaching_spec(mol)
            if (payload.get("molblock") and spec and atom.GetIdx() == spec["center"]
                    and atom.HasProp("_NonExplicit3DChirality")
                    and (payload.get("stereoGraph") is not None
                         or len({(n.GetSymbol(), n.GetIsotope()) for n in atom.GetNeighbors()}) == 1)):
                atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
                atom.ClearProp("_chiralPermutation")
                continue
            raise ChemistryError("此版本僅支援四面體原子立體化學；無法可靠保留其他原子立體標記。")
    if any(b.GetStereo() in {Chem.BondStereo.STEREOATROPCW, Chem.BondStereo.STEREOATROPCCW} for b in mol.GetBonds()):
        raise ChemistryError("此工作室尚不能保留聯芳基等鍵的軸立體標記，請使用支援軸立體化學的編輯器。")
    if any(b.GetBondType() not in BOND_TYPES.values() for b in mol.GetBonds()):
        raise ChemistryError("此版本僅支援單鍵、雙鍵、三鍵與芳香鍵；配位鍵或未指定鍵級尚未有可靠的幾何及電子計數模型。")
    if any(group.GetGroupType() != Chem.StereoGroupType.STEREO_ABSOLUTE for group in mol.GetStereoGroups()):
        raise ChemistryError("此檔案含相對或混合立體化學（AND／OR 群組）；單一構型工作室無法完整表示，請先明確指定要檢視的異構物。")
    mol = Chem.AddHs(mol, addCoords=bool(mol.GetNumConformers()))
    if mol.GetNumAtoms() == 1 and Chem.GetFormalCharge(mol) and not _is_isolated_ion(mol):
        raise ChemistryError("此單原子離子的電荷或電子組態不在可表示的 Lewis 教學模型內。")
    radical_count = sum(a.GetNumRadicalElectrons() for a in mol.GetAtoms())
    if radical_count:
        reference = _reference_spec(mol)
        if not reference or reference.get("name") not in {"NO", "NO₂"} or radical_count != 1:
            raise ChemistryError("目前自由基幾何僅支援 NO 與 NO₂ 的參考結構；請核對未成對電子、氫數與形式電荷。")
    # O=O is a common valid connectivity notation, but its Lewis graph alone
    # gives zero radicals. The ground state of neutral dioxygen is triplet.
    # Check after adding H so that peroxide (OO) is not mistaken for O2.
    if mol.GetNumAtoms() == 2 and all(a.GetAtomicNum() == 8 for a in mol.GetAtoms()) and Chem.GetFormalCharge(mol) == 0 and not _reference_spec(mol):
        raise ChemistryError("中性 O₂ 的基態為三重態，具有兩個未成對電子；目前的閉殼層模型無法呈現此電子組態。")
    _reject_high_domain_centers(mol)
    if mol.GetNumAtoms() > 200:
        raise ChemistryError("補氫後超過 200 個原子，請縮小結構。")
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    ignored_atoms = [str(i + 1) for i in requested_atoms if mol.GetAtomWithIdx(i).GetChiralTag() == Chem.ChiralType.CHI_UNSPECIFIED]
    # RDKit can retain a slash on an isolated single bond even when it
    # contributes no configuration to the sanitized molecule (e.g. C/C).
    directional_centers = {index for bond in mol.GetBonds()
                           if bond.GetBondType() == Chem.BondType.DOUBLE
                           and bond.GetStereo() not in {Chem.BondStereo.STEREONONE, Chem.BondStereo.STEREOANY}
                           for index in (bond.GetBeginAtomIdx(), bond.GetEndAtomIdx())}
    ignored_directions = []
    for i in directed_bonds:
        bond = mol.GetBondWithIdx(i)
        if bond.GetBondDir() == Chem.BondDir.NONE or not directional_centers.intersection(
                (bond.GetBeginAtomIdx(), bond.GetEndAtomIdx())):
            ignored_directions.append(str(i + 1))
    notices = []
    if ignored_atoms:
        notices.append("原子 " + "、".join(ignored_atoms) + " 的手性標記已忽略，未形成可指定的立體中心。")
    if ignored_directions:
        notices.append("鍵 " + "、".join(ignored_directions) + " 的斜線標記已忽略，未形成可區分且完整指定的 E/Z 構型。")
    if notices:
        mol.SetProp("_IgnoredStereo", " ".join(notices))
    if payload.get("molblock") and payload.get("stereoGraph") is not None:
        _restore_stereo_scope(mol, payload["stereoGraph"])
    elif payload.get("molblock") and Chem.FindPotentialStereo(mol):
        mol.SetBoolProp("_StereoFromImport", True)
    if payload.get("molblock"):
        mol.SetBoolProp("_InputCoordinateFrame", True)
    return mol


def _field(mol, conf_id=-1):
    with rdBase.BlockLogs():
        if AllChem.MMFFHasAllMoleculeParams(mol):
            props = AllChem.MMFFGetMoleculeProperties(mol, mmffVariant="MMFF94s")
            return AllChem.MMFFGetMoleculeForceField(mol, props, confId=conf_id), "MMFF94s"
        if AllChem.UFFHasAllMoleculeParams(mol):
            return AllChem.UFFGetMoleculeForceField(mol, confId=conf_id), "UFF"
    raise ChemistryError("此結構缺少完整 MMFF94s／UFF 參數，無法產生可信的最佳化幾何。")


def _amide_bond(mol, bond):
    for c, n in [(bond.GetBeginAtom(), bond.GetEndAtom()), (bond.GetEndAtom(), bond.GetBeginAtom())]:
        if c.GetSymbol() == "C" and n.GetSymbol() == "N":
            if any(b.GetBondTypeAsDouble() == 2 and b.GetOtherAtom(c).GetSymbol() in {"O", "S"} for b in c.GetBonds()):
                return True
    return False


def _rotation_info(mol, bond):
    if bond.GetIsAromatic():
        return False, "芳香鍵具有離域 π 鍵性，不可作自由單鍵扭轉。"
    if bond.GetBondTypeAsDouble() >= 2:
        return False, "多重鍵含 π 鍵；禁止繞此鍵自由旋轉以保留 π 重疊與立體構型。"
    if bond.IsInRing():
        return False, "環內鍵不能獨立旋轉；請重新取樣整個環構象。"
    if _amide_bond(mol, bond):
        return False, "醯胺／硫醯胺 C–N 具部分雙鍵性，已鎖定平面共振結構。"
    if bond.GetBeginAtom().GetAtomicNum() == 1 or bond.GetEndAtom().GetAtomicNum() == 1:
        return False, "末端氫鍵沒有可操作的內部扭轉自由度。"
    if bond.GetBeginAtom().GetDegree() < 2 or bond.GetEndAtom().GetDegree() < 2:
        return False, "末端原子沒有可操作的內部扭轉自由度。"
    # A chain of degree-two sp atoms remains on the axis until a branch is
    # encountered. Follow the entire chain (2-butyne has methyl H on both
    # sides), independent of tiny numerical deviations from linearity.
    for endpoint, other in [(bond.GetBeginAtom(), bond.GetEndAtom()), (bond.GetEndAtom(), bond.GetBeginAtom())]:
        atom, previous = endpoint, other.GetIdx()
        while atom.GetDegree() == 2 and atom.GetHybridization() == Chem.HybridizationType.SP:
            neighbor = next(n for n in atom.GetNeighbors() if n.GetIdx() != previous)
            previous, atom = atom.GetIdx(), neighbor
        if atom.GetDegree() == 1:
            return False, "此鍵的一側只有共線的原子，沒有可改變的內部扭轉角。"
    if bond.GetIsConjugated():
        return True, "共軛單鍵可扭轉，但具共軛能障；旋轉後能量會重新計算，不等於自由旋轉。"
    return True, "σ 單鍵可調整扭轉角；空間排斥與扭轉勢壘仍影響能量。"


def _true_cip(mol):
    """Read true CIP descriptors without modifying the engine's stereo tags.

    RDKit's legacy _CIPRank is not a full implementation of the sequence rules.
    A temporary copy also prevents stale descriptors surviving an isomer edit.
    """
    probe = Chem.Mol(mol)
    for item in list(probe.GetAtoms()) + list(probe.GetBonds()):
        if item.HasProp("_CIPCode"):
            item.ClearProp("_CIPCode")
    rdCIPLabeler.AssignCIPLabels(probe, maxRecursiveIterations=200000)
    return ({a.GetIdx(): a.GetProp("_CIPCode") for a in probe.GetAtoms() if a.HasProp("_CIPCode")},
            {b.GetIdx(): b.GetProp("_CIPCode") for b in probe.GetBonds() if b.HasProp("_CIPCode")})


def _assign_true_atom_cip(mol):
    """Replace approximate/stale atomic labels without changing stereo tags."""
    labels = _true_cip(mol)[0]
    for atom in mol.GetAtoms():
        if atom.HasProp("_CIPCode"):
            atom.ClearProp("_CIPCode")
        if atom.GetIdx() in labels:
            atom.SetProp("_CIPCode", labels[atom.GetIdx()])
    return labels


def _double_bond_control(mol, bond, potential, descriptors):
    current = descriptors.get(bond.GetIdx(), "unspecified")
    if current not in {"E", "Z"}:
        current = "unspecified"
    control = {"editable": False, "reason": "", "current": current,
               "cisTrans": False, "referenceAtoms": None}
    if bond.IsInRing():
        control["reason"] = "環內雙鍵受整個環的幾何與張力限制；此版不提供環內 E/Z 切換。"
        return control
    endpoints = [bond.GetBeginAtom(), bond.GetEndAtom()]
    if any(any(b.GetIdx() != bond.GetIdx() and b.GetBondTypeAsDouble() >= 2 for b in a.GetBonds()) for a in endpoints):
        control["reason"] = "累積雙鍵不能以單一雙鍵的 E/Z 按鈕描述其立體化學。"
        return control
    if bond.GetIdx() not in potential:
        control["reason"] = "此雙鍵沒有可區分的 E/Z 構型；雙鍵兩端都必須具有可區分的取代基。"
        return control
    neighbors = [[n for n in a.GetNeighbors() if n.GetIdx() != endpoints[1-i].GetIdx()] for i, a in enumerate(endpoints)]
    if any(not side for side in neighbors):
        control["reason"] = "此雙鍵缺少可用的立體參照取代基。"
        return control
    # Confirm that true CIP can classify a trial arrangement. Merely being
    # reported as a potential center is insufficient for e.g. cumulenes.
    trial = Chem.Mol(mol)
    candidate = trial.GetBondWithIdx(bond.GetIdx())
    refs = [next((n.GetIdx() for n in side if n.GetAtomicNum() != 1), side[0].GetIdx()) for side in neighbors]
    candidate.SetStereoAtoms(*refs)
    candidate.SetStereo(Chem.BondStereo.STEREOCIS)
    try:
        candidate.ClearProp("_CIPCode")
        candidate.ClearProp("_CIPNeighborOrder")
        rdCIPLabeler.AssignCIPLabels(trial, bondsToLabel=[bond.GetIdx()], atomsToLabel=[], maxRecursiveIterations=200000)
        trial_label = candidate.GetProp("_CIPCode") if candidate.HasProp("_CIPCode") else None
    except Exception:
        trial_label = None
    if trial_label not in {"E", "Z"}:
        control["reason"] = "此結構的 CIP 優先序無法在本版可靠判定，故不提供 E/Z 編輯。"
        return control
    control["editable"] = True
    control["cisTrans"] = all(a.GetAtomicNum() == 6 and len(side) == 2
                              and sum(n.GetAtomicNum() == 1 for n in side) == 1
                              for a, side in zip(endpoints, neighbors))
    control["reason"] = ("兩端各有一個氫：Z 對應順式，E 對應反式。設定後重新生成幾何，並保留 π 鍵旋轉鎖定。"
                         if control["cisTrans"] else
                         "依 CIP 優先序指定：Z 為高優先序取代基同側，E 為異側；不直接等同所有結構的順／反命名。")
    # The CIP labeler also records the actual high-priority ligand on each end.
    reference = list(candidate.GetPropsAsDict(includePrivate=True).get("_CIPNeighborOrder", []))
    if len(reference) == 2 and all(any(n.GetIdx() == i for n in side) for i, side in zip(reference, neighbors)):
        control["referenceAtoms"] = reference
    return control


def _stereo_controls(mol):
    potential = {x.centeredOn for x in Chem.FindPotentialStereo(Chem.Mol(mol)) if str(x.type) == "Bond_Double"}
    try:
        descriptors = _true_cip(mol)[1]
    except Exception:
        descriptors = {}
    return {b.GetIdx(): _double_bond_control(mol, b, potential, descriptors)
            for b in mol.GetBonds() if b.GetBondType() == Chem.BondType.DOUBLE}


def _verify_stereo_geometry(mol, conf_id, expected):
    """Re-infer stereochemistry solely from coordinates, never stored tags."""
    if not any(expected):
        return
    probe = Chem.Mol(mol)
    atom_scope = {a.GetIdx() for a in mol.GetAtoms() if a.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED}
    bond_scope = {b.GetIdx() for b in mol.GetBonds() if b.GetStereo() not in {Chem.BondStereo.STEREONONE, Chem.BondStereo.STEREOANY}}
    for atom in probe.GetAtoms():
        atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
    for bond in probe.GetBonds():
        bond.SetStereo(Chem.BondStereo.STEREONONE)
        bond.SetBondDir(Chem.BondDir.NONE)
    Chem.AssignStereochemistryFrom3D(probe, confId=conf_id, replaceExistingTags=True)
    # Coordinates also assign previously unspecified centers. They must not
    # change the sequence rules used to verify a defined pseudoasymmetric one.
    for atom in probe.GetAtoms():
        if atom.GetIdx() not in atom_scope:
            atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
    for bond in probe.GetBonds():
        if bond.GetIdx() not in bond_scope:
            bond.SetStereo(Chem.BondStereo.STEREONONE)
            bond.SetBondDir(Chem.BondDir.NONE)
    actual = _true_cip(probe)
    for requested, observed in zip(expected, actual):
        if any(observed.get(index) != label for index, label in requested.items()):
            raise ChemistryError("最佳化座標未能保留指定的立體構型；本次編輯已取消，請檢查結構或使用較簡單的取代基。")


def _set_stereo(payload):
    graph = payload.get("graph")
    if not isinstance(graph, dict) or not isinstance(graph.get("atoms"), list):
        raise ChemistryError("設定 E/Z 需要目前分子的完整連接表。")
    requested = payload.get("stereo")
    if requested not in {"E", "Z", "unspecified"}:
        raise ChemistryError("雙鍵構型必須為 E、Z 或 unspecified。")
    mol = _read({"graph": graph})
    try:
        endpoints = payload["bond"]
        if not isinstance(endpoints, list) or len(endpoints) != 2 or endpoints[0] == endpoints[1]:
            raise ValueError()
        mapping = {a.get("id", i): i for i, a in enumerate(graph["atoms"])}
        bond = mol.GetBondBetweenAtoms(mapping[endpoints[0]], mapping[endpoints[1]])
    except (KeyError, ValueError, TypeError, IndexError) as exc:
        raise ChemistryError("請選取目前連接表中的有效雙鍵端點。") from exc
    if bond is None or bond.GetBondType() != Chem.BondType.DOUBLE:
        raise ChemistryError("E/Z 編輯需要選取一條雙鍵。")
    control = _stereo_controls(mol)[bond.GetIdx()]
    if not control["editable"]:
        raise ChemistryError(control["reason"])
    original = _true_cip(mol)
    original_double_scope = {b.GetIdx() for b in mol.GetBonds()
                             if b.GetBondType() == Chem.BondType.DOUBLE
                             and b.GetStereo() not in {Chem.BondStereo.STEREONONE, Chem.BondStereo.STEREOANY}}
    # Rebuild all slash directions together; old directions can otherwise undo
    # a newly selected isomer or contradict a neighboring conjugated double bond.
    for item in mol.GetBonds():
        item.SetBondDir(Chem.BondDir.NONE)
    if requested == "unspecified":
        bond.SetStereo(Chem.BondStereo.STEREONONE)
    else:
        ends = [bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()]
        refs = [next((n.GetIdx() for n in mol.GetAtomWithIdx(a).GetNeighbors()
                      if n.GetIdx() != ends[1-i] and n.GetAtomicNum() != 1),
                     next(n.GetIdx() for n in mol.GetAtomWithIdx(a).GetNeighbors() if n.GetIdx() != ends[1-i]))
                for i, a in enumerate(ends)]
        bond.SetStereoAtoms(*refs)
        bond.SetStereo(Chem.BondStereo.STEREOCIS)
        if _true_cip(mol)[1].get(bond.GetIdx()) != requested:
            bond.SetStereo(Chem.BondStereo.STEREOTRANS)
    Chem.SetDoubleBondNeighborDirections(mol)
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    expected = _true_cip(mol)
    current = expected[1].get(bond.GetIdx(), "unspecified")
    resulting_scope = {b.GetIdx() for b in mol.GetBonds()
                       if b.GetBondType() == Chem.BondType.DOUBLE
                       and b.GetStereo() not in {Chem.BondStereo.STEREONONE, Chem.BondStereo.STEREOANY}}
    wanted_scope = original_double_scope - {bond.GetIdx()}
    if requested != "unspecified":
        wanted_scope.add(bond.GetIdx())
    if current != requested or resulting_scope != wanted_scope:
        raise ChemistryError("此相鄰共軛系統無法在保留其他雙鍵指定範圍下完成這次設定；本次編輯已取消。")
    if expected[0] != original[0] or any(expected[1].get(i) != code for i, code in original[1].items() if i != bond.GetIdx()):
        raise ChemistryError("這次設定會改變其他立體中心的指定資訊；本次編輯已取消。")
    result = _generate_molecule(mol, payload, verify_stereo=expected)
    result["warnings"].append("已重新生成指定構型；此操作是建立另一個異構物，不代表 π 鍵可自由旋轉或模擬實際異構化反應。"
                              if requested != "unspecified" else "已清除選定雙鍵的 E/Z 指定；目前座標僅代表其中一個可能構型。")
    return result


def _plane_normal(mol, atom, positions):
    i = atom.GetIdx()
    vectors = [_unit(positions[n.GetIdx()] - positions[i]) for n in atom.GetNeighbors()]
    if len(vectors) >= 2:
        for a, b in itertools.combinations(vectors, 2):
            cross = np.cross(a, b)
            if np.linalg.norm(cross) > .05:
                return _unit(cross)
    if vectors:
        neighbor = atom.GetNeighbors()[0]
        for nn in neighbor.GetNeighbors():
            if nn.GetIdx() != i:
                cross = np.cross(vectors[0], positions[nn.GetIdx()] - positions[neighbor.GetIdx()])
                if np.linalg.norm(cross) > .05:
                    return _unit(cross)
        return _perp(vectors[0])
    return np.array([0., 0., 1.])


def _lone_pairs(mol, atom, kekule, positions):
    i = atom.GetIdx()
    ka = kekule.GetAtomWithIdx(i)
    electron_remainder = VALENCE_ELECTRONS[atom.GetSymbol()] - atom.GetFormalCharge() - sum(b.GetBondTypeAsDouble() for b in ka.GetBonds()) - atom.GetNumRadicalElectrons()
    if electron_remainder < 0 or abs(electron_remainder % 2) > .01:
        return []
    count = int(round(electron_remainder / 2))
    if count == 0:
        return []
    count = min(count, 4)
    reference = _reference_spec(mol)
    if reference and reference["name"] == "N₂O":
        # One sigma lone pair at each terminus. The remaining Lewis lone pairs
        # belong to transverse p axes and must not be counted a second time.
        axis = _unit(positions[i] - positions[reference["center"]])
        first = _perp(axis)
        directions = [axis, first, np.cross(axis, first)]
        return [{"direction": direction.tolist(), "kind": "localized" if k == 0 else "delocalized",
                 "note": "N₂O 末端的 σ 孤電子對。" if k == 0 else "此 Lewis 電子對參與離域 π 系統。"}
                for k, direction in enumerate(directions[:count])]
    spec = _teaching_spec(mol)
    if spec and i == spec["center"] and spec["loneDirections"]:
        # Fit the ideal electron-domain frame to the current bond directions.
        # This supplies all three equatorial pairs of XeF2, and two of ClF3,
        # which cannot be recovered by the generic <=4-domain heuristics.
        original = np.array(spec["directions"])
        actual = np.array([_unit(positions[j]-positions[i]) for j in spec["ends"]])
        # The equivalent ligands in an external molfile may be numbered in
        # any order. In particular SF4 has both axial and equatorial sites.
        best_error, transform = float("inf"), np.eye(3)
        for permutation in itertools.permutations(range(len(actual))):
            ordered = actual[list(permutation)]
            u, _, vt = np.linalg.svd(original.T @ ordered)
            candidate = u @ vt
            error = np.linalg.norm(original @ candidate - ordered)
            if error < best_error:
                best_error, transform = error, candidate
            if error < 1e-7:
                break
        return [{"direction": [round(float(x), 6) for x in np.array(v) @ transform],
                 "kind": "localized", "note": "理想 VSEPR 電子域示意；非真實軌域或電子密度。"}
                for v in spec["loneDirections"]]
    neighbors = [_unit(positions[n.GetIdx()] - positions[i]) for n in atom.GetNeighbors()]
    normal = _plane_normal(mol, atom, positions)
    hyb = str(atom.GetHybridization())
    # An sp2 heteroatom with only single formal bonds donates one lone pair into p.
    donor = hyb == "SP2" and count > 0 and sum(b.GetBondTypeAsDouble() >= 2 for b in ka.GetBonds()) == 0 and any(b.GetIsConjugated() or b.GetIsAromatic() for b in atom.GetBonds())
    results = []
    if donor:
        results.append({"direction": normal.tolist(), "kind": "delocalized", "note": "參與共軛的 p 型孤電子對；兩葉瓣代表同一對電子。"})
        count -= 1
    if not count:
        return results
    dirs = []
    if hyb == "SP" and len(neighbors) == 1:
        dirs = [-neighbors[0]]
    elif hyb == "SP2":
        if len(neighbors) == 1:
            tangent = _unit(np.cross(normal, neighbors[0]))
            dirs = [_unit(-.5 * neighbors[0] + math.sqrt(3) / 2 * tangent), _unit(-.5 * neighbors[0] - math.sqrt(3) / 2 * tangent)]
        elif neighbors:
            dirs = [-_unit(np.sum(neighbors, axis=0))]
    elif len(neighbors) == 1:
        axis = neighbors[0]
        x, y = _perp(axis), _unit(np.cross(axis, _perp(axis)))
        dirs = [-axis / 3 + math.sqrt(8 / 9) * (math.cos(t) * x + math.sin(t) * y) for t in [0, 2 * math.pi / 3, 4 * math.pi / 3]]
    elif len(neighbors) == 2:
        bisector = -_unit(np.sum(neighbors, axis=0), _perp(neighbors[0]))
        dirs = [_unit(bisector / math.sqrt(3) + math.sqrt(2 / 3) * normal), _unit(bisector / math.sqrt(3) - math.sqrt(2 / 3) * normal)]
    elif len(neighbors) == 3:
        dirs = [-_unit(np.sum(neighbors, axis=0), normal)]
    elif not neighbors:
        dirs = [_unit(v) for v in [[1,1,1], [1,-1,-1], [-1,1,-1], [-1,-1,1]]]
    # Hypervalent lone-pair directions are shown only when a valid missing-domain
    # direction exists; avoid pretending d-hybridization determines electron density.
    if not dirs:
        candidates = []
        for k in range(256):
            z = 1 - 2 * (k + .5) / 256
            azimuth = k * math.pi * (3 - math.sqrt(5))
            candidates.append(np.array([math.sqrt(1-z*z)*math.cos(azimuth), math.sqrt(1-z*z)*math.sin(azimuth), z]))
        for _ in range(count):
            occupied = neighbors + dirs
            best = min(candidates, key=lambda v: sum(1 / max(.03, 1 - float(v @ other)) for other in occupied))
            dirs.append(best)
    for direction in dirs[:count]:
        results.append({"direction": [round(float(x), 6) for x in _unit(direction)], "kind": "localized", "note": "Lewis／VSEPR 局部方向示意，非計算軌域。"})
    return results


def _lewis_state(mol):
    """Integer electron bookkeeping for one contributor, never populations."""
    copy = Chem.Mol(mol)
    # ResonanceMolSupplier already assigns integer aromatic bond orders. A
    # second Kekulize would replace those assignments with the same arbitrary
    # Kekule form and silently discard the alternative contributors.
    if any(b.GetBondType() == Chem.BondType.AROMATIC for b in copy.GetBonds()):
        Chem.Kekulize(copy, clearAromaticFlags=False)
    orders = [float(b.GetBondTypeAsDouble()) for b in copy.GetBonds()]
    charges, pairs = [], []
    for atom in copy.GetAtoms():
        charge = atom.GetFormalCharge()
        remainder = (VALENCE_ELECTRONS[atom.GetSymbol()] - charge
                     - sum(orders[b.GetIdx()] for b in atom.GetBonds())
                     - atom.GetTotalNumHs(includeNeighbors=False)
                     - atom.GetNumRadicalElectrons())
        if remainder < 0 or abs(remainder / 2 - round(remainder / 2)) > 1e-6:
            raise ValueError("Nonintegral Lewis electron count")
        charges.append(charge)
        pairs.append(int(round(remainder / 2)))
    return {"atomCharges": charges, "bondOrders": orders, "lonePairCounts": pairs,
            "radicalCounts": [a.GetNumRadicalElectrons() for a in copy.GetAtoms()]}


def _resonance_metadata(mol, atoms):
    """Bounded Lewis contributors and conservative symmetry-aware drawing data.

    RDKit's default octet/charge restrictions are retained; KEKULE_ALL adds
    alternative aromatic assignments. The list is illustrative, not exhaustive
    and its members are not assigned physical probabilities. Equivalent bond
    orders are a drawing convention and never replace force-field topology.
    """
    source = _lewis_state(mol)
    states, seen = [source], {(tuple(source["atomCharges"]), tuple(source["bondOrders"]))}
    result = {"basis": "Lewis", "inputFormStateIndex": 0, "states": states,
              "groups": [], "equivalentBondGroups": [], "truncated": False,
              "note": "Lewis 共振貢獻式與 π 電子計數示意；不是實算電子密度或共振式權重。"}
    reference = _reference_spec(mol)
    template = _teaching_spec(mol)
    center_index = None
    if reference and reference["name"] in {"NO₂", "SO₂", "ClO₂⁻"}:
        center_index = reference["center"]
    elif template:
        center = mol.GetAtomWithIdx(template["center"])
        if center.GetSymbol() in {"S", "P", "Cl", "Br"} and all(a.GetSymbol() == "O" for a in center.GetNeighbors()):
            center_index = center.GetIdx()
    if center_index is not None:
        # RDKit need not treat P/S oxoanions as conjugated. Equivalent terminal
        # oxygens nevertheless admit permutations of the input Lewis assignment.
        # No orbital occupation or resonance weights are inferred from symmetry.
        center = mol.GetAtomWithIdx(center_index)
        edges = [(a.GetIdx(), mol.GetBondBetweenAtoms(center_index, a.GetIdx()).GetIdx())
                 for a in center.GetNeighbors()]
        assignments = [(source["bondOrders"][b], source["atomCharges"][a], source["lonePairCounts"][a], source["radicalCounts"][a])
                       for a, b in edges]
        # Keep the actual input form. Use the same named family to draw the
        # hybrid even when a user supplied an alternative octet convention.
        families = [assignments]
        if not (reference and reference.get("unpaired")):
            double_count = {("S", 2, 0): 1, ("S", 3, 0): 3, ("S", 3, -2): 1,
                            ("S", 4, -2): 2, ("P", 4, -3): 1, ("Cl", 2, -1): 1,
                            ("Cl", 3, -1): 2, ("Br", 3, -1): 2}[
                                center.GetSymbol(), len(edges), Chem.GetFormalCharge(mol)]
            families.append([(2., 0, 2, 0)] * double_count + [(1., -1, 3, 0)] * (len(edges) - double_count))
        for family in families:
            for perm in sorted(set(itertools.permutations(family))):
                state = {key: list(values) for key, values in source.items()}
                for (atom_id, bond_id), (order, charge, pairs, radicals) in zip(edges, perm):
                    state["bondOrders"][bond_id] = order
                    state["atomCharges"][atom_id] = charge
                    state["lonePairCounts"][atom_id] = pairs
                    state["radicalCounts"][atom_id] = radicals
                state["atomCharges"][center_index] = Chem.GetFormalCharge(mol) - sum(item[1] for item in perm)
                if state not in states:
                    states.append(state)
        result["equivalentBondGroups"].append({
            "bondIds": sorted(b for _, b in edges), "atomIds": sorted([center_index]+[a for a, _ in edges]),
            "terminalAtomIds": sorted(a for a, _ in edges),
            "order": sum(item[0] for item in families[-1])/len(edges), "basis": "equivalent-terminal-oxygens",
        })
        result["note"] = (f"離域圖以 {sum(item[0] == 2 for item in families[-1])} 條雙鍵在 {len(edges)} 個末端氧間"
                          "交換的 Lewis 式為繪圖約定。平均鍵級不代表實測鍵級或共振權重。")
        if not (reference and reference.get("unpaired")):
            result["note"] += "離域圖只畫這組寫法共有的末端氧孤電子對。各 Lewis 式的形式電荷與完整電子對可切換查看。"
        return result
    if reference and reference.get("unpaired"):
        result["note"] = "開殼層物種：保留一個 Lewis 電子計數式，不推測開殼層 π 電子雲或共振權重；基態自旋另見電子組態。"
        return result
    if reference and reference["name"] == "N₂O":
        center_index = reference["center"]
        center = mol.GetAtomWithIdx(center_index)
        ends = {a.GetSymbol(): a.GetIdx() for a in center.GetNeighbors()}
        bonds = {s: mol.GetBondBetweenAtoms(center_index, i).GetIdx() for s, i in ends.items()}
        for nn, no in [(3, 1), (2, 2), (1, 3)]:
            state = {key: list(values) for key, values in source.items()}
            for symbol, order, neutral_valence in [("N", nn, 3), ("O", no, 2)]:
                state["bondOrders"][bonds[symbol]] = float(order)
                state["atomCharges"][ends[symbol]] = order - neutral_valence
                state["lonePairCounts"][ends[symbol]] = 4 - order
            if state not in states:
                states.append(state)
        result["linearPiCenter"] = center_index
        # NIST orbital occupations: 1π⁴2π⁴. Each transverse plane accounts
        # for four electrons, including the nonbonding contribution.
        result["groups"] = [{"id": k, "atomIds": [ends["N"], center_index, ends["O"]],
                             "bondIds": list(bonds.values()), "piElectrons": 4, "equivalentBondGroups": []}
                            for k in range(2)]
        result["note"] = "線形 N₂O 的兩個互相垂直的 π 系統各含 4 個電子，包含非鍵結成分。離域圖以單線標示 σ 骨架，可開啟 π 軌域檢視方向。"
        result["referenceUrl"] = "https://physics.nist.gov/cgi-bin/Ionization/table.pl?ionization=N2O"
        return result
    if not any(b.GetIsConjugated() for b in mol.GetBonds()):
        return result
    limit = 32
    try:
        supplier = Chem.ResonanceMolSupplier(mol, Chem.ResonanceFlags.KEKULE_ALL, limit + 1)
        supplier.SetNumThreads(1)
        for candidate in supplier:
            state = _lewis_state(candidate)
            key = (tuple(state["atomCharges"]), tuple(state["bondOrders"]))
            if key in seen:
                continue
            if len(states) >= limit:
                result["truncated"] = True
                break
            seen.add(key)
            states.append(state)
        for gid in range(supplier.GetNumConjGrps()):
            atom_ids = [a.GetIdx() for a in mol.GetAtoms() if supplier.GetAtomConjGrpIdx(a.GetIdx()) == gid]
            bond_ids = [b.GetIdx() for b in mol.GetBonds() if supplier.GetBondConjGrpIdx(b.GetIdx()) == gid]
            donor_ids = [i for i in atom_ids if any(p["kind"] == "delocalized" for p in atoms[i]["lonePairs"])]
            electrons = int(round(sum(2 * max(0, source["bondOrders"][i] - 1) for i in bond_ids) + 2 * len(donor_ids)))
            result["groups"].append({"id": gid, "atomIds": atom_ids, "bondIds": bond_ids,
                                      "donorAtomIds": donor_ids, "piElectrons": electrons,
                                      "equivalentBondGroups": []})
    except (RuntimeError, ValueError):
        # Unsupported enumeration must not invent equivalent bonds or prevent
        # the user from inspecting an otherwise supported molecular geometry.
        result["truncated"] = True
        result["note"] += " 此結構的共振枚舉未完成；保留已知 Lewis 式。"
        return result

    if result["truncated"]:
        return result  # A partial list cannot establish balanced assignments.

    # Neutralize only conjugated atoms and normalize only conjugated bonds in a
    # temporary graph. Explicit hydrogens, substituents and remote
    # stereochemistry remain, so carboxylic OH and carbonyl O are not equivalent.
    normalized = Chem.RWMol(mol)
    # The serialized molecule contains explicit H vertices. Once a C=O bond
    # becomes a single edge for this symmetry test, RDKit must not invent an
    # implicit H on O and distinguish it from the original O- endpoint.
    for atom in normalized.GetAtoms():
        atom.SetNoImplicit(True)
        # Mass labels survive in the molecule and Lewis structures. They do
        # not localize a resonance double bond in the electronic drawing.
        atom.SetIsotope(0)
    for group in result["groups"]:
        for i in group["atomIds"]:
            a = normalized.GetAtomWithIdx(i)
            a.SetFormalCharge(0)
            a.SetIsAromatic(False)
        for i in group["bondIds"]:
            b = normalized.GetBondWithIdx(i)
            b.SetBondType(Chem.BondType.SINGLE)
            b.SetIsAromatic(False)
            b.SetStereo(Chem.BondStereo.STEREONONE)
            b.SetBondDir(Chem.BondDir.NONE)
    normalized.UpdatePropertyCache(strict=False)

    def edge_key(bond_id):
        # Subdivide the marked edge with a uniquely typed dummy. Canonical graph
        # equality tests the complete edge environment, not just endpoint ranks.
        marked = Chem.RWMol(normalized)
        edge = marked.GetBondWithIdx(bond_id)
        a, b = edge.GetBeginAtomIdx(), edge.GetEndAtomIdx()
        marked.RemoveBond(a, b)
        marker = Chem.Atom(0)
        marker.SetIsotope(1)
        i = marked.AddAtom(marker)
        marked.AddBond(a, i, Chem.BondType.SINGLE)
        marked.AddBond(i, b, Chem.BondType.SINGLE)
        marked.UpdatePropertyCache(strict=False)
        return Chem.MolToSmiles(marked, canonical=True, isomericSmiles=True, allHsExplicit=True)

    for group in result["groups"]:
        equivalent = {}
        for bid in group["bondIds"]:
            orders = tuple(sorted(state["bondOrders"][bid] for state in states))
            if len(set(orders)) < 2:
                continue
            try:
                key = (edge_key(bid), orders)
            except RuntimeError:
                continue
            equivalent.setdefault(key, []).append(bid)
        for (_, orders), bond_ids in equivalent.items():
            if len(bond_ids) < 2:
                continue
            atom_ids = sorted({i for bid in bond_ids for i in (mol.GetBondWithIdx(bid).GetBeginAtomIdx(), mol.GetBondWithIdx(bid).GetEndAtomIdx())})
            entry = {"bondIds": bond_ids, "atomIds": atom_ids,
                     "order": sum(orders) / len(orders), "basis": "equivalent-Lewis-contributors"}
            group["equivalentBondGroups"].append(entry)
            result["equivalentBondGroups"].append(entry)
    return result


def _graph(mol):
    # RemoveHs keeps stereo atom references and adjusts tetrahedral tags correctly.
    marked = Chem.Mol(mol)
    for atom in marked.GetAtoms():
        atom.SetIntProp("_SourceId", atom.GetIdx())
    editable = _without_hydrogens(marked)
    source_id = {a.GetIdx(): a.GetIntProp("_SourceId") for a in editable.GetAtoms()}
    atoms = [{"id": source_id[a.GetIdx()], "element": a.GetSymbol(), "charge": a.GetFormalCharge(),
              "aromatic": a.GetIsAromatic(), "chiralTag": int(a.GetChiralTag()),
              "explicitHs": a.GetNumExplicitHs(), "noImplicit": a.GetNoImplicit(), "isotope": a.GetIsotope()}
             for a in editable.GetAtoms()]
    for data in atoms:
        source = mol.GetAtomWithIdx(data["id"])
        if source.HasProp("_ProjectExplicitHs"):
            data["explicitHs"] = source.GetIntProp("_ProjectExplicitHs")
            data["noImplicit"] = source.GetBoolProp("_ProjectNoImplicit")
    bonds = [{"id": b.GetIdx(), "a": source_id[b.GetBeginAtomIdx()], "b": source_id[b.GetEndAtomIdx()],
              "order": b.GetBondTypeAsDouble(), "stereo": int(b.GetStereo()),
              "stereoAtoms": [source_id[i] for i in b.GetStereoAtoms()], "bondDir": int(b.GetBondDir())}
             for b in editable.GetBonds()]
    return {"atoms": atoms, "bonds": bonds}


def _restore_stereo_scope(mol, graph):
    """A sampled 3D conformer must not silently specify an unspecified isomer.

    MolBlock import assigns tetrahedral tags from coordinates. The application's
    saved graph records whether the user actually specified those tags. Compare
    topology and defined stereochemistry before removing only inferred tags.
    """
    if not isinstance(graph, dict) or not isinstance(graph.get("atoms"), list) or not isinstance(graph.get("bonds"), list):
        raise ChemistryError("專案的立體化學中繼資料格式無效。")
    actual = _graph(mol)
    def atom_signature(items):
        return sorted((int(a["id"]), str(a["element"]), int(a.get("charge", 0)), int(a.get("isotope", 0))) for a in items)
    def bond_signature(items):
        return sorted((min(int(b["a"]), int(b["b"])), max(int(b["a"]), int(b["b"])), float(b["order"])) for b in items)
    try:
        if atom_signature(actual["atoms"]) != atom_signature(graph["atoms"]) or bond_signature(actual["bonds"]) != bond_signature(graph["bonds"]):
            raise ChemistryError("專案的立體化學中繼資料與 MOL 連接關係不一致，請重新匯入完整專案。")
        # Older graph formats may omit hydrogen policy. Use the MOL-derived
        # defaults for missing fields, preserving every policy that was saved.
        actual_atoms = {a["id"]: a for a in actual["atoms"]}
        project_atoms = [{**{key: actual_atoms[int(data["id"])][key] for key in ("explicitHs", "noImplicit")},
                          **data} for data in graph["atoms"]]
        reference = _read_graph({**graph, "atoms": project_atoms})
        expanded = Chem.AddHs(reference)
        index = {int(a["id"]): i for i, a in enumerate(graph["atoms"])}
        for data in project_atoms:
            atom = mol.GetAtomWithIdx(int(data["id"]))
            ref_atom = expanded.GetAtomWithIdx(index[atom.GetIdx()])
            if sorted(n.GetIsotope() for n in atom.GetNeighbors() if n.GetAtomicNum() == 1) != sorted(
                    n.GetIsotope() for n in ref_atom.GetNeighbors() if n.GetAtomicNum() == 1):
                raise ChemistryError("專案的氫原子數與 MOL 不一致，請重新匯入完整專案。")
            atom.SetIntProp("_ProjectExplicitHs", int(data["explicitHs"]))
            atom.SetBoolProp("_ProjectNoImplicit", bool(data["noImplicit"]))
            if not int(data.get("chiralTag", 0)):
                atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
                if atom.HasProp("_CIPCode"):
                    atom.ClearProp("_CIPCode")
        # Compare after restoring the original scope: inferred neighboring
        # centers must not change a defined pseudoasymmetric descriptor.
        reference_labels, actual_labels = _true_cip(reference)[0], _true_cip(mol)[0]
        for data in graph["atoms"]:
            source_id = int(data["id"])
            expected = reference_labels.get(index[source_id])
            if int(data.get("chiralTag", 0)) and expected is not None:
                if actual_labels.get(source_id) != expected:
                    raise ChemistryError("輸入三維座標與已指定的四面體立體化學不一致，請重新生成結構。")
        for bond in mol.GetBonds():
            bond.SetBondDir(Chem.BondDir.NONE)
        for data in graph["bonds"]:
            bond = mol.GetBondBetweenAtoms(int(data["a"]), int(data["b"]))
            ref = reference.GetBondBetweenAtoms(index[int(data["a"])], index[int(data["b"])])
            if int(data.get("stereo", 0)) in {0, 1}:
                bond.SetStereo(Chem.BondStereo.STEREONONE)
            elif ref.GetStereo() not in {Chem.BondStereo.STEREONONE, Chem.BondStereo.STEREOANY} and bond.GetStereo() != ref.GetStereo():
                raise ChemistryError("輸入三維座標與已指定的雙鍵立體化學不一致，請重新生成結構。")
        Chem.SetDoubleBondNeighborDirections(mol)
        Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    except ChemistryError:
        raise
    except Exception as exc:
        raise ChemistryError("無法驗證專案的立體化學中繼資料。") from exc


def _stereo_warnings(mol):
    warnings = [mol.GetProp("_IgnoredStereo")] if mol.HasProp("_IgnoredStereo") else []
    unspecified_atoms = [idx + 1 for idx, label in Chem.FindMolChiralCenters(mol, includeUnassigned=True, useLegacyImplementation=False) if label == "?"]
    if unspecified_atoms:
        warnings.append("原子 " + "、".join(map(str, unspecified_atoms)) + " 有未指定的四面體立體中心；目前僅呈現其中一個可能構型，請以 @／@@ 或具立體資訊的 MOL 明確指定。")
    try:
        unknown_bonds = [str(x.centeredOn + 1) for x in Chem.FindPotentialStereo(mol) if str(x.type) == "Bond_Double" and str(x.specified) == "Unspecified"]
        if unknown_bonds:
            warnings.append("雙鍵 " + "、".join(unknown_bonds) + " 的 E/Z 未指定；目前顯示一個可能構型。可點選可編輯雙鍵設定構型，或用 SMILES 的 / 與 \\ 指定。")
    except Exception:
        pass
    return warnings


def _serialize(mol, records, method, warnings=None):
    if any(r["energy"] is not None and not math.isfinite(float(r["energy"])) for r in records):
        raise ChemistryError("目前座標產生非有限的力場能量；請檢查重疊原子，或由連接關係重新生成 3D 構象。")
    records = sorted(records, key=lambda r: r["energy"] if r["energy"] is not None else float("inf"))
    active_id = records[0]["confId"]
    conf = mol.GetConformer(active_id)
    if not mol.HasProp("_InputCoordinateFrame"):
        for c in mol.GetConformers():
            pos = np.array(c.GetPositions())
            pos -= pos.mean(axis=0)
            for i, v in enumerate(pos):
                c.SetAtomPosition(i, Point3D(*map(float, v)))
    positions = np.array(conf.GetPositions())
    kekule = Chem.Mol(mol)
    Chem.Kekulize(kekule, clearAromaticFlags=False)
    atom_cip = _true_cip(mol)[0]
    teaching = _teaching_spec(mol)
    high_domain_center = None
    if teaching and len(teaching["directions"]) + len(teaching["loneDirections"]) > 4:
        high_domain_center = teaching["center"]
    atoms = []
    for a in mol.GetAtoms():
        atoms.append({"id": a.GetIdx(), "element": a.GetSymbol(), "charge": a.GetFormalCharge(),
                      "position": [round(float(v), 6) for v in positions[a.GetIdx()]],
                      "hybridization": "not-assigned" if a.GetIdx() == high_domain_center else str(a.GetHybridization()), "degree": a.GetDegree(),
                      "lonePairs": _lone_pairs(mol, a, kekule, positions),
                      "cip": atom_cip.get(a.GetIdx()),
                      "radicals": a.GetNumRadicalElectrons(), "isotope": a.GetIsotope()})
    bonds = []
    stereo_controls = _stereo_controls(mol)
    for b in mol.GetBonds():
        rotatable, reason = _rotation_info(mol, b)
        bonds.append({"id": b.GetIdx(), "a": b.GetBeginAtomIdx(), "b": b.GetEndAtomIdx(),
                      "order": b.GetBondTypeAsDouble(), "aromatic": b.GetIsAromatic(),
                      "length": round(float(np.linalg.norm(positions[b.GetBeginAtomIdx()] - positions[b.GetEndAtomIdx()])), 5),
                      "rotatable": rotatable, "rotationReason": reason, "conjugated": b.GetIsConjugated(),
                      "stereo": ("STEREO" + stereo_controls[b.GetIdx()]["current"]
                                 if b.GetIdx() in stereo_controls and stereo_controls[b.GetIdx()]["current"] in {"E", "Z"}
                                 else str(b.GetStereo())), "inRing": b.IsInRing(),
                      **({"stereoControl": stereo_controls[b.GetIdx()]} if b.GetIdx() in stereo_controls else {})})
    conformers = [{"id": i, "energy": round(float(r["energy"]), 6) if r["energy"] is not None else None,
                   "positions": [[round(float(v), 6) for v in p] for p in mol.GetConformer(r["confId"]).GetPositions()],
                   "lonePairs": [_lone_pairs(mol, atom, kekule, np.array(mol.GetConformer(r["confId"]).GetPositions())) for atom in mol.GetAtoms()],
                   "molblock": Chem.MolToMolBlock(mol, confId=r["confId"]),
                   "xyz": Chem.MolToXYZBlock(mol, confId=r["confId"]),
                   "converged": bool(r["converged"])} for i, r in enumerate(records)]
    special_geometry = _is_co2(mol) or _is_ozone(mol) or _teaching_spec(mol) or _reference_spec(mol) or _is_isolated_ion(mol)
    base_notice = "孤電子對葉瓣僅示意 Lewis 電子計數與局部方向，並非電子密度；參考／理想幾何亦不代表溶液或所有溫度條件下的結構。" if special_geometry else BASE_WARNING
    notice = [base_notice] + (warnings or []) + _stereo_warnings(mol)
    if (mol.GetNumAtoms() == 4 and mol.GetNumBonds() == 3 and
            sorted((a.GetSymbol(), a.GetDegree(), a.GetFormalCharge()) for a in mol.GetAtoms()) ==
            [("H", 1, 0), ("H", 1, 0), ("O", 2, 0), ("O", 2, 0)]):
        notice.append("H₂O₂ 的力場二面角僅供估計。NIST 收錄的 1962 年內座標給出 H–O–O–H 119.8°，"
                      "另一研究在偶極矩分析採用平衡角 111.5°。資料：https://cccbdb.nist.gov/exp2x.asp?casno=7722841&charge=0")
    if mol.HasProp("_StereoFromImport"):
        notice.append("此 MOL 未附原始立體指定中繼資料；立體標記可能由檔案三維座標推導，請核對是否符合原先意圖。")
    if "UFF" in method:
        notice.append("此結構使用 UFF；可用參數及幾何精度與 MMFF94s 不同，能量不可跨力場比較。")
        if any(a.GetAtomicNum() == 5 for a in mol.GetAtoms()):
            notice.append("含硼結構的 UFF 鍵長可能有明顯系統誤差；形狀可供定性檢視，鍵長與能量不宜作定量依據。")
    if any(a.GetFormalCharge() != 0 for a in mol.GetAtoms()) and any(b.GetIsConjugated() for b in mol.GetBonds()):
        notice.append("形式電荷與孤電子對數依一個 Lewis 共振式標記；離域系統的等價原子不代表具有不同的固定電荷或局域電子密度。")
    if not special_geometry and not records[0]["converged"] and "未最佳化" not in method and "保留" not in method:
        notice.append("最低能量候選在迭代上限內未完全收斂；請再次最佳化並檢查幾何。")
    if any(a.GetAtomicNum() in {15,16,17,35,53} and a.GetTotalValence() > 4 for a in mol.GetAtoms()):
        notice.append("含超價主族中心：力場可能無法充分描述電子結構，孤電子對方向僅作示意；精確構型需量子化學或實驗資料確認。")
    smiles = Chem.MolToSmiles(_without_hydrogens(mol), isomericSmiles=True)
    resonance = _resonance_metadata(mol, atoms)
    if resonance.get("linearPiCenter") is not None or any(g["basis"] == "equivalent-terminal-oxygens" for g in resonance["equivalentBondGroups"]):
        notice.append(resonance["note"])
    return {"smiles": smiles, "formula": rdMolDescriptors.CalcMolFormula(mol), **_formula_metadata(mol),
            "mass": round(Descriptors.MolWt(mol), 4), "charge": Chem.GetFormalCharge(mol),
            "atoms": atoms, "bonds": bonds, "conformers": conformers, "activeConformer": 0,
            "resonance": resonance,
            "method": method, "energy": conformers[0]["energy"],
            "molblock": Chem.MolToMolBlock(mol, confId=active_id), "xyz": Chem.MolToXYZBlock(mol, confId=active_id),
            "warnings": list(dict.fromkeys(notice)), "graph": _graph(mol),
            "rdkitVersion": rdBase.rdkitVersion,
            "stereoSummary": {"centers": [{"id": a["id"], "cip": a["cip"]} for a in atoms if a["cip"]],
                              "doubleBonds": [{"id": b["id"], "stereo": b["stereo"]} for b in bonds if b["stereo"] not in {"STEREONONE", "STEREOANY"}]}}


def _generate(payload):
    mol = _read(payload)
    return _generate_molecule(mol, payload)


def _coordinate_isomer(mol, conf_id):
    probe = Chem.Mol(mol)
    Chem.RemoveStereochemistry(probe)
    Chem.AssignStereochemistryFrom3D(probe, confId=conf_id, replaceExistingTags=True)
    return Chem.MolToSmiles(probe, isomericSmiles=True)


def _generate_molecule(mol, payload, verify_stereo=None):
    if _is_co2(mol):
        return _co2_model(mol)
    if _is_ozone(mol):
        return _ozone_model(mol)
    if _teaching_spec(mol) or _reference_spec(mol) or _is_isolated_ion(mol):
        return _educational_model(mol)
    if verify_stereo is None:
        verify_stereo = _true_cip(mol)
    samples = min(32, max(1, int(payload.get("samples", 8))))
    params = AllChem.ETKDGv3()
    params.randomSeed = int(payload.get("seed", 20261025)) % (2**31 - 1)
    params.pruneRmsThresh = .2
    params.numThreads = 1
    params.enforceChirality = True
    params.useSmallRingTorsions = True
    params.clearConfs = True
    with rdBase.BlockLogs():
        ids = list(AllChem.EmbedMultipleConfs(mol, numConfs=samples, params=params))
        if not ids:
            params.useRandomCoords = True
            ids = list(AllChem.EmbedMultipleConfs(mol, numConfs=samples, params=params))
    if not ids:
        raise ChemistryError("無法產生滿足立體與距離限制的 3D 構象；請檢查環張力、鍵級和立體標記。")
    records = []
    name = ""
    has_unspecified = any(str(s.type) in {"Atom_Tetrahedral", "Bond_Double"} and str(s.specified) != "Specified"
                          for s in Chem.FindPotentialStereo(mol))
    selected_isomer = None
    for cid in ids:
        ff, name = _field(mol, cid)
        status = ff.Minimize(maxIts=1200)
        _verify_stereo_geometry(mol, cid, verify_stereo)
        if has_unspecified:
            isomer = _coordinate_isomer(mol, cid)
            if selected_isomer is None:
                selected_isomer = isomer
            elif isomer != selected_isomer:
                continue
        records.append({"confId": cid, "energy": ff.CalcEnergy(), "converged": status == 0})
    notes = [f"由 {samples} 次構象取樣取得 {len(records)} 個候選；最低能量僅限於本次搜尋，不保證全域最低能量。"]
    if has_unspecified:
        notes.append("輸入含未指定構型。清單僅比較第一個取樣構型的構象；不同立體異構物不參與能量排名。")
    return _serialize(mol, records, f"ETKDGv3 + {name}", notes)


def _existing(payload, action):
    if not payload.get("molblock"):
        raise ChemistryError("此操作需要具 3D 座標的 MOL 結構。")
    mol = _read(payload)
    if not mol.GetNumConformers() or not mol.GetConformer().Is3D():
        raise ChemistryError("MOL 沒有有效的 3D 座標；請先產生幾何。")
    conf = mol.GetConformer()
    input_positions = np.array(conf.GetPositions())
    if not np.isfinite(input_positions).all():
        raise ChemistryError("輸入的 3D 座標含無效數值，請重新匯出有效的 MOL 檔案。")
    left, right = np.triu_indices(mol.GetNumAtoms(), k=1)
    coincident = np.flatnonzero(np.linalg.norm(input_positions[left] - input_positions[right], axis=1) < .05)
    if len(coincident):
        i = coincident[0]
        raise ChemistryError(f"輸入座標中的原子 {left[i]+1} 與 {right[i]+1} 重疊或幾乎重疊（距離小於 0.05 Å）；請修正座標或重新生成三維幾何。")
    if _is_co2(mol) and action in {"analyze", "optimize"}:
        return _co2_model(mol, preserve=action == "analyze")
    if _is_ozone(mol) and action in {"analyze", "optimize"}:
        return _ozone_model(mol, preserve=action == "analyze")
    if _teaching_spec(mol) or _reference_spec(mol) or _is_isolated_ion(mol):
        if action == "rotate":
            raise ChemistryError("此參考／理想幾何沒有可旋轉的內部單鍵構象；可旋轉整個三維視角。")
        return _educational_model(mol, preserve=action == "analyze")
    warnings = []
    if action == "rotate":
        try:
            a, b = map(int, payload["bond"])
            angle = float(payload.get("angle", 0))
            if not math.isfinite(angle) or abs(angle) > 360:
                raise ValueError()
            bond = mol.GetBondBetweenAtoms(a, b)
        except Exception as exc:
            raise ChemistryError("旋轉鍵或角度無效；角度範圍為 −360° 至 +360°。") from exc
        if bond is None:
            raise ChemistryError("指定原子之間沒有鍵。")
        rotatable, reason = _rotation_info(mol, bond)
        if not rotatable:
            raise ChemistryError(reason)
        moving, stack = {b}, [b]
        while stack:
            current = stack.pop()
            for n in mol.GetAtomWithIdx(current).GetNeighbors():
                idx = n.GetIdx()
                if idx == a or idx in moving:
                    continue
                moving.add(idx)
                stack.append(idx)
        positions = np.array(conf.GetPositions())
        origin, axis = positions[a], _unit(positions[b] - positions[a])
        theta = math.radians(angle)
        for i in moving:
            p = positions[i] - origin
            q = p * math.cos(theta) + np.cross(axis, p) * math.sin(theta) + axis * np.dot(axis, p) * (1 - math.cos(theta)) + origin
            conf.SetAtomPosition(i, Point3D(*map(float, q)))
        warnings.append(reason)
        warnings.append("手動旋轉後僅計算當前構象能量，尚未鬆弛；原子碰撞可能造成極高能量。")
    ff, name = _field(mol)
    converged = False
    if action == "optimize":
        expected_stereo = _true_cip(mol)
        converged = ff.Minimize(maxIts=2000) == 0
        _verify_stereo_geometry(mol, conf.GetId(), expected_stereo)
        method = f"{name} · 局部最佳化"
    elif action == "rotate":
        method = f"{name} · 手動扭轉（未最佳化）"
    else:
        method = f"{name} · 保留輸入座標"
    return _serialize(mol, [{"confId": conf.GetId(), "energy": ff.CalcEnergy(), "converged": converged}], method, warnings)


def process(payload: dict[str, Any]) -> dict[str, Any]:
    """Validated JSON entry point used by the loopback HTTP server."""
    if not isinstance(payload, dict):
        raise ChemistryError("請求格式必須為 JSON 物件。")
    action = payload.get("action", "generate")
    try:
        if action == "inspect":
            return _inspect(payload)
        if action == "generate":
            return _generate(payload)
        if action == "set_stereo":
            return _set_stereo(payload)
        if action in {"rotate", "optimize", "analyze"}:
            return _existing(payload, action)
        raise ChemistryError("不支援的化學操作。")
    except ChemistryError:
        raise
    except Exception as exc:
        raise ChemistryError("化學計算未完成，請檢查結構、原子價數或縮小分子後再試。") from exc
