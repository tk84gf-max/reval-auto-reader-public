#!/usr/bin/env node
/*
 * ReVal 計算エンジン（bukken-hyoka スキル同梱）
 * personal-realestate/tools/ReVal/ReVal.html の calc() を Node に移植したもの。
 * 2026-06-13 に実物件3件で IG（不動産科学研究所ツール）と全指標一致を確認済み。
 *
 * 使い方:
 *   node reval_calc.js input.json
 *   （input.json が無ければ標準入力からJSONを読む）
 *
 * 入力JSONの形（未指定の費用・収益パラメータは標準値が入る）:
 * {
 *   "property": { "name","price"(万円),"grossYield"(%),"buildAge"(年),
 *                 "struct"("wood"22|"steel_light"19|"steel_med"27|"steel"34|"rc"47|"src"47),"floorArea"(㎡),"landArea"(㎡),"rooms","address" },
 *   "loan":     { "ltv"(%),"costsRate"(%),"loanTerm"(年),"intRate"(%),"repayType"("genri"|"gankin") },
 *   "revenue":  { "effRate"(%),"vacancyRate"(%),"declineRate"(%),
 *                 "parkingUnit","parkingCount","parkingVacancy"(%),"otherIncome"(円/年) },
 *   "expense":  { "mgmtRate"(%),"bmUnit","utilUnit","buildUnit"(円/坪),"insurRate"(%),
 *                 "taxRateProp"(%),"repairRate"(%),"restoreUnit"(円/坪),"turnover"(%),"adMonths","otherCost" },
 *   "sekisan":  { "routePrice"(万円/㎡),"correction","multiplier","landDirect"(万円),"buildDirect"(万円),
 *                 "deteriGrade"("other"|"3") },
 *   "tax":      { "taxRate"(%),"buildRatio"(%) }
 * }
 *
 * 出力: 人が読む評価カルテ + 末尾に ===JSON=== 区切りで機械可読な結果オブジェクト。
 */
const fs = require('fs');
const T = 3.305785; // 1坪 = 3.305785㎡

function loadInput() {
  const p = process.argv[2];
  if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}
const I = loadInput();
const g = (o, k, def) => (o && o[k] !== undefined && o[k] !== '' && o[k] !== null ? Number(o[k]) : def);
const P = I.property || {}, L = I.loan || {}, R = I.revenue || {}, E = I.expense || {}, K = I.sekisan || {}, X = I.tax || {};
const A = I.actual || {}; // 実数（レントロール/実費）。入っている費目だけ標準計算を上書きする

// --- property ---
const name = P.name || '(物件名未設定)';
const price = g(P, 'price', 0), gy = g(P, 'grossYield', 0), age = g(P, 'buildAge', 0);
const area = g(P, 'floorArea', 0), landArea = g(P, 'landArea', 0), rooms = g(P, 'rooms', 0);
const struct = String(P.struct || 'rc').toLowerCase();
// 法定耐用年数（住宅用）: 木造22 / 軽量鉄骨3mm以下19 / 軽量鉄骨3〜4mm27 / 重量鉄骨4mm超34 / RC・SRC47
const ll = struct === 'wood' ? 22 : struct === 'steel_light' ? 19 : struct === 'steel_med' ? 27 : struct === 'steel' ? 34 : 47;
const address = P.address || '';
// --- loan ---
const ltv = g(L, 'ltv', 90), costsRate = g(L, 'costsRate', 7), intRate = g(L, 'intRate', 2.0);
const repayType = L.repayType || 'genri';
// 融資・返済期間の自動算出（作者方針 2026-06-14）：
//   残存耐用年数 = 法定耐用年数 − 築年。残存<10年 → 10年。それ以外 → min(残存, 30)。
//   loan.loanTerm が明示指定されていればそれを優先（"auto"/未指定なら自動）。
function autoLoanTerm(legal, a) { const rem = legal - a; return rem < 10 ? 10 : Math.min(rem, 30); }
const remainLifeLoan = ll - age;
const termAuto = autoLoanTerm(ll, age);
const termGiven = (L.loanTerm !== undefined && L.loanTerm !== '' && L.loanTerm !== null && String(L.loanTerm).toLowerCase() !== 'auto');
const term = termGiven ? Number(L.loanTerm) : termAuto;
// --- revenue ---
// 有効率のデフォルト：全構造80%（作者指示 2026-08-22。木造100%案は廃止）。明示指定があればそれを優先。
const eff = g(R, 'effRate', 80), vac = g(R, 'vacancyRate', 5), decline = g(R, 'declineRate', 1);
const parkingUnit = g(R, 'parkingUnit', 0), parkingCount = g(R, 'parkingCount', 0), parkingVac = g(R, 'parkingVacancy', 5), otherInc = g(R, 'otherIncome', 0);
// --- expense ---
const mgmtRate = g(E, 'mgmtRate', 5.5), bmUnit = g(E, 'bmUnit', 200), utilUnit = g(E, 'utilUnit', 50), buildUnit = g(E, 'buildUnit', 760000);
const insurRate = g(E, 'insurRate', 0.3), taxProp = g(E, 'taxRateProp', 10), repairRate = g(E, 'repairRate', 0.5), restoreUnit = g(E, 'restoreUnit', 10000);
const turnover = g(E, 'turnover', 25), adMonths = g(E, 'adMonths', 1), otherCost = g(E, 'otherCost', 0);
// --- sekisan ---
const routePrice = g(K, 'routePrice', 0), corr = g(K, 'correction', 1), mult = g(K, 'multiplier', 1);
const landDirect = g(K, 'landDirect', 0), buildDirect = g(K, 'buildDirect', 0);
const grade = K.deteriGrade || 'other';
// --- tax ---
const taxRate = g(X, 'taxRate', 20), buildRatio = g(X, 'buildRatio', 70);

// ===== 収益 =====
const priceY = price * 10000, tsubo = area / T, rentTsubo = area * eff / 100 / T;
const fullRent = g(A, 'fullRentAnnual', priceY * gy / 100);  // 満室時想定賃貸収入（実数あれば優先）
const gyEff = (g(A, 'fullRentAnnual', -1) >= 0 && priceY > 0) ? fullRent / priceY * 100 : gy; // 実効表面利回り
const effRent = fullRent * (1 - vac / 100);    // 実効賃貸収入
const vacLoss = fullRent - effRent;
const parkInc = parkingUnit * parkingCount * 12 * (1 - parkingVac / 100);
const gross = effRent + parkInc + otherInc;
// ===== 費用 =====
const buildCost = buildUnit * tsubo;           // 再調達価格（保険・修繕の基礎）
const e_mgmt = g(A, 'mgmt', effRent * mgmtRate / 100);
const e_bm = g(A, 'bm', bmUnit * tsubo * 12);
const e_util = g(A, 'util', utilUnit * tsubo * 12);
const e_insur = g(A, 'insur', buildCost * insurRate / 100);
const e_tax = g(A, 'tax', effRent * taxProp / 100);
const e_repair = g(A, 'repair', buildCost * repairRate / 100);
const e_restore = g(A, 'restore', rentTsubo * (1 - vac / 100) * restoreUnit * turnover / 100); // 賃貸可能面積基準
const e_ad = g(A, 'ad', (effRent / 12) * adMonths * (turnover / 100));
const e_other = g(A, 'other', otherCost);
const exp = e_mgmt + e_bm + e_util + e_insur + e_tax + e_repair + e_restore + e_ad + e_other;
const NOI = gross - exp;
const realYield = priceY > 0 ? NOI / priceY * 100 : 0;
// ===== ローン =====
const loanY = priceY * ltv / 100, r = intRate / 100 / 12, n = Math.max(Math.round(term * 12), 1);
let monthly, annualRepay, totalRepay, int1 = 0;
if (repayType === 'gankin') { // 元金均等
  const mp = loanY / n;
  let bal = loanY, p1 = 0;
  for (let m = 0; m < 12; m++) { int1 += bal * r; bal -= mp; p1 += mp; }
  annualRepay = p1 + int1; monthly = annualRepay / 12;
  let b2 = loanY, tot = 0;
  for (let m = 0; m < n; m++) { const i = b2 * r; let pr = mp; if (pr > b2) pr = b2; b2 -= pr; tot += pr + i; }
  totalRepay = tot;
} else { // 元利均等
  monthly = r > 0 ? loanY * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1) : loanY / n;
  annualRepay = monthly * 12; totalRepay = monthly * n;
  let bal = loanY;
  for (let m = 0; m < 12; m++) { const i = bal * r; int1 += i; bal -= (monthly - i); }
}
const equity = priceY * (1 - ltv / 100) + priceY * costsRate / 100;
const CF = NOI - annualRepay;
const CCR = equity > 0 ? CF / equity * 100 : 0;
const repayR = effRent > 0 ? annualRepay / effRent * 100 : 0;
const cfR = priceY > 0 ? CF / priceY * 100 : 0;
// ===== 積算 =====
const ikLand = landDirect > 0 ? landDirect * 10000 : landArea * routePrice * 10000 * corr * mult;
const rebuild = grade === '3' ? 240000 : 210000;
const resid = Math.max(0, 1 - age / ll);
const ikBuild = buildDirect > 0 ? buildDirect * 10000 : area * rebuild * resid;
const ikTotal = ikLand + ikBuild;
const ikRatio = priceY > 0 ? ikTotal / priceY * 100 : 0;
const routeEstimated = !(routePrice > 0) && !(landDirect > 0); // 路線価が無く積算土地が出せない
// ===== 税金 =====
const buildVal = priceY * buildRatio / 100, landVal = priceY - buildVal;
const life = age < ll ? Math.max(2, Math.floor(ll - age + age * 0.2)) : Math.max(2, Math.floor(ll * 0.2));
const dep = life > 0 ? buildVal / life : 0;
const noiAfterDep = NOI - dep;
const preTax = NOI - int1 - dep;
const taxAmt = Math.max(preTax, 0) * taxRate / 100;
const profitAfter = preTax - taxAmt;
const afterCF = CF - taxAmt;
// ===== グレード =====
const gCCR = CCR >= 20 ? 'A' : CCR >= 15 ? 'B' : CCR >= 10 ? 'C' : 'D';
const gRepay = effRent > 0 ? (repayR <= 50 ? 'A' : repayR <= 60 ? 'B' : repayR <= 65 ? 'C' : 'D') : 'D'; // 収入0(=利回り/年収不明)のとき返済比率0%がA誤判定→Dに矯正
const gCFR = cfR >= 2 ? 'A' : cfR >= 1.5 ? 'B' : cfR >= 1.0 ? 'C' : 'D';
const gIkka = ikRatio >= 100 ? 'A' : ikRatio >= 80 ? 'B' : ikRatio >= 60 ? 'C' : 'D';

// ===== 耐震基準（築年から推定）=====
// 新耐震＝1981年(昭和56年)6月1日以降の「建築確認」。判定は竣工年でなく確認日なので、
// 竣工1982〜1983年は確認日次第で旧耐震が混じるグレーゾーン。木造は2000年6月の接合部基準も注意。
const consYear = age > 0 ? new Date().getFullYear() - age : 0;
let seismic = { year: consYear, level: 'unknown', note: '' };
if (consYear > 0) {
  if (consYear <= 1981) seismic = { year: consYear, level: 'old', note: `⚠️ 旧耐震の可能性大（推定竣工${consYear}年）：新耐震は1981年6月以降の建築確認。竣工1981年以前は旧耐震の可能性が高い。耐震診断・補強の要否、融資・地震保険・出口（売りにくさ）への影響を要確認` };
  else if (consYear <= 1983) seismic = { year: consYear, level: 'gray', note: `⚠️ 新旧耐震の境目（推定竣工${consYear}年）：竣工は新しめでも建築確認が1981年5月以前なら旧耐震。建築確認日（確認申請の時期）を必ず確認` };
  else if (struct === 'wood' && consYear <= 2000) seismic = { year: consYear, level: 'wood2000', note: `△ 木造2000年基準より前（推定竣工${consYear}年）：新耐震だが2000年6月の木造接合部・耐力壁基準より前。耐震性にばらつきの可能性` };
  else seismic = { year: consYear, level: 'new', note: '' };
}

// ===== 用途（商業/テナント/店舗）の注意 =====
// 住居系前提の計算なので、商業・テナント・店舗・一棟ビル・店舗併用は別リスク。
// 物件名 / 用途(property.use=マイソク抽出) / レントロール(actual.commercialHint) から検知。過検出は許容（立ち止まらせる注意喚起）。
const useType = String(P.use || '');
const commHint = (A.commercialHint === true) || /^(true|yes|あり|含)/i.test(String(A.commercialHint || '')) || /(店舗|事務所|テナント)/.test(String(A.commercialHint || ''));
const COMM_RE = /(店舗|事務所|テナント|雑居|商業|オフィス|ビル|モール|クリニック|医療モール|居抜き|スケルトン|貸店舗|貸事務所)/;
const MIXED_RE = /(店舗併用|併用住宅|店舗付住宅|事務所付住宅)/;
const isMixed = /併用/.test(useType) || MIXED_RE.test(name);
const isComm = COMM_RE.test(useType) || COMM_RE.test(name) || commHint;
let commercial = { level: 'none', note: '' };
if (isMixed) {
  commercial = { level: 'mixed', note: '⚠️ 住居＋店舗の併用物件の可能性：店舗部分は空室の長期化・原状回復(スケルトン)・消費税課税など住居と異なるリスクがあり、全体を住居系の利回り感覚で見ると危険。店舗部分は別評価が必要なため、表示数値は目安として確認を' };
} else if (isComm) {
  commercial = { level: 'commercial', note: '⚠️ 商業・テナント系（店舗/事務所/ビル）の可能性：本ツールは住居系前提の計算です。空室の長期化・原状回復(スケルトン)が高額・融資が付きにくく期間が短い・出口が狭い・賃料は消費税課税&テナント業績依存、など住居系と異なるリスクがあり、表示数値は目安として確認を' };
}

// ===== 土地権利（借地権）の注意 =====（文言は不動産ナギ精査・2026-06-26）
// 情報がなければ所有権でデフォルト計算。借地権と確認できた場合のみ補完してアラート。定期借地は別格の強警告。
const tenure = String(P.tenure || '');
const isTeiki = /定期借地|定借|事業用借地|建物譲渡特約/.test(tenure);
const isLease = /借地|地上権/.test(tenure);
let leasehold = { isLeasehold: isLease, type: isTeiki ? 'teiki' : (isLease ? 'leasehold' : 'none'), note: '' };
if (isLease) {
  leasehold.note = '⚠️ 借地権物件：土地は借地のため地代が毎月かかり、融資・売却・建替に地主の承諾と制約が伴います。土地代がない分このツールの利回り・CFは所有権より高く出ますが、所有権物件と同じ基準で比べないでください。土地の担保評価はほぼ効かず、残存期間が出口を左右します（本ツールは所有権前提のため数値はそのまま使えません）。';
  if (isTeiki) leasehold.note += ' ⛔ さらに定期借地：契約満了で更新なし・原則更地返還。残存年数が減るほど価値と融資余地が下がり、終盤は資産価値がほぼ残りません。「残り何年か」を最優先で確認を。';
}

// ===== シナリオ別の3軸評価（CCR / 返済比率 / CF率＋グレード）=====
// ① 想定＝マイソク表面利回り＋標準費率（actualを使わない楽観前提）
// ② 満室実数・③ 現況実数＝レントロール/実費(actual)を反映した実態前提
const gC = c => c >= 20 ? 'A' : c >= 15 ? 'B' : c >= 10 ? 'C' : 'D';
const gR = c => c <= 50 ? 'A' : c <= 60 ? 'B' : c <= 65 ? 'C' : 'D';
const gF = c => c >= 2 ? 'A' : c >= 1.5 ? 'B' : c >= 1.0 ? 'C' : 'D';
const triple = (ccr, rep, cfr, hasInc) => ({ CCR: ccr, repayR: rep, cfR: cfr, gCCR: gC(ccr), gRepay: hasInc === false ? 'D' : gR(rep), gCFR: gF(cfr) }); // 収入0なら返済比率はD（0%=A誤判定の防止）
// ① マイソク純想定（actualを一切使わない：grossYield＋標準費率）
const q_fullRent = priceY * gy / 100;
const q_effRent = q_fullRent * (1 - vac / 100);
const q_exp = q_effRent * mgmtRate / 100 + bmUnit * tsubo * 12 + utilUnit * tsubo * 12 + buildCost * insurRate / 100 + q_effRent * taxProp / 100 + buildCost * repairRate / 100 + rentTsubo * (1 - vac / 100) * restoreUnit * turnover / 100 + (q_effRent / 12) * adMonths * (turnover / 100) + otherCost;
const q_NOI = q_effRent + parkInc + otherInc - q_exp;
const q_CF = q_NOI - annualRepay;
const q_CCR = equity > 0 ? q_CF / equity * 100 : 0;
const q_repayR = q_effRent > 0 ? annualRepay / q_effRent * 100 : 0;
const q_cfR = priceY > 0 ? q_CF / priceY * 100 : 0;
// ③ 現況実数（レントロール現況賃料・実費）
const hasCur = (A.currentRentAnnual !== undefined && A.currentRentAnnual !== '' && A.currentRentAnnual !== null && Number(A.currentRentAnnual) > 0);
const curRent = hasCur ? Number(A.currentRentAnnual) : 0;
const curNOI = curRent - exp, curCF = curNOI - annualRepay;
const curCCR = equity > 0 ? curCF / equity * 100 : 0;
const curRepay = curRent > 0 ? annualRepay / curRent * 100 : 0;
const curCFR = priceY > 0 ? curCF / priceY * 100 : 0;
const curY = priceY > 0 ? curRent / priceY * 100 : 0;
const hasActual = !!(A.fullRentAnnual || hasCur || A.mgmt || A.bm || A.util || A.insur || A.tax || A.repair || A.restore || A.ad || A.other);
// 3系統の3軸評価（②満室実数＝トップレベルCF/CCR…はactual反映後の満室。actual無しなら①想定と一致）
const eval3 = {
  hasActual, hasCur,
  quote: triple(q_CCR, q_repayR, q_cfR, q_effRent > 0),
  fullActual: hasActual ? triple(CCR, repayR, cfR, effRent > 0) : null,
  cur: hasCur ? triple(curCCR, curRepay, curCFR, curRent > 0) : null
};
const detail = {
  hasActual, hasCur,
  full: { CF, CCR, repayR, cfR, NOI, gy: gyEff },
  cur: hasCur ? { CF: curCF, CCR: curCCR, repayR: curRepay, cfR: curCFR, NOI: curNOI, gy: curY } : null
};

// ===== 出力 =====
const f = v => (isFinite(v) ? Math.round(v).toLocaleString('ja-JP') : '―');
const p2 = v => (isFinite(v) ? v.toFixed(2) : '―');
const L0 = [];
L0.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
L0.push(`  物件評価カルテ：${name}`);
L0.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
L0.push(`  ${address}`);
L0.push(`  価格 ${f(price)}万 / 表面${p2(gy)}% / 築${age}年 / ${({wood:'木造',steel_light:'軽量鉄骨(3mm以下)',steel_med:'軽量鉄骨(3〜4mm)',steel:'重量鉄骨',rc:'RC',src:'SRC'})[struct] || struct} / 延床${area}㎡ / ${rooms}戸`);
if (seismic.note) L0.push(`  ${seismic.note}`);
if (commercial.note) L0.push(`  ${commercial.note}`);
if (leasehold.note) L0.push(`  ${leasehold.note}`);
L0.push('');
L0.push('【 投資指標（初年） 】');
L0.push(`  年間CF        ${f(CF)} 円/年`);
L0.push(`  CCR（自己資金）  ${p2(CCR)}%  [${gCCR}]`);
L0.push(`  返済比率       ${p2(repayR)}%  [${gRepay}]`);
L0.push(`  CF率         ${p2(cfR)}%  [${gCFR}]`);
L0.push(`  実質利回り(NOI)  ${p2(realYield)}%`);
L0.push('');
L0.push('【 収益・費用 】');
L0.push(`  満室想定賃料     ${f(fullRent)} 円/年`);
L0.push(`  実効賃料       ${f(effRent)} 円/年（空室${vac}%・有効率${eff}%）`);
L0.push(`  NOI（年間純収益）  ${f(NOI)} 円/年`);
L0.push(`  支出合計       ${f(exp)} 円/年`);
L0.push('');
L0.push('【 ローン 】');
L0.push(`  借入 ${f(loanY)} 円（LTV${ltv}%）/ 自己資金 ${f(equity)} 円（諸費用${costsRate}%込）`);
L0.push(`  ${repayType === 'gankin' ? '元金均等' : '元利均等'} ${term}年 ${intRate}% → 返済 ${f(annualRepay)} 円/年（${f(monthly)} 円/月）`);
L0.push(`  ${termGiven ? '※返済期間は指定値' : `※返済期間は自動算出（残存耐用${remainLifeLoan}年→${term}年・最大30/最低10）`}`);
L0.push('');
L0.push('【 積算評価 】' + (routeEstimated ? '  ※路線価未入力→土地は未算出' : ''));
L0.push(`  土地積算       ${f(ikLand)} 円` + (routeEstimated ? '（路線価0）' : `（路線価${routePrice}万/㎡ × ${landArea}㎡）`));
L0.push(`  建物積算       ${f(ikBuild)} 円（再調達${rebuild/10000}万/㎡ × 残存${(resid*100).toFixed(1)}%）`);
L0.push(`  積算評価額      ${f(ikTotal)} 円（${f(ikTotal/10000)}万）`);
L0.push(`  積算比率       ${p2(ikRatio)}%  [${gIkka}]`);
L0.push('');
L0.push('【 税金 】');
L0.push(`  土地${f(landVal)} / 建物${f(buildVal)}（建物割合${buildRatio}%）`);
L0.push(`  償却年数 ${life}年 → 減価償却 ${f(dep)} 円/年`);
L0.push(`  税引前利益 ${f(preTax)} / 納税 ${f(taxAmt)}（税率${taxRate}%）`);
L0.push(`  税引き後CF      ${f(afterCF)} 円/年`);
L0.push('');
if (eval3.hasActual) {
  const t3 = t => `CCR ${p2(t.CCR)}%[${t.gCCR}] / 返済比率 ${p2(t.repayR)}%[${t.gRepay}] / CF率 ${p2(t.cfR)}%[${t.gCFR}]`;
  L0.push('【 3軸評価：① 想定（マイソク） vs 実態（レントロール） 】');
  L0.push(`  ① 想定（表面利回り） ${t3(eval3.quote)}`);
  if (eval3.fullActual) L0.push(`  ② 満室（実数・実費） ${t3(eval3.fullActual)}`);
  if (eval3.cur)        L0.push(`  ③ 現況（実数・実費） ${t3(eval3.cur)}`);
  L0.push('');
}
L0.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(L0.join('\n'));

const out = {
  name, address, price, gy, gyEff, age, struct, area, landArea, rooms,
  detail, eval3,
  fullRent, effRent, NOI, exp, realYield,
  loanY, equity, monthly, annualRepay, totalRepay, int1,
  CF, CCR, repayR, cfR, gCCR, gRepay, gCFR,
  ikLand, ikBuild, ikTotal, ikRatio, gIkka, routeEstimated, resid,
  buildVal, landVal, life, dep, preTax, taxAmt, profitAfter, afterCF,
  seismic, commercial, leasehold,
};
console.log('===JSON===');
console.log(JSON.stringify(out));
