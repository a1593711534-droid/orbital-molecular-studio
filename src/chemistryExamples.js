// These are explicit structures, not an ambiguous formula-to-structure parser.
// Charges and hydrogens in bracket atoms are intentional Lewis bookkeeping.
export const CHEMISTRY_EXAMPLES = [
  {group:'常見分子',name:'水',formula:'H₂O',smiles:'O'},
  {group:'常見分子',name:'氨',formula:'NH₃',smiles:'N'},
  {group:'常見分子',name:'甲烷',formula:'CH₄',smiles:'C'},
  {group:'常見分子',name:'氫氣',formula:'H₂',smiles:'[H][H]'},
  {group:'常見分子',name:'氮氣',formula:'N₂',smiles:'N#N'},
  {group:'常見分子',name:'氧氣',formula:'O₂',smiles:'O=O',note:'基態為三重態，具有兩個未成對電子；雙鍵 Lewis 圖無法完整描述其電子結構。'},
  {group:'常見分子',name:'一氧化氮',formula:'NO',smiles:'[N]=O',note:'奇電子分子，具有一個未成對電子；使用氣相參考幾何。'},
  {group:'常見分子',name:'二氧化氮',formula:'NO₂',smiles:'O=[N+][O-]',note:'奇電子分子，具有一個未成對電子；單一 Lewis 式不代表兩條 N–O 鍵不等價。'},
  {group:'常見分子',name:'氯氣',formula:'Cl₂',smiles:'ClCl'},
  {group:'常見分子',name:'氯化氫',formula:'HCl',smiles:'Cl'},
  {group:'常見分子',name:'二氧化碳',formula:'CO₂',smiles:'O=C=O'},
  {group:'常見分子',name:'一氧化碳',formula:'CO',smiles:'[C-]#[O+]',note:'此 Lewis 式中 C 為 −1、O 為 +1；形式電荷不是實際部分電荷。'},
  {group:'常見分子',name:'臭氧',formula:'O₃',smiles:'O=[O+][O-]',note:'顯示一個 Lewis 共振式；兩個 O–O 鍵在共振混成體中等價。'},
  {group:'常見分子',name:'過氧化氫',formula:'H₂O₂',smiles:'OO'},
  {group:'常見分子',name:'二氧化硫',formula:'SO₂',smiles:'O=S=O'},
  {group:'常見分子',name:'三氧化硫',formula:'SO₃',smiles:'O=S(=O)=O'},
  {group:'常見分子',name:'硫酸',formula:'H₂SO₄',smiles:'OS(=O)(=O)O'},
  {group:'常見分子',name:'硝酸',formula:'HNO₃',smiles:'O[N+](=O)[O-]'},
  {group:'常見分子',name:'磷酸',formula:'H₃PO₄',smiles:'OP(=O)(O)O'},
  {group:'離子',name:'銨離子',formula:'NH₄⁺',smiles:'[NH4+]'},
  {group:'離子',name:'水合氫離子',formula:'H₃O⁺',smiles:'[OH3+]'},
  {group:'離子',name:'氫氧根',formula:'OH⁻',smiles:'[OH-]'},
  {group:'離子',name:'氰根',formula:'CN⁻',smiles:'[C-]#N'},
  {group:'離子',name:'硝酸根',formula:'NO₃⁻',smiles:'[O-][N+](=O)[O-]',note:'一個雙鍵、兩個單鍵是單一 Lewis 式；三個 N–O 鍵等價。'},
  {group:'離子',name:'碳酸根',formula:'CO₃²⁻',smiles:'[O-]C(=O)[O-]',note:'三個 C–O 鍵等價；Lewis 式不表示雙鍵固定在某一個氧上。'},
  {group:'離子',name:'碳酸氫根',formula:'HCO₃⁻',smiles:'OC(=O)[O-]'},
  {group:'離子',name:'硫酸根',formula:'SO₄²⁻',smiles:'[O-]S(=O)(=O)[O-]',note:'使用一個擴展八隅體 Lewis 式；四個 S–O 鍵等價。'},
  {group:'離子',name:'磷酸根',formula:'PO₄³⁻',smiles:'[O-]P(=O)([O-])[O-]',note:'使用一個擴展八隅體 Lewis 式；四個 P–O 鍵等價。'},
  {group:'離子',name:'鈉離子',formula:'Na⁺',smiles:'[Na+]',note:'單一離子；不代表食鹽晶格或溶液中的水合結構。'},
  {group:'離子',name:'氯離子',formula:'Cl⁻',smiles:'[Cl-]'},
  {group:'離子',name:'鎂離子',formula:'Mg²⁺',smiles:'[Mg+2]'},
  {group:'離子',name:'鈣離子',formula:'Ca²⁺',smiles:'[Ca+2]'},
  {group:'離子',name:'鋁離子',formula:'Al³⁺',smiles:'[Al+3]'},
  {group:'VSEPR 與八隅體例外',name:'三氟化硼',formula:'BF₃',smiles:'FB(F)F',note:'缺電子分子：B 周圍為 6 個價層電子，平面三角形。'},
  {group:'VSEPR 與八隅體例外',name:'氣相氯化鈹單體',formula:'BeCl₂',smiles:'Cl[Be]Cl',note:'此處是氣相單體；固態 BeCl₂ 不能以孤立線形分子代表。'},
  {group:'VSEPR 與八隅體例外',name:'五氟化磷',formula:'PF₅',smiles:'FP(F)(F)(F)F'},
  {group:'VSEPR 與八隅體例外',name:'氣相五氯化磷',formula:'PCl₅',smiles:'ClP(Cl)(Cl)(Cl)Cl',note:'此處是氣相分子；固態通常為 [PCl₄]⁺[PCl₆]⁻ 離子晶格。'},
  {group:'VSEPR 與八隅體例外',name:'四氟化硫',formula:'SF₄',smiles:'FS(F)(F)F'},
  {group:'VSEPR 與八隅體例外',name:'六氟化硫',formula:'SF₆',smiles:'FS(F)(F)(F)(F)F'},
  {group:'VSEPR 與八隅體例外',name:'三氟化氯',formula:'ClF₃',smiles:'FCl(F)F'},
  {group:'VSEPR 與八隅體例外',name:'二氟化氙',formula:'XeF₂',smiles:'F[Xe]F'},
  {group:'VSEPR 與八隅體例外',name:'四氟化氙',formula:'XeF₄',smiles:'F[Xe](F)(F)F'},
  {group:'有機結構',name:'乙烯',formula:'C₂H₄',smiles:'C=C'},
  {group:'有機結構',name:'乙炔',formula:'C₂H₂',smiles:'C#C'},
  {group:'有機結構',name:'乙醇',formula:'C₂H₆O',smiles:'CCO'},
  {group:'有機結構',name:'二甲醚',formula:'C₂H₆O',smiles:'COC',note:'與乙醇分子式相同，連接方式不同；分子式無法唯一指定結構。'},
  {group:'有機結構',name:'乙酸',formula:'CH₃COOH',smiles:'CC(=O)O'},
  {group:'有機結構',name:'乙酸根',formula:'CH₃COO⁻',smiles:'CC(=O)[O-]'},
  {group:'有機結構',name:'苯',formula:'C₆H₆',smiles:'c1ccccc1'},
  {group:'有機結構',name:'環己烷',formula:'C₆H₁₂',smiles:'C1CCCCC1'},
  {group:'有機結構',name:'順-2-丁烯',formula:'C₄H₈',smiles:'C/C=C\\C'},
  {group:'有機結構',name:'反-2-丁烯',formula:'C₄H₈',smiles:'C/C=C/C'},
];

export const ELEMENTS = [
  ['C','碳','#364352'],['N','氮','#2357b5'],['O','氧','#b93236'],['H','氫','#526677'],
  ['S','硫','#816000'],['Cl','氯','#246a3f'],['P','磷','#9c4c16'],['F','氟','#23774f'],
  ['Br','溴','#934337'],['I','碘','#65449b'],['B','硼','#8b4e37'],['Si','矽','#636344'],
  ['Be','鈹','#56723c'],['Xe','氙','#42758b'],['Na','鈉','#705ca4'],['K','鉀','#705ca4'],
  ['Mg','鎂','#56723c'],['Ca','鈣','#56723c'],['Al','鋁','#666d7b'],
];

export const ION_CHARGES = {Na:1,K:1,Mg:2,Ca:2,Al:3};
export function elementInput(symbol) {
  if (ION_CHARGES[symbol]) return `[${symbol}+${ION_CHARGES[symbol] === 1 ? '' : ION_CHARGES[symbol]}]`;
  return ['H','Be','Si','Xe'].includes(symbol) ? `[${symbol}]` : symbol;
}

export function hybridizationLabel(atom) {
  const value = atom?.hybridization;
  const label = {SP:'sp',SP2:'sp²',SP3:'sp³'}[value];
  return label ? `${label} · 局域模型` : '未指定雜化';
}

function normalizeSearch(value) {
  const digits = {'₀':'0','₁':'1','₂':'2','₃':'3','₄':'4','₅':'5','₆':'6','₇':'7','₈':'8','₉':'9','⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁺':'+','⁻':'-','−':'-'};
  return String(value).replace(/[₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻−]/g, char=>digits[char]).replace(/[\s^]/g,'').toLowerCase();
}
export function exampleMatches(example, query) {
  const normalized = normalizeSearch(query);
  return !normalized || [example.name,example.formula,example.smiles].some(value=>normalizeSearch(value).includes(normalized));
}
