/*
 * ReVal 共通コア（リク作・2026-06-16）
 * Vision抽出 → 入力組み立て → 計算/HTML生成 を提供。
 * interactiveアプリ(server.js)とメール監視(mail_watcher.js)の両方から使う（エンジン二重実装の防止）。
 *
 * ★抽出元は「渡された資料（PDF/画像/本文テキスト）」だけ。Webの全文取得はしない（暴走防止）。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

// 配布版＝自己完結（このフォルダ内で完結。dev版の相対パスにしない）
const PROJECT_ROOT = __dirname;
const SCRIPTS = path.join(__dirname, 'scripts');
const ANALYSIS_DIR = path.join(__dirname, 'analysis');
const KEY_FILE = path.join(os.homedir(), '.config', 'reval', 'apikey.txt');
const MODEL = 'claude-sonnet-4-6';

function getApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) { return null; }
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const EXTRACT_PROMPT = `あなたは日本の不動産マイソク（販売図面・物件概要書）から数値を抽出する専門家です。
与えられた資料（PDF・画像・メール本文）だけを根拠に、下のJSONを返してください。資料に無い項目は null。推測で勝手に埋めない。

本日は __TODAY__ です。築年数(buildAge)は築年月から本日基準の年差（本年−築年）で数えてください。

返すJSON（この形・キーだけ。前後に説明文やコードフェンス\`\`\`を付けない）:
{
 "name": "物件名",
 "address": "住所",
 "price": 価格を万円単位の数値,
 "grossYield": 表面利回りを%の数値,
 "annualIncome": 満室想定年収を円の数値 または null,
 "buildAge": 築年数の数値,
 "buildYM": "築年月の原文（例: 平成7年3月）",
 "struct": "wood / steel_light / steel_med / steel / rc / src のいずれか",
 "floorArea": 延床面積を㎡の数値,
 "landArea": 土地面積を㎡の数値 または null,
 "rooms": 戸数の数値,
 "routePrice": 路線価を万円/㎡の数値 または null,
 "useType": "用途を次から1つ: 住居 / 店舗 / 事務所 / テナントビル / 雑居ビル / 店舗併用住宅 / その他（物件名・用途地域・現況・各区画の業種から判断。材料が無ければ 住居）",
 "tenure": "土地権利。所有権 / 借地権 / 定期借地権 のいずれか。「定期借地・一般定期借地・事業用借地・建物譲渡特約・◯年で更地返還(更新なし)」→定期借地権、それ以外の「借地・旧法/新法借地・地上権」→借地権、記載なし・所有権→所有権",
 "lowConfidence": ["自信が無い項目名の配列"],
 "notes": "補足（読み取れなかった点など）"
}

ルール:
- price は万円。例: 1億4300万円→14300、9800万円→9800。
- grossYield が資料に無く annualIncome が分かるなら null のままでよい（後でこちらが計算する）。
- struct: 木造→wood。軽量鉄骨(肉厚3mm以下)→steel_light、軽量鉄骨(3〜4mm)→steel_med、重量鉄骨(4mm超)→steel。鉄骨と分かるが肉厚不明なら steel(重量) を既定にし lowConfidence に "struct" を入れる。鉄筋コンクリート/RC→rc、鉄骨鉄筋コンクリート/SRC→src。
- 面積は延床(floorArea)と土地(landArea)を取り違えない。
- useType: 物件名に「ビル/テナント/店舗/事務所/雑居/オフィス」等、または現況/用途地域が店舗・事務所系なら商業系。1階店舗＋上階住居は「店舗併用住宅」。判断できなければ「住居」。
- tenure: 「定期借地/一般定期借地/事業用借地/建物譲渡特約/更新なし更地返還」→定期借地権。その他「借地/旧法/新法借地/地上権」→借地権。記載がなければ 所有権。
- 物件情報が見当たらない資料なら全項目nullにし、notesに「物件情報なし」と書く。`;

// content: [{type:'document'|'image'|'text', ...}] を受けてAnthropicを呼ぶ
function callAnthropic(apiKey, blocks) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: 'user', content: blocks }] });
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) return reject(new Error(j.error.message || 'API error'));
          resolve((j.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
        } catch (e) { reject(new Error('APIの応答を解釈できませんでした: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJsonLoose(text) {
  let t = String(text).trim();
  t = t.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e >= 0) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

function fileBlock(mediaType, dataB64) {
  return mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataB64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataB64 } };
}

// 添付ファイル（PDF/画像）から抽出
async function extractFromFile(apiKey, mediaType, dataB64) {
  const text = await callAnthropic(apiKey, [fileBlock(mediaType, dataB64), { type: 'text', text: EXTRACT_PROMPT.replace('__TODAY__', todayStr()) }]);
  return normalizeFields(parseJsonLoose(text));
}
// メール本文テキストから抽出
async function extractFromText(apiKey, bodyText) {
  const prompt = EXTRACT_PROMPT.replace('__TODAY__', todayStr()) + '\n\n--- 資料（メール本文）---\n' + String(bodyText).slice(0, 8000);
  const text = await callAnthropic(apiKey, [{ type: 'text', text: prompt }]);
  return normalizeFields(parseJsonLoose(text));
}

// 物件ページURLから抽出（公開ページ用。ログイン必須サイトは本文が取れず失敗する）
async function extractFromUrl(apiKey, url) {
  const pageText = await fetchUrlText(url);   // ページ取得→本文化→12000字に切る（生ダンプしない）
  if (!pageText || pageText.replace(/\s/g, '').length < 80) throw new Error('ページ本文が取得できませんでした（ログイン必須・取得拒否・空ページの可能性）');
  return extractFromText(apiKey, pageText);
}

function normalizeFields(f) {
  if (!(Number(f.grossYield) > 0) && Number(f.annualIncome) > 0 && Number(f.price) > 0) {
    f.grossYield = +(Number(f.annualIncome) / (Number(f.price) * 10000) * 100).toFixed(2);
  }
  return f;
}

// レントロール・ランニングコスト表など「詳細資料（複数）」から実数を抽出
const DETAIL_PROMPT = `あなたは不動産のレントロール・ランニングコスト表・収支資料から「実数」を抽出する専門家です。
与えられた資料（複数可）だけを根拠に、年額（円/年）で下のJSONを返してください。資料に無い項目は null。月額しか無ければ×12して年額に直す。

返すJSON（この形・キーだけ。前後に説明文やコードフェンス\`\`\`を付けない）:
{
 "fullRentAnnual": 満室時の年間賃料合計（円/年）,
 "currentRentAnnual": 現況（実際の稼働）の年間賃料合計（円/年）,
 "mgmt": 賃貸管理費（円/年）,
 "bm": 建物管理費（円/年）,
 "util": 共用部の水道光熱費（円/年。各戸テナント直契約でオーナー負担なしなら0）,
 "insur": 損害保険料（円/年。複数保険は合算）,
 "tax": 公租公課＝固定資産税＋都市計画税（円/年）,
 "repair": 修繕費（円/年。実績や想定）,
 "restore": 原状回復費（円/年）,
 "ad": 募集経費（円/年）,
 "other": その他費用（円/年。障害対応料など上記に当てはまらない継続費）,
 "commercialHint": "店舗・事務所・テナント等の非住居区画が含まれるなら true、住居のみなら false（区画名の業種・賃借人の法人名/屋号・賃料の税別/＋消費税表記・敷金/保証金が極端に厚い 等から判断）",
 "notes": "補足（満室/現況の根拠、月額→年額換算した点、判断に迷った点）"
}

ルール:
- レントロールの「満室時年額/満室時年間収入」→ fullRentAnnual、「現況年額/現状年間収入」→ currentRentAnnual。
- 「家賃の○%」など率しか無い管理費は、現況賃料×率で年額換算してよい（notesに明記）。
- 年1回の保険料はそのまま年額。月額固定費は×12。資料に無い費目は推測せず null。`;

async function extractDetail(apiKey, files) {
  const blocks = (files || []).map(f => fileBlock(f.mediaType, f.data));
  blocks.push({ type: 'text', text: DETAIL_PROMPT });
  const text = await callAnthropic(apiKey, blocks);
  return parseJsonLoose(text);
}

function buildInput(f, actual) {
  let gy = Number(f.grossYield);
  if (!(gy > 0) && Number(f.annualIncome) > 0 && Number(f.price) > 0) gy = +(Number(f.annualIncome) / (Number(f.price) * 10000) * 100).toFixed(2);
  const input = {
    property: { name: f.name || '物件', price: f.price, grossYield: gy, buildAge: f.buildAge, struct: f.struct || 'rc', floorArea: f.floorArea, landArea: f.landArea, rooms: f.rooms, address: f.address || '', use: f.useType || '', tenure: f.tenure || '所有権' },
    loan: { ltv: 90, costsRate: 7, loanTerm: 'auto', intRate: 2.0, repayType: 'genri' },
    revenue: { effRate: 80, vacancyRate: 5, declineRate: 1 }, // 有効率は全構造80%（作者指示 2026-08-22。木造100%案は廃止）
    expense: { mgmtRate: 5.5 },
    sekisan: { routePrice: f.routePrice || 0, deteriGrade: 'other' },
    tax: { taxRate: 20, buildRatio: 70 }
  };
  if (actual && typeof actual === 'object') input.actual = actual; // 実数（レントロール/実費）をReVal HTMLに焼き込む用
  return input;
}

function runNode(script, inputObj) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'reval_' + path.basename(script, '.js') + '_' + process.pid + '_' + Date.now() + '.json');
    fs.writeFileSync(tmp, JSON.stringify(inputObj), 'utf8');
    execFile('node', [path.join(SCRIPTS, script), tmp], { cwd: PROJECT_ROOT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (err) return reject(new Error((stderr || err.message || '').toString()));
      resolve(String(stdout));
    });
  });
}

async function runCalc(input) {
  const stdout = await runNode('reval_calc.js', input);
  const carte = stdout.split('===JSON===')[0].trim();
  let result = null;
  try { result = JSON.parse(stdout.split('===JSON===')[1].trim()); } catch (e) {}
  return { carte, result };
}
async function runPrefill(input) {
  const out = await runNode('prefill_reval.js', input);
  const m = String(out).match(/生成完了:\s*(.+)/);
  return m ? m[1].trim() : null;
}

// HTML → 本文テキスト化（タグ/スクリプト除去・空白圧縮）
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]*\n+/g, '\n').trim();
}

// リンク先を取得して bounded text を返す（★生ダンプ防止：上限文字数で切る。会話には渡さない）
// 取得失敗・非200・リダイレクト過多・タイムアウトは reject（呼び出し側で「次へ」）。
function fetchUrlText(url, maxChars = 12000, redirects = 4) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error('リダイレクト過多'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('不正URL')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: 'GET',
      // 実ブラウザに近いヘッダー（最小だとWAFに405で弾かれるサイトがある＝アットホーム等）
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'identity',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1'
      }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchUrlText(next, maxChars, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '', size = 0;
      res.on('data', c => { size += c.length; if (size < 4 * 1024 * 1024) data += c.toString('utf8'); });
      res.on('end', () => resolve(htmlToText(data).slice(0, maxChars)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('タイムアウト')));
    req.end();
  });
}

// 通知基準（作者指定・2026-06-19）：ReValの分析結果のみで判定する。
//   3軸の格付け（CCR / 返済比率 / CF率）を A=4 B=3 C=2 D=1 で得点化し、
//   合計（3〜12点）が PASS_LINE 点以上なら通過＝通知。
//   ※以前の5点足切り基準（価格≤1億・表面≥7.1%・積算≥60% 等）は廃止（使わない）。
//   ※格付けの閾値は reval_calc.js の gCCR / gRepay / gCFR の定義に従う。
const GRADE_SCORE = { A: 4, B: 3, C: 2, D: 1 };
const PASS_LINE = 6;
function captainFilter(result) {
  if (!result) return { pass: false, checks: {}, score: 0, passLine: PASS_LINE, reason: '計算不可' };
  const sc = g => (GRADE_SCORE[g] || 0);
  const checks = {
    ccr:   { label: 'CCR',    grade: result.gCCR,   score: sc(result.gCCR),   val: (result.CCR || 0).toFixed(1) + '%' },
    repay: { label: '返済比率', grade: result.gRepay, score: sc(result.gRepay), val: (result.repayR || 0).toFixed(1) + '%' },
    cfr:   { label: 'CF率',    grade: result.gCFR,   score: sc(result.gCFR),   val: (result.cfR || 0).toFixed(2) + '%' }
  };
  const score = checks.ccr.score + checks.repay.score + checks.cfr.score;
  return { pass: score >= PASS_LINE, score, passLine: PASS_LINE, checks };
}

module.exports = {
  PROJECT_ROOT, SCRIPTS, ANALYSIS_DIR, KEY_FILE, MODEL,
  getApiKey, todayStr, extractFromFile, extractFromText, extractFromUrl, extractDetail,
  buildInput, runCalc, runPrefill, captainFilter,
  fetchUrlText, htmlToText
};
