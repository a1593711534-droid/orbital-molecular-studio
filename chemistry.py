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

SUPPORTED = {"H", "B", "C", "N", "O", "F", "Si", "P", "S", "Cl", "Br", "I"}
VALENCE_ELECTRONS = {"H": 1, "B": 3, "C": 4, "N": 5, "O": 6, "F": 7,
                     "Si": 4, "P": 5, "S": 6, "Cl": 7, "Br": 7, "I": 7}
BOND_TYPES = {1: Chem.BondType.SINGLE, 1.5: Chem.BondType.AROMATIC,
              2: Chem.BondType.DOUBLE, 3: Chem.BondType.TRIPLE}
BASE_WARNING = "座標是孤立分子的力場構象估計，非實驗結構或量子化學結果；孤電子對葉瓣僅示意 Lewis 電子計數與局部方向，並非電子密度。"
CO2_REFERENCE_URL = "https://cccbdb.nist.gov/exp2x.asp?casno=124389&charge=0"
CO2_BOND_LENGTH = 1.1621  # NIST CCCBDB gas-phase experimental Cartesian geometry.
OZONE_REFERENCE_URL = "https://cccbdb.nist.gov/expgeom2x.asp?casno=10028156&charge=0"
OZONE_BOND_LENGTH = 1.278
OZONE_BOND_ANGLE = 116.8


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
            Chem.SanitizeMol(molecule)
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
            if not (_is_co2(checked) or _is_ozone(checked)) and not (AllChem.MMFFHasAllMoleculeParams(checked) or AllChem.UFFHasAllMoleculeParams(checked)):
                return {**empty, "message": "這個結構缺少本機力場參數，暫時不能建立三維模型。"}
        except ChemistryError as exc:
            return {**empty, "message": str(exc)}
        display = Chem.Mol(molecule)
        for atom in display.GetAtoms():
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
        rdMolDraw2D.PrepareAndDrawMolecule(drawer, display)
        drawer.FinishDrawing()
        svg = drawer.GetDrawingText()
        svg = svg[svg.index("<svg"):]
        return {"valid": True, "svg": svg,
                "formula": rdMolDescriptors.CalcMolFormula(molecule),
                **_formula_metadata(molecule), "charge": Chem.GetFormalCharge(molecule),
                "atomCount": molecule.GetNumAtoms(), "bondCount": molecule.GetNumBonds(),
                "canonicalSmiles": Chem.MolToSmiles(molecule, isomericSmiles=True),
                "message": "連接結構有效",
                "warnings": ["此為二維連接圖；三維幾何需生成後確認。"]}


def _reject_high_domain_centers(mol):
    """Availability of force-field parameters does not establish correct geometry.

    RDKit 2025.09.6 tests give a tetrahedral SF4 with MMFF and a severely
    distorted PF5 with UFF. Exclude >4-domain centers until validated electronic
    structure treatment is available. Tetrahedral oxyanions remain in scope.
    This also runs before sanitization so e.g. ClF3 gets an intelligible error.
    """
    for atom in mol.GetAtoms():
        if atom.GetSymbol() not in {"Si", "P", "S", "Cl", "Br", "I"} or atom.GetIsAromatic():
            continue
        hydrogens = atom.GetNumExplicitHs()
        remainder = VALENCE_ELECTRONS[atom.GetSymbol()] - atom.GetFormalCharge() - hydrogens - sum(b.GetBondTypeAsDouble() for b in atom.GetBonds())
        domains = atom.GetDegree() + hydrogens + max(0, remainder / 2)
        if domains > 4.01:
            raise ChemistryError(f"原子 {atom.GetIdx()+1}（{atom.GetSymbol()}）需要超過四個電子域的幾何描述；此版本尚未驗證三角雙錐、蹺蹺板、T 形及八面體等超價中心，故不產生可能錯誤的形狀。請使用經驗證的量子化學工具處理。")


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
        atom.SetFormalCharge(int(data.get("charge", 0)))
        if abs(atom.GetFormalCharge()) > 3:
            raise ChemistryError("形式電荷必須介於 −3 與 +3。")
        atom.SetIsotope(int(data.get("isotope", 0)))
        atom.SetIsAromatic(bool(data.get("aromatic", False)))
        atom.SetNumExplicitHs(int(data.get("explicitHs", 0)))
        atom.SetNoImplicit(bool(data.get("noImplicit", False)))
        tag = int(data.get("chiralTag", 0))
        if tag in Chem.ChiralType.values:
            atom.SetChiralTag(Chem.ChiralType.values[tag])
        mapping[old_id] = rw.AddAtom(atom)
    seen = set()
    for data in bonds:
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
    Chem.SanitizeMol(mol)
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
                mol = Chem.MolFromSmiles(smiles, sanitize=False)
            if mol is None:
                raise ChemistryError("無法解析結構：請檢查 SMILES、價數、環閉合與立體化學標記。")
            _reject_high_domain_centers(mol)
            Chem.SanitizeMol(mol)
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
        if atom.GetNumRadicalElectrons():
            raise ChemistryError("此版本不支援自由基的幾何與孤電子對推估；請檢查價數及形式電荷。")
    mol = Chem.AddHs(mol, addCoords=bool(mol.GetNumConformers()))
    _reject_high_domain_centers(mol)
    if mol.GetNumAtoms() > 200:
        raise ChemistryError("補氫後超過 200 個原子，請縮小結構。")
    Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
    if payload.get("molblock") and payload.get("stereoGraph") is not None:
        _restore_stereo_scope(mol, payload["stereoGraph"])
    elif payload.get("molblock") and Chem.FindPotentialStereo(mol):
        mol.SetBoolProp("_StereoFromImport", True)
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
        trial_label = _true_cip(trial)[1].get(bond.GetIdx())
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
    # Only expose reference atom IDs when priority is obvious from atomic
    # number/isotope. Deeper sequence-rule cases are labeled by true CIP above,
    # without presenting legacy ranks as if they were authoritative.
    reference = []
    periodic_table = Chem.GetPeriodicTable()
    def immediate_priority(atom):
        number = atom.GetAtomicNum()
        return number, atom.GetIsotope() or periodic_table.GetMostCommonIsotope(number)
    for side in neighbors:
        ranked = sorted(side, key=immediate_priority)
        if len(ranked) > 1:
            left, right = ranked[-2:]
            if immediate_priority(left) == immediate_priority(right):
                reference = []
                break
        reference.append(ranked[-1].GetIdx())
    if len(reference) == 2:
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
    probe = Chem.Mol(mol)
    for atom in probe.GetAtoms():
        atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
    for bond in probe.GetBonds():
        bond.SetStereo(Chem.BondStereo.STEREONONE)
        bond.SetBondDir(Chem.BondDir.NONE)
    Chem.AssignStereochemistryFrom3D(probe, confId=conf_id, replaceExistingTags=True)
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
    return {"atomCharges": charges, "bondOrders": orders, "lonePairCounts": pairs}


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
    # temporary graph. Explicit hydrogens, isotopes, substituents and remote
    # stereochemistry remain, so carboxylic OH and carbonyl O are not equivalent.
    normalized = Chem.RWMol(mol)
    # The serialized molecule contains explicit H vertices. Once a C=O bond
    # becomes a single edge for this symmetry test, RDKit must not invent an
    # implicit H on O and distinguish it from the original O- endpoint.
    for atom in normalized.GetAtoms():
        atom.SetNoImplicit(True)
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
    editable = Chem.RemoveHs(marked)
    source_id = {a.GetIdx(): a.GetIntProp("_SourceId") for a in editable.GetAtoms()}
    atoms = [{"id": source_id[a.GetIdx()], "element": a.GetSymbol(), "charge": a.GetFormalCharge(),
              "aromatic": a.GetIsAromatic(), "chiralTag": int(a.GetChiralTag()),
              "explicitHs": a.GetNumExplicitHs(), "noImplicit": a.GetNoImplicit(), "isotope": a.GetIsotope()}
             for a in editable.GetAtoms()]
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
        reference = _read_graph(graph)
        index = {int(a["id"]): i for i, a in enumerate(graph["atoms"])}
        for data in graph["atoms"]:
            atom = mol.GetAtomWithIdx(int(data["id"]))
            ref = reference.GetAtomWithIdx(index[int(data["id"])])
            if not int(data.get("chiralTag", 0)):
                atom.SetChiralTag(Chem.ChiralType.CHI_UNSPECIFIED)
                if atom.HasProp("_CIPCode"):
                    atom.ClearProp("_CIPCode")
            elif ref.HasProp("_CIPCode"):
                if not atom.HasProp("_CIPCode") or atom.GetProp("_CIPCode") != ref.GetProp("_CIPCode"):
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
    warnings = []
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
    positions = np.array(conf.GetPositions())
    # Centering is applied equally to every conformer; no graph/stereo operation.
    for c in mol.GetConformers():
        pos = np.array(c.GetPositions())
        pos -= pos.mean(axis=0)
        for i, v in enumerate(pos):
            c.SetAtomPosition(i, Point3D(*map(float, v)))
    positions = np.array(conf.GetPositions())
    kekule = Chem.Mol(mol)
    Chem.Kekulize(kekule, clearAromaticFlags=False)
    atoms = []
    for a in mol.GetAtoms():
        atoms.append({"id": a.GetIdx(), "element": a.GetSymbol(), "charge": a.GetFormalCharge(),
                      "position": [round(float(v), 6) for v in positions[a.GetIdx()]],
                      "hybridization": str(a.GetHybridization()), "degree": a.GetDegree(),
                      "lonePairs": _lone_pairs(mol, a, kekule, positions),
                      "cip": a.GetProp("_CIPCode") if a.HasProp("_CIPCode") else None,
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
    base_notice = "孤電子對葉瓣僅示意 Lewis 電子計數與局部方向，並非電子密度；參考幾何亦不代表溶液或所有溫度條件下的結構。" if (_is_co2(mol) or _is_ozone(mol)) else BASE_WARNING
    notice = [base_notice] + (warnings or []) + _stereo_warnings(mol)
    if mol.HasProp("_StereoFromImport"):
        notice.append("此 MOL 未附原始立體指定中繼資料；立體標記可能由檔案三維座標推導，請核對是否符合原先意圖。")
    if "UFF" in method:
        notice.append("此結構使用 UFF；可用參數及幾何精度與 MMFF94s 不同，能量不可跨力場比較。")
        if any(a.GetAtomicNum() == 5 for a in mol.GetAtoms()):
            notice.append("含硼結構的 UFF 鍵長可能有明顯系統誤差；形狀可供定性檢視，鍵長與能量不宜作定量依據。")
    if any(a.GetFormalCharge() != 0 for a in mol.GetAtoms()) and any(b.GetIsConjugated() for b in mol.GetBonds()):
        notice.append("形式電荷與孤電子對數依一個 Lewis 共振式標記；離域系統的等價原子不代表具有不同的固定電荷或局域電子密度。")
    if not records[0]["converged"] and "未最佳化" not in method and "保留" not in method:
        notice.append("最低能量候選在迭代上限內未完全收斂；請再次最佳化並檢查幾何。")
    if any(a.GetAtomicNum() in {15,16,17,35,53} and a.GetTotalValence() > 4 for a in mol.GetAtoms()):
        notice.append("含超價主族中心：力場可能無法充分描述電子結構，孤電子對方向僅作示意；精確構型需量子化學或實驗資料確認。")
    smiles = Chem.MolToSmiles(Chem.RemoveHs(mol), isomericSmiles=True)
    return {"smiles": smiles, "formula": rdMolDescriptors.CalcMolFormula(mol), **_formula_metadata(mol),
            "mass": round(Descriptors.MolWt(mol), 4), "charge": Chem.GetFormalCharge(mol),
            "atoms": atoms, "bonds": bonds, "conformers": conformers, "activeConformer": 0,
            "resonance": _resonance_metadata(mol, atoms),
            "method": method, "energy": conformers[0]["energy"],
            "molblock": Chem.MolToMolBlock(mol, confId=active_id), "xyz": Chem.MolToXYZBlock(mol, confId=active_id),
            "warnings": list(dict.fromkeys(notice)), "graph": _graph(mol),
            "rdkitVersion": rdBase.rdkitVersion,
            "stereoSummary": {"centers": [{"id": a["id"], "cip": a["cip"]} for a in atoms if a["cip"]],
                              "doubleBonds": [{"id": b["id"], "stereo": b["stereo"]} for b in bonds if b["stereo"] not in {"STEREONONE", "STEREOANY"}]}}


def _generate(payload):
    mol = _read(payload)
    return _generate_molecule(mol, payload)


def _generate_molecule(mol, payload, verify_stereo=None):
    if _is_co2(mol):
        return _co2_model(mol)
    if _is_ozone(mol):
        return _ozone_model(mol)
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
    for cid in ids:
        ff, name = _field(mol, cid)
        status = ff.Minimize(maxIts=1200)
        if verify_stereo is not None:
            _verify_stereo_geometry(mol, cid, verify_stereo)
        records.append({"confId": cid, "energy": ff.CalcEnergy(), "converged": status == 0})
    return _serialize(mol, records, f"ETKDGv3 + {name}", [f"由 {samples} 次構象取樣取得 {len(records)} 個候選；最低能量僅限於本次搜尋，不保證全域最低能量。"])


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
    if any(np.linalg.norm(input_positions[b.GetBeginAtomIdx()] - input_positions[b.GetEndAtomIdx()]) < .05 for b in mol.GetBonds()):
        raise ChemistryError("輸入座標包含重疊或幾乎重疊的成鍵原子；請由 SMILES／連接表重新生成三維幾何。")
    if _is_co2(mol) and action in {"analyze", "optimize"}:
        return _co2_model(mol, preserve=action == "analyze")
    if _is_ozone(mol) and action in {"analyze", "optimize"}:
        return _ozone_model(mol, preserve=action == "analyze")
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
        converged = ff.Minimize(maxIts=2000) == 0
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
