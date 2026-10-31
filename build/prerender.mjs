#!/usr/bin/env node
// Give crawlers the finished page for hand-edited pages that draw their content
// with JavaScript (the design tool's <x-dc> templates with {{ }} and <sc-for>).
//
//   node build/prerender.mjs page.html:static other.html:overlay ...
//
// static   The page has no interactivity. Render it, drop the runtime, overwrite
//          the file with plain HTML.
// overlay  The page is interactive. Render it, then put the finished markup at the
//          top of <body> inside #__prerender. Crawlers read that. In a browser the
//          runtime draws #dc-root as before and a three-line script removes the copy.
//
// Runs in the deploy workflow, on the runner's checkout, just before upload. The
// repo keeps the editable template; only the uploaded file is rendered.
// Copies of this file live in atma.blog, viceandvariance.com and
// tech.atma.marketing; keep them identical.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const ROOT = process.cwd();
const CHROME = process.env.CHROME_PATH
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.json': 'application/json' };

const REMOVE_COPY = `<script>(function(){var c=document.getElementById('__prerender');if(!c)return;var o=new MutationObserver(function(){var r=document.getElementById('dc-root');if(r&&r.children.length){c.remove();o.disconnect();}});o.observe(document.documentElement,{childList:true,subtree:true});})();</script>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  const jobs = process.argv.slice(2).map((a) => { const [file, mode = 'static'] = a.split(':'); return { file, mode }; });
  if (!jobs.length || jobs.some((j) => !['static', 'overlay'].includes(j.mode))) {
    console.error('usage: prerender.mjs page.html[:static|:overlay] ...');
    process.exit(2);
  }
  const srv = await serve();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const failures = [];
  for (const { file, mode } of jobs) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.goto(`http://127.0.0.1:${srv.address().port}/${encodeURIComponent(file)}`, { waitUntil: 'load' });
    try {
      await page.waitForFunction(() => {
        const r = document.getElementById('dc-root');
        return r && r.innerText.trim().length > 0 && !r.innerText.includes('{{');
      }, null, { timeout: 30000 });
      await page.waitForTimeout(300);
    } catch {
      failures.push(file);
      await page.close();
      continue;
    }
    const original = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let out;
    if (mode === 'static') {
      out = await page.evaluate(() => {
        document.querySelectorAll('script:not([type="application/ld+json"]), template, helmet, x-dc').forEach((n) => n.remove());
        // The runtime copies <helmet>'s <title> into <head>; keep the first, which is the page's real one.
        document.querySelectorAll('head title:not(:first-of-type)').forEach((n) => n.remove());
        return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      });
    } else {
      const copy = await page.evaluate(() => {
        const styles = [...document.head.querySelectorAll('style')].map((s) => s.outerHTML).join('\n');
        return `<div id="__prerender">${styles}\n${document.getElementById('dc-root').innerHTML}</div>`;
      });
      out = original.replace(/<body([^>]*)>/i, (m) => `${m}\n${copy}\n${REMOVE_COPY}`);
    }
    fs.writeFileSync(path.join(ROOT, file), out);
    const words = out.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    console.log(`${file} (${mode}): ${words} words readable without JavaScript`);
    await page.close();
  }
  await browser.close();
  srv.close();
  if (failures.length) {
    console.error('Did not render: ' + failures.join(', '));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
