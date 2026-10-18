#!/usr/bin/env node
// Optional real-Chrome UI QA. This is NOT an extension/model browser benchmark.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const [executable, output] = process.argv.slice(2);
  if (!executable || !path.isAbsolute(executable) || !output) throw new Error('Provide absolute Chrome executable and fresh QA output directory');
  if (fs.existsSync(output)) throw new Error('QA output must be fresh');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(path.resolve(output), 'chrome-profile-'));
  const webRoot = path.join(__dirname, 'dist');
  const server = http.createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(webRoot, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end('Not found'); return;
    }
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain' };
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(executable, ['--headless', '--disable-gpu', '--disable-background-networking', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let ws;
  try {
    const browserUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome startup timeout')), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Chrome exited before startup')); });
      let buffer = '';
      child.stderr.on('data', chunk => {
        buffer += chunk.toString();
        const match = buffer.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    ws = new WebSocket(browserUrl); await once(ws, 'open');
    const requests = new Map(), listeners = [], errors = [];
    let sequence = 0;
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && requests.has(message.id)) {
        const item = requests.get(message.id); requests.delete(message.id); clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
      for (const listener of [...listeners]) if (listener.method === message.method && listener.sessionId === message.sessionId) {
        listeners.splice(listeners.indexOf(listener), 1); clearTimeout(listener.timer); listener.resolve(message.params);
      }
    });
    function send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { requests.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
        requests.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
    function event(method, sessionId) {
      return new Promise((resolve, reject) => {
        const entry = { method, sessionId, resolve, timer: setTimeout(() => reject(new Error(`Event timeout: ${method}`)), 15000) };
        listeners.push(entry);
      });
    }
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
    const loaded = event('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, sessionId); await loaded;
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error('UI assertion failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
      return result.result.value;
    };
    const checks = await evaluate(`(async () => {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      assert(document.getElementById('error').hidden, 'Initialisation failure');
      const data = globalThis.LLSS_EVIDENCE;
      let views = 0;
      const set = (id, value) => { const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('change')); };
      for (const group of data.groups) {
        set('cohort-select', group.id);
        for (const op of new Set(group.rows.map(row => row.operating))) {
          set('operating-select', op);
          assert(document.querySelectorAll('#scores tbody tr').length === group.rows.filter(row=>row.operating===op).length, 'Missing candidate rows');
          for (const row of group.rows.filter(row=>row.operating===op)) {
            set('candidate-select', row.id);
            assert(document.querySelectorAll('#label-table tbody tr').length===44, 'Incomplete label inventory');
            assert(document.getElementById('candidate-audit').textContent.includes(row.pointer), 'Missing source pointer');
          }
          views++;
        }
      }
      set('cohort-select','compact-capacity-test');
      assert(document.getElementById('operating-select').value==='primary','Default must not cherry-pick diagnostics');
      assert(document.getElementById('scores').textContent.includes('0.000%'),'Zero recall hidden');
      set('operating-select','diagnostic');
      assert(document.getElementById('scores').textContent.includes('60.188%'),'Diagnostic value mismatch');
      let csv;
      const originalURL = URL.createObjectURL, originalClick=HTMLAnchorElement.prototype.click;
      URL.createObjectURL=blob=>{csv=blob;return 'blob:qa';}; HTMLAnchorElement.prototype.click=function(){};
      document.getElementById('export-csv').click();
      URL.createObjectURL=originalURL; HTMLAnchorElement.prototype.click=originalClick;
      assert((await csv.text()).includes('dataset_sha256'),'CSV lacks provenance');
      document.querySelector('[data-panel="runtime"]').click();
      assert(document.querySelectorAll('#runtime-table tbody tr').length===9,'Runtime repetitions omitted');
      document.querySelector('[data-panel="methods"]').click();
      assert(document.querySelectorAll('#catalog-table tbody tr').length===20,'Catalog entries omitted');
      document.getElementById('verify-sources').click();
      await new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(!document.getElementById('verify-sources').disabled)return resolve();if(Date.now()-start>8000)return reject(new Error('Source verification timeout'));setTimeout(poll,30)};poll()});
      assert(document.getElementById('source-verification').textContent.includes('match their recorded hashes'),'Source verification failed');
      document.querySelector('[data-panel="detection"]').click();
      window.scrollTo(0,0);
      return {views, sources:data.sources.length, catalog:20, label_rows:44, default_primary:true, csv_provenance:true, source_hashes_verified:true};
    })()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1150, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate('window.scrollTo(0,0); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const desktop = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(output, 'desktop.png'), Buffer.from(desktop.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
    const mobile = await evaluate(`(async()=>{window.scrollTo(0,0);await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {width:innerWidth,document_width:document.documentElement.scrollWidth}})()`);
    if (mobile.document_width > mobile.width + 1) throw new Error('Page-level horizontal overflow on mobile');
    const screenshot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(output, 'mobile.png'), Buffer.from(screenshot.data, 'base64'));
    if (errors.length) throw new Error('Browser runtime exceptions: ' + errors.join('; '));
    const version = await send('Browser.getVersion');
    const report = { scope: 'Dashboard UI QA only, not extension/model browser qualification', release_eligible: false,
      browser: version.product, checks, mobile, runtime_exceptions: errors };
    fs.writeFileSync(path.join(output, 'qa.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    await send('Browser.close');
  } finally {
    if (ws) ws.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
