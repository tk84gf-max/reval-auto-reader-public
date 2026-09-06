#!/usr/bin/env node
/*
 * 物件別 ReVal HTML 生成（bukken-hyoka スキル同梱）
 * ReVal.html テンプレートに物件の入力値を流し込み、その物件専用の1枚を出力する。
 *
 * 使い方:
 *   node prefill_reval.js input.json
 *   ・input.json は reval_calc.js と同じ形。加えて任意で:
 *       "date":"YYYYMMDD"（省略時は本日）
 *       "templatePath":"personal-realestate/tools/ReVal/ReVal.html"（省略時このパス）
 *       "outputPath":"...html"（省略時 analysis/<date>_<name>_ReVal.html）
 *   ・カレントディレクトリはプロジェクト直下（■AIカンパニー）想定。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const I = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const P = I.property || {}, L = I.loan || {}, R = I.revenue || {}, E = I.expense || {}, K = I.sekisan || {}, X = I.tax || {};

const tplPath = I.templatePath || 'ReVal.html';  // 配布版：アプリ直下のテンプレ（cwd=アプリフォルダ）
let html = fs.readFileSync(tplPath, 'utf8');

function setVal(id, v) {
  if (v === undefined || v === null || v === '') return;
  html = html.replace(new RegExp('(<input[^>]*id="' + id + '"[^>]*value=")[^"]*(")'), '$1' + v + '$2');
}
function setSelect(id, value) {
  if (!value) return;
  html = html.replace(new RegExp('(<select[^>]*id="' + id + '"[^>]*>)([\\s\\S]*?)(</select>)'), (m, a, body, c) => {
    body = body.replace(/\s+selected/g, '');
    body = body.replace(new RegExp('(<option value="' + value + '")'), '$1 selected');
    return a + body + c;
  });
}

// --- 物件 ---
setVal('propTitle', P.name || '物件名を入力');
setVal('price', P.price);
setVal('grossYield', P.grossYield);
setVal('buildAge', P.buildAge);
setVal('floorArea', P.floorArea);
setVal('rooms', P.rooms);
setVal('address', P.address);
setSelect('buildStruct', (P.struct || 'rc'));
// --- ローン ---
// 返済期間の自動算出（reval_calc.js と同じルール：残存耐用<10→10、それ以外min(残存,30)）
const _s = String(P.struct || 'rc').toLowerCase();
const _ll = _s === 'wood' ? 22 : _s === 'steel_light' ? 19 : _s === 'steel_med' ? 27 : _s === 'steel' ? 34 : 47;
const _rem = _ll - (Number(P.buildAge) || 0);
const _termAuto = _rem < 10 ? 10 : Math.min(_rem, 30);
const loanTermVal = (L.loanTerm !== undefined && L.loanTerm !== '' && L.loanTerm !== null && String(L.loanTerm).toLowerCase() !== 'auto') ? L.loanTerm : _termAuto;
setVal('ltv', L.ltv); setVal('costsRate', L.costsRate); setVal('loanTerm', loanTermVal); setVal('intRate', L.intRate);
// --- 収益 ---
setVal('effRate', R.effRate); setVal('vacancyRate', R.vacancyRate); setVal('declineRate', R.declineRate);
setVal('otherIncome', R.otherIncome); setVal('parkingUnit', R.parkingUnit); setVal('parkingCount', R.parkingCount); setVal('parkingVacancy', R.parkingVacancy);
// --- 費用 ---
setVal('mgmtRate', E.mgmtRate); setVal('bmUnit', E.bmUnit); setVal('utilUnit', E.utilUnit); setVal('buildUnit', E.buildUnit);
setVal('insurRate', E.insurRate); setVal('taxRateProp', E.taxRateProp); setVal('repairRate', E.repairRate); setVal('restoreUnit', E.restoreUnit);
setVal('turnover', E.turnover); setVal('adMonths', E.adMonths); setVal('otherCost', E.otherCost);
// --- 積算 ---
setVal('landArea', P.landArea); setVal('routePrice', K.routePrice); setVal('correction', K.correction); setVal('multiplier', K.multiplier);
setVal('landDirect', K.landDirect); setVal('buildDirect', K.buildDirect);
setSelect('deteriGrade', (K.deteriGrade || 'other'));
// --- 税金 ---
setVal('taxRate', X.taxRate); setVal('buildRatio', X.buildRatio);
// --- 実数入力（任意・レントロール/実費。Phase2でAI抽出値を焼き込む） ---
const A = I.actual || {};
setVal('actFullRent', A.fullRentAnnual); setVal('actCurRent', A.currentRentAnnual);
setVal('act_mgmt', A.mgmt); setVal('act_bm', A.bm); setVal('act_util', A.util);
setVal('act_insur', A.insur); setVal('act_tax', A.tax); setVal('act_repair', A.repair);
setVal('act_restore', A.restore); setVal('act_ad', A.ad); setVal('act_other', A.other);

// 返済方式
if ((L.repayType || 'genri') === 'gankin') {
  html = html.replace("let repayType = 'genri';", "let repayType = 'gankin';");
  html = html.replace('<button id="btn_genri" class="active"', '<button id="btn_genri"');
  html = html.replace('<button id="btn_gankin" onclick', '<button id="btn_gankin" class="active" onclick');
}

// localStorage からの復元を無効化（この物件のベイク値を必ず表示するため）
html = html.replace(/\r?\nload\(\);\r?\n/, '\n/* per-property file: load() skipped */\n');
if (/\r?\nload\(\);\r?\n/.test(html)) throw new Error('template load() was not disabled (line-ending mismatch?)');

// 出力先（物件名を先頭に。日付は _YYYY-MM-DD でCLAUDE.md命名規則に準拠）
function today() { const d = new Date(); const z = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()); }
const date = I.date || today();
const safeName = (P.name || '物件').replace(/[\\/:*?"<>|\s　]/g, '_');
const analysisDir = 'analysis';  // 配布版：アプリ直下のanalysis（cwd=アプリフォルダ）
const outPath = I.outputPath || path.join(analysisDir, `${safeName}_${date}_ReVal.html`);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html, 'utf8');
console.log('生成完了: ' + outPath);

// 分析インデックスに追記（重複検出用）。元PDFのハッシュも残す
let pdfHash = (I.sourcePdfHash || '').toLowerCase() || null, pdfFile = null;
if (I.sourcePdf) {
  pdfFile = path.basename(I.sourcePdf);
  // sourcePdfHash が無いときだけファイルから計算（Get-FileHash で渡すのが推奨）
  if (!pdfHash) { try { if (fs.existsSync(I.sourcePdf)) pdfHash = crypto.createHash('sha256').update(fs.readFileSync(I.sourcePdf)).digest('hex'); } catch (e) {} }
}
const indexPath = path.join(analysisDir, '_index.json');
let idx = []; try { idx = JSON.parse(fs.readFileSync(indexPath, 'utf8')); } catch (e) {}
const entry = { date, name: P.name || '', address: P.address || '', price: P.price || null, html: outPath, pdfFile, pdfHash };
idx = idx.filter(e => e.html !== outPath); // 同じ出力ファイルの古いエントリは置き換え（再実行で重複しない）
idx.push(entry);
fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2), 'utf8');
console.log('インデックス更新: ' + indexPath + '（計' + idx.length + '件）');
