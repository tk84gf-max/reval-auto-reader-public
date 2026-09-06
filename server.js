#!/usr/bin/env node
/*
 * ReVal 自動読み取りアプリ ローカルサーバー（リク作・2026-06-16）
 *
 * マイソク(PDF/画像)をドロップ → AIが数値を1回だけ読み取り → 確認 → 即計算。
 * 計算・抽出ロジックは reval_core.js を共有（mail_watcher.js と同じエンジン）。
 *
 * 起動: ReVal自動読み取りを起動.bat をダブルクリック（または `node server.js`）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const core = require('./reval_core');

const PORT = 5178;

// 1リクエストのエラーでサーバー全体を落とさない（＝接続拒否＝再起動地獄を防ぐ）
process.on('uncaughtException', e => console.error('[uncaught]', e && e.message ? e.message : e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message ? e.message : e));

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let chunks = [], size = 0;
  req.on('data', c => { chunks.push(c); size += c.length; if (size > 35 * 1024 * 1024) req.destroy(); });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // トップページ
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (e, buf) => {
      if (e) { res.writeHead(500); return res.end('index.html not found'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' });
      res.end(buf);
    });
    return;
  }

  // 生成された物件別ReVal HTMLを表示
  if (req.method === 'GET' && url.startsWith('/analysis/')) {
    const name = decodeURIComponent(url.replace('/analysis/', ''));
    const fp = path.join(core.ANALYSIS_DIR, name);
    const rel = path.relative(core.ANALYSIS_DIR, fp);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !rel.endsWith('.html')) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(fp, (e, buf) => {
      if (e) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, no-store, must-revalidate' });
      res.end(buf);
    });
    return;
  }

  // マイソク読み取り
  if (req.method === 'POST' && url === '/extract') {
    const apiKey = core.getApiKey();
    if (!apiKey) return sendJson(res, 200, { ok: false, error: 'APIキーが見つかりません（' + core.KEY_FILE + ' に sk-ant-... を保存してください）' });
    readBody(req, raw => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 200, { ok: false, error: 'リクエストが壊れています' }); }
      core.extractFromFile(apiKey, body.mediaType, body.data)
        .then(fields => sendJson(res, 200, { ok: true, fields }))
        .catch(err => sendJson(res, 200, { ok: false, error: 'AI読み取り失敗: ' + err.message }));
    });
    return;
  }

  // 物件ページURLから読み取り（公開ページ用。楽待/健美家などログイン必須は読めない）
  if (req.method === 'POST' && url === '/extract-url') {
    const apiKey = core.getApiKey();
    if (!apiKey) return sendJson(res, 200, { ok: false, error: 'APIキーが見つかりません（' + core.KEY_FILE + '）' });
    readBody(req, raw => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 200, { ok: false, error: 'リクエストが壊れています' }); }
      if (!body.url) return sendJson(res, 200, { ok: false, error: 'URLが空です' });
      core.extractFromUrl(apiKey, body.url)
        .then(fields => {
          if (!(Number(fields.price) > 0)) return sendJson(res, 200, { ok: false, error: 'このページから物件情報を読み取れませんでした（ログイン必須サイト＝楽待/健美家等、またはJSで描画されるページの可能性）。マイソクのドロップ／スクショ貼り付けをお試しください。' });
          sendJson(res, 200, { ok: true, fields });
        })
        .catch(err => sendJson(res, 200, { ok: false, error: 'URL読み取り失敗: ' + err.message }));
    });
    return;
  }

  // 詳細資料（レントロール・コスト表など複数）から実数を抽出
  if (req.method === 'POST' && url === '/extract-detail') {
    const apiKey = core.getApiKey();
    if (!apiKey) return sendJson(res, 200, { ok: false, error: 'APIキーが見つかりません（' + core.KEY_FILE + '）' });
    readBody(req, raw => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJson(res, 200, { ok: false, error: 'リクエストが壊れています' }); }
      core.extractDetail(apiKey, body.files || [])
        .then(actuals => sendJson(res, 200, { ok: true, actuals }))
        .catch(err => sendJson(res, 200, { ok: false, error: '詳細資料の読み取り失敗: ' + err.message }));
    });
    return;
  }

  // 計算（確認後の確定値で。fields.actual があれば実数をReVal HTMLに焼き込む）
  if (req.method === 'POST' && url === '/calculate') {
    readBody(req, raw => {
      let fields;
      try { fields = JSON.parse(raw); } catch (e) { return sendJson(res, 200, { ok: false, error: 'リクエストが壊れています' }); }
      const input = core.buildInput(fields, fields.actual);
      core.runCalc(input)
        .then(({ carte, result }) =>
          core.runPrefill(input).catch(() => null).then(htmlPath => {
            const htmlUrl = htmlPath ? '/analysis/' + encodeURIComponent(path.basename(htmlPath)) : null;
            sendJson(res, 200, { ok: true, carte, result, htmlUrl });
          }))
        .catch(err => sendJson(res, 200, { ok: false, error: '計算に失敗: ' + err.message }));
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.error('⚠️ ポート' + PORT + 'は使用中です（別の窓で起動済み）。古い黒い窓を閉じてから起動し直してください。'); process.exit(1); }
  console.error('[server error]', e && e.message ? e.message : e);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = 'http://localhost:' + PORT;
  const key = core.getApiKey();
  console.log('========================================');
  console.log('  ReVal 自動読み取りアプリ 起動中');
  console.log('  ' + url);
  console.log('  APIキー: ' + (key ? '読み込みOK（' + key.slice(0, 7) + '…）' : '⚠️ 未検出 — ' + core.KEY_FILE));
  console.log('  ※このウィンドウは開いたままにしてください（閉じると停止）');
  console.log('========================================');
  if (process.env.REVAL_NOOPEN !== '1') {
    const cmd = process.platform === 'win32' ? 'start "" "' + url + '"' : process.platform === 'darwin' ? 'open "' + url + '"' : 'xdg-open "' + url + '"';
    exec(cmd, () => {});
  }
});
