# ORBITAL 化學模型查核與回歸依據

查核日期：2026-11-10。本文記錄化學正確性的判準、已查閱來源與模型限制；實際可用物種以程式和回歸測試為準。它不是量子化學驗證報告，也不把「成功建立座標」等同於「證明物種穩定」。

## 本次原始碼查核

### v1.3.1 稽核複驗（2026-11-14）

| 物種 | 生成與重新套用幾何的判準 |
| --- | --- |
| ClO₂⁻ | 以氣相光電子光譜的 Franck–Condon 分析所推估的平衡結構生成折線形，Cl–O 為 1.567 ± 0.002 Å，O–Cl–O 為 116.5 ± 0.5°。不提供力場能量。[Zheng 等，2007](https://doi.org/10.1016/j.cplett.2007.10.018) |
| ClO₃⁻、BrO₃⁻、CH₃⁻ | 氯酸根與溴酸根的溶液振動光譜，以及甲基負離子的氣相光電子光譜分別支持三角錐形。工作室以 AX₃E 模板表現中央孤電子對；三條鍵間的 109.47° 為理想電子域角，鍵長由共價半徑和設定，能量留空。[氯酸根與溴酸根](https://journals.aps.org/pr/abstract/10.1103/PhysRev.51.235) · [甲基負離子](https://pubs.acs.org/doi/10.1021/jacs.5b07013) |
| N₂O | `N#[N+][O-]` 與 `[N-]=[N+]=O` 均生成線形 N–N–O；N–N 為 1.1282 Å，N–O 為 1.1842 Å。NIST 軌域表列 1π⁴、2π⁴，合計八個 π 電子，包含非鍵結成分。離域圖沿兩個垂直方向各計四個電子，在兩端各保留一對局域 σ 孤電子。Lewis 視圖保留輸入式的形式電荷和鍵級。[NIST 核間距](https://cccbdb.nist.gov/exp2x.asp?casno=10024972&charge=0) · [NIST 軌域佔據數](https://physics.nist.gov/cgi-bin/Ionization/table.pl?ionization=N2O) |
| NO₂ | `N(=O)[O]` 與 `O=[N+][O-]` 均生成基態雙重態的折線形模型。兩個 N–O 皆為 1.193 Å，O–N–O 為 134.1°。未成對電子數為一，不從單一 Lewis 式推定自旋密度。[PubChem NO₂](https://pubchem.ncbi.nlm.nih.gov/compound/Nitrogen-dioxide) · [NIST NO₂](https://cccbdb.nist.gov/exp2x.asp?casno=10102440&charge=0) |
| CS₂、H₂O₂ | CS₂ 根據氣相參考資料生成直線形，兩個 C–S 均為 1.554 Å。H₂O₂ 保留力場扭轉功能，二面角是模型估計；NIST 彙整的 1962 年內座標值為 119.8°，另有一項偶極矩分析採用平衡角 111.5°。[NIST CS₂](https://cccbdb.nist.gov/exp2x.asp?casno=75150&charge=0) · [NIST H₂O₂](https://cccbdb.nist.gov/exp2x.asp?casno=7722841&charge=0) |

SO₂ 的離域圖採一條雙鍵在兩個末端氧之間交換的約定；SO₄²⁻ 採兩條雙鍵在四個末端氧之間交換。兩者的示意鍵級均為 1.5。圖只顯示不同寫法共有的末端氧孤電子對，切換 Lewis 式可檢查輸入的完整電子帳。¹⁸O 標記的 O₃ 保留標記、質量和 Lewis 資料；同一末端的質量標記不會把其所在鍵鎖定成單鍵或雙鍵。此處的平均鍵級供繪圖，沒有估算各貢獻式的物理權重。

H⁻ 與 O²⁻ 依單原子離子模型分別顯示一對、四對孤電子，能量欄留空。預覽與生成會拒絕超出支援電子組態的單原子輸入（例如 `[F-3]`）。回歸案例涵蓋預覽、SMILES 生成、連接圖重建、MOL 與專案讀回，以及重新套用幾何。

### v1.3.0 查核基準（2026-11-10）

查核開始時，`chemistry.py` 的 `_reject_high_domain_centers` 一律拒絕超過四電子域的中心，`_read` 拒絕所有自由基及中性 O2，元素清單亦缺 Be、Xe。因此 PF5、SF6、SF4、ClF3、XeF2、XeF4、BeCl2、O2、NO、NO2 等常見教學例子無法建立。原有拒絕是模型範圍限制，不代表這些物質不存在。

可接受的修復路徑是：一般分子保留經驗力場；已知小分子使用有來源的參考幾何；特殊主族結構使用明確標示的理想 VSEPR 教學模板。不能單純移除防護，再把未經驗證的通用力場輸出當作正確答案。

前端查核開始時沒有常見物種選單，且計算面板統一使用「最佳化」「構象搜尋」和 kcal/mol。加入參考幾何或教學模板時，介面亦須區分重建模型與力場最佳化；沒有能量的模型必須顯示未提供，不能當作零能量。

## 模型與資料來源的必要區分

| 模型 | 可表示的內容 | 必須保留的限制 |
| --- | --- | --- |
| ETKDGv3 + MMFF94s/UFF | 連接關係、取樣構象、該力場下的局部能量 | 非實驗幾何；取樣不保證找到全域最低能量；不同分子或不同力場能量不能直接排名 |
| 氣相實驗參考幾何 | 特定物種的文獻鍵長、角度與對稱性 | 非本機最佳化；不是所有相態、溫度或溶劑中的結構；無力場能量 |
| 理想 VSEPR 教學模板 | 電子域與原子排列的形狀分類 | 理想角不等於實測角；以共價半徑和設定的長度只是顯示尺度，不能宣稱實驗鍵長；無力場能量 |
| 匯入座標 | 使用者檔案內的幾何 | 分析時保留；不得悄悄改成參考結構；套用參考／理想幾何須是明確操作 |

共價半徑和作為球棒顯示尺度是本專案的介面近似，並非 VSEPR 的定量預測。三角雙錐的軸向與赤道鍵在真實分子中可不同，模板即使使用同長棒亦必須標示理想化。參考值與模板都不應宣稱完成力場收斂。

RDKit 方法依據：[RDKit Book](https://www.rdkit.org/docs/RDKit_Book.html)。

## 電子計數與共振

總價電子數 `E = Σ valenceElectrons(atom) − netCharge`。一個 Lewis 圖應滿足 `E = 2 × Σ bondOrders + 2 × Σ lonePairCounts + Σ radicalElectrons`。形式電荷總和必須等於物種淨電荷。形式電荷是分帳規則，不是部分電荷或氧化數。[OpenStax：Formal Charges and Resonance](https://openstax.org/books/chemistry-2e/pages/7-4-formal-charges-and-resonance)

共振式保留原子連接與電子總數，只改電子分配。共振不是不同分子間的反應或來回切換；等價 Lewis 貢獻式的平均鍵級可用於教學畫法，但不是量子計算出的鍵級或貢獻權重。酸中的 OH 與羰基 O 不應因同為氧而自動視為等價。

閉殼層的 π 電子計數演算法不能直接用於 NO、NO2 或 O2 的開殼層電子態。若未實作並驗證開殼層分子軌域模型，可顯示核幾何、總電子數及已知自旋多重度，並停用不適用的 π 雲或孤電子對示意；不可畫出錯誤電子配置來填補缺漏。

## VSEPR 與八隅體例外

VSEPR 將每個相連原子方向算一個鍵結電子域，多重鍵仍只是一個域。電子域幾何包含孤電子對，分子幾何只描述原子排列。理想角只作分類參照；不可將水的角度套用於所有 AX2E2 分子。[OpenStax：Molecular Structure and Polarity](https://openstax.org/books/chemistry-2e/pages/7-6-molecular-structure-and-polarity)

| 結構 | 電子域／孤電子對 | 預期分子幾何 |
| --- | --- | --- |
| CO2 | AX2 | 線形 |
| BF3 | AX3 | 平面三角 |
| CH4、NH4+ | AX4 | 四面體 |
| NH3、H3O+ | AX3E | 三角錐 |
| H2O | AX2E2 | 折線 |
| PF5 | AX5 | 三角雙錐 |
| SF4 | AX4E，孤電子對在赤道 | 蹺蹺板 |
| ClF3 | AX3E2，兩孤電子對在赤道 | T 形 |
| XeF2 | AX2E3，三孤電子對在赤道 | 線形 |
| SF6 | AX6 | 八面體 |
| XeF4 | AX4E2，兩孤電子對相對 | 平面正方 |

BF3 的 B 六電子、氣相單體 BeCl2 的 Be 四電子及 NO/NO2 的奇數電子均不應被強制八隅體規則排除。金屬配位、多中心鍵和所有自由基也不能由一條「正常價數」規則涵蓋。[OpenStax：Lewis Symbols and Structures](https://openstax.org/books/chemistry-2e/pages/7-3-lewis-symbols-and-structures)

超價 Lewis 圖可作教學表示，但不得把軟體回傳的 SP3D/SP3D2 原子類型當作已證實的實際 d 軌域雜化。超價成鍵需更完整的多中心／分子軌域描述。[IUPAC：hypervalency](https://goldbook.iupac.org/terms/view/HT07054)

## 已查閱的 NIST 氣相幾何

下表數值均從 NIST CCCBDB 的 Experimental 頁讀取，單位為 Å、度。內座標與笛卡兒座標可能使用不同精度或不同結構定義；選定其中一套後必須一致。網址中的物種與電荷均須匹配，不能只按元素組成套用中性分子資料。

| 物種 | 可採用的參考 | 頁面位置與注意事項 |
| --- | --- | --- |
| [H2](https://cccbdb.nist.gov/exp2x.asp?casno=1333740&charge=0) | H–H 0.7414 | Atom–Atom Distances |
| [N2](https://cccbdb.nist.gov/exp2x.asp?casno=7727379&charge=0) | N≡N 1.0977 | Atom–Atom Distances；v1.2.2 的力場生成值為 1.460 Å |
| [Cl2](https://cccbdb.nist.gov/exp2x.asp?casno=7782505&charge=0) | Cl–Cl 1.9879 | Atom–Atom Distances |
| [HCl](https://cccbdb.nist.gov/exp2x.asp?casno=7647010&charge=0) | H–Cl 1.2746 | Atom–Atom Distances |
| [O2](https://cccbdb.nist.gov/exp2x.asp?casno=7782447&charge=0) | O–O 1.2075 | Cartesians；內座標四捨五入為 1.208；頁面基態為三重態 |
| [NO](https://cccbdb.nist.gov/exp2x.asp?casno=10102439&charge=0) | N–O 1.1508 | Cartesians；另一列 r0 為 1.154，不能宣稱二者是相同定義；基態雙重態 |
| [NO2](https://cccbdb.nist.gov/exp2x.asp?casno=10102440&charge=0) | N–O 1.193、ONO 134.1 | Internal coordinates；Cartesians 衍生距離列為 1.1934；基態雙重態、折線 |
| [SO2](https://cccbdb.nist.gov/exp2x.asp?casno=7446095&charge=0) | S–O 1.432、OSO 119.5 | Internal coordinates；兩 S–O 等價 |
| [CO](https://cccbdb.nist.gov/exp2x.asp?casno=630080&charge=0) | C–O 1.1282 | Cartesians；內座標四捨五入為 1.128 |
| [HCN](https://cccbdb.nist.gov/exp2x.asp?casno=74908&charge=0) | C–H 1.064、C–N 1.156、HCN 180 | Internal coordinates 與 Cartesians 相符 |

O2 可用 `O=O` 保留常見連接寫法，但這張 Lewis 圖不能反映其三重態與兩個未成對電子。不得將零個 RDKit 原子自由基直接當成 O2 的真實電子態；也不得為了讓圖看起來像雙自由基而捏造兩個固定局域電子位置。[OpenStax：Molecular Orbital Theory](https://openstax.org/books/chemistry-2e/pages/8-4-molecular-orbital-theory)

## 建議回歸物種

下列價電子數由上述規則計算。SMILES 是編輯表示，並不唯一決定電子態、相態、構象或實驗穩定性。

| 物種 | 編輯 SMILES | 價電子數 | 關鍵判準 |
| --- | --- | ---: | --- |
| H2O | `O` | 8 | O 兩孤電子對 |
| NH3 | `N` | 8 | N 一孤電子對 |
| CH4 | `C` | 8 | 四 C–H 單鍵 |
| CO2 | `O=C=O` | 16 | 線形、等價 C–O |
| NH4+ | `[NH4+]` | 8 | N 四單鍵、+1 |
| H3O+ | `[OH3+]` | 8 | O 三單鍵、一孤電子對、+1 |
| OH− | `[OH-]` | 8 | O 三孤電子對、−1 |
| CO | `[C-]#[O+]` | 10 | 三鍵、C −1／O +1，各一孤電子對 |
| CN− | `[C-]#N` | 10 | 三鍵、C −1 |
| NO3− | `[O-][N+](=O)[O-]` | 24 | N 八隅體、三等價端基 |
| CO3²− | `[O-]C(=O)[O-]` | 24 | 平面三角、三等價端基 |
| O3 | `[O-][O+]=O` | 18 | 折線、等價 O–O |
| SO4²− | `[O-]S(=O)(=O)[O-]` | 32 | 四面體；一張 Lewis 圖的不同形式鍵不等於固定不等價實際鍵 |
| PO4³− | `[O-]P(=O)([O-])[O-]` | 32 | 四面體；保留所用 Lewis 慣例說明 |
| BF3 | `B(F)(F)F` | 24 | 電子不足亦合法 |
| BeCl2 氣相單體 | `[Be](Cl)Cl` | 16 | 不把單體圖當作固體晶格 |
| PF5 | `P(F)(F)(F)(F)F` | 40 | 三角雙錐 |
| SF6 | `S(F)(F)(F)(F)(F)F` | 48 | 八面體 |
| SF4 | `S(F)(F)(F)F` | 34 | 一赤道孤電子對 |
| ClF3 | `Cl(F)(F)F` | 28 | 兩赤道孤電子對 |
| XeF2 | `[Xe](F)F` | 22 | 三赤道孤電子對 |
| XeF4 | `[Xe](F)(F)(F)F` | 36 | 兩相對孤電子對 |
| O2 | `O=O` | 12 | 基態三重態；連接圖不代表閉殼層 |
| NO | `[N]=O` | 11 | 一未成對電子；不可補成含氫物種 |
| NO2 | `O=[N+][O-]` | 17 | 一未成對電子；N 不超八隅體；參考折線幾何 |

每個新增支援物種須檢查 inspect、generate、graph 重建、MOL 匯入分析及重新套用模型。應驗證元素數、淨電荷、未成對電子／多重度、座標有限、鍵長及必要角度，並確認匯入不悄悄改變座標。理想模板測幾何分類即可，不能以它自己的常數作為實驗正確性的證明。

## 有機結構、離子與未支援範圍

乙烯的雙鍵附近需平面，乙炔需線形，苯為平面環且環鍵等價。雙鍵不能當作自由單鍵旋轉。乙醇 `CCO` 與二甲醚 `COC` 同為 C2H6O，因此輸入普通分子式不得靜默選擇唯一結構。[OpenStax：Hydrocarbons](https://openstax.org/books/chemistry-2e/pages/20-1-hydrocarbons)、[Alcohols and Ethers](https://openstax.org/books/chemistry-2e/pages/20-2-alcohols-and-ethers)

甲醛、乙醛、丙酮、乙酸與酯要保留羰基；羰基碳的局部排列為平面三角。乙醇的 –OH 不等於游離 OH−。[OpenStax：Aldehydes, Ketones, Carboxylic Acids, and Esters](https://openstax.org/books/chemistry-2e/pages/20-3-aldehydes-ketones-carboxylic-acids-and-esters)

NaCl、MgO、CaCl2 等通常所指的固體是延伸離子晶格，化學式表示組成比例，不能偽裝為普通孤立共價分子。若工作室仍限單一相連分子，應明示不含晶格模型，並允許已支援的多原子離子獨立研究；拒絕晶體計算不表示該鹽不符合化學。[OpenStax：Ionic Bonding](https://openstax.org/books/chemistry-2e/pages/7-1-ionic-bonding)

金屬配位、晶體堆積、反應路徑、溶劑與溫度效應、一般自由基電子結構及真實電子密度，需各自適用的方法。受控小分子參考模板不能泛化成這些功能已經完成。
