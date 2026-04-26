import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  ActivityType,
} from 'discord.js';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── ENV ──────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const ADMIN_IDS         = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── PYTHON BINARY ────────────────────────────────────────────────────────────
const PYTHON_BIN = (() => {
  const candidates = [
    path.join(__dirname, 'venv', 'bin', 'python3'),
    path.join(__dirname, 'venv', 'bin', 'python'),
    'python3',
    'python',
  ];
  for (const p of candidates) {
    if (p.startsWith('/') || p.startsWith('.')) {
      if (fs.existsSync(p)) return p;
    } else {
      return p;
    }
  }
  return 'python3';
})();

// ─── IN-MEMORY QUEUE ─────────────────────────────────────────────────────────
const cookieQueue = [];

const countCookies = () => cookieQueue.length;
const popCookie    = () => cookieQueue.length ? cookieQueue.shift() : null;
const pushCookies  = (blocks) => { cookieQueue.push(...blocks); return blocks.length; };
const clearCookies = () => { const n = cookieQueue.length; cookieQueue.length = 0; return n; };

// ─── AUTO-REFILL ──────────────────────────────────────────────────────────────
let isRefilling = false;

async function autoRefill() {
  if (isRefilling) return { added: 0, error: 'Đang nạp, vui lòng chờ...' };
  isRefilling = true;
  try {
    console.log('[autoRefill] Queue rỗng — tự động scrape shrestha.live...');
    const { blocks, error } = await scrapeShrestha(null);
    if (error && !blocks.length) return { added: 0, error };
    if (!blocks.length) return { added: 0, error: 'Trang không có cookie hợp lệ.' };
    const added = pushCookies(blocks);
    console.log(`[autoRefill] Nạp thêm ${added} cookie.`);
    return { added };
  } catch (err) {
    console.error('[autoRefill]', err);
    return { added: 0, error: err.message };
  } finally {
    isRefilling = false;
  }
}

// ─── PARSER ───────────────────────────────────────────────────────────────────
/**
 * Kiểm tra 1 block Netscape có phải cookie Netflix hợp lệ không.
 * Chấp nhận cả format có và không có NetflixId/SecureNetflixId.
 * Yêu cầu tối thiểu: >= 2 dòng .netflix.com dạng tab-separated (7 cột).
 */
function isValidNetflixBlock(block) {
  if (!block) return false;
  const lines = block.split(/\r?\n/).filter(l => {
    const t = l.trim();
    return (t.startsWith('.netflix.com') || t.startsWith('netflix.com')) && t.split(/\t/).length >= 6;
  });
  return lines.length >= 2;
}

/**
 * Kiểm tra nhanh — có nhắc tới netflix.com và ít nhất 1 dòng tab-separated.
 */
function looksLikeNetflixData(text) {
  return text.includes('netflix.com') && (
    /NetflixId/i.test(text) ||
    /SecureNetflixId/i.test(text) ||
    /nfvdid/i.test(text) ||
    /memclid/i.test(text) ||
    /\bNetflixId\b/i.test(text) ||
    // Netscape tab format: domain \t TRUE/FALSE \t path \t ...
    /\.netflix\.com\t(TRUE|FALSE)\t/i.test(text) ||
    // JSON format với domain netflix
    /"domain"\s*:\s*"\.?netflix\.com"/i.test(text)
  );
}

/**
 * Parse raw text → mảng cookie blocks (Netscape format).
 */
function parseCookieFileIntoBlocks(rawText) {
  // ── Thử JSON array trước ──────────────────────────────────────────────────
  const jsonBlocks = tryParseJSONBlocks(rawText);
  if (jsonBlocks.length) return jsonBlocks;

  // ── Netscape tab-separated ────────────────────────────────────────────────
  const blocks = [];
  const lines  = rawText.split(/\r?\n/);
  let cur = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('.netflix.com') || t.startsWith('netflix.com')) {
      cur.push(line);
    } else {
      if (cur.length >= 2) {
        const block = cur.join('\n');
        if (isValidNetflixBlock(block)) blocks.push(block);
      } else if (cur.length > 0) {
        // Có thể block đang tiếp tục ở dòng tiếp theo → giữ lại
        // nếu dòng hiện tại là comment/blank thì reset
        if (!t || t.startsWith('#') || t.startsWith('//')) {
          cur = [];
        }
        // ngược lại không reset — đây là dòng lạ giữa chừng
      }
      // Dòng hoàn toàn không phải netflix.com → reset
      if (!t.startsWith('.netflix.com') && !t.startsWith('netflix.com')) {
        if (cur.length >= 2) {
          const block = cur.join('\n');
          if (isValidNetflixBlock(block)) blocks.push(block);
        }
        cur = [];
      }
    }
  }
  if (cur.length >= 2) {
    const block = cur.join('\n');
    if (isValidNetflixBlock(block)) blocks.push(block);
  }
  return blocks;
}

/**
 * Thử parse JSON cookie array (EditThisCookie / ExportThisCookie format).
 * Mỗi object là 1 cookie → ghép thành Netscape block per account.
 */
function tryParseJSONBlocks(text) {
  // Tìm tất cả JSON arrays trong text
  const jsonMatches = [...text.matchAll(/\[[\s\S]*?\]/g)];
  const blocks = [];

  for (const m of jsonMatches) {
    try {
      const arr = JSON.parse(m[0]);
      if (!Array.isArray(arr) || arr.length < 2) continue;

      // Lọc chỉ lấy cookie của netflix
      const netflixCookies = arr.filter(c =>
        c && typeof c === 'object' &&
        (String(c.domain || '').includes('netflix.com'))
      );

      if (netflixCookies.length < 2) continue;

      // Convert sang Netscape format
      const lines = netflixCookies.map(c => {
        const domain   = c.domain || '.netflix.com';
        const flag     = domain.startsWith('.') ? 'TRUE' : 'FALSE';
        const path_    = c.path || '/';
        const secure   = c.secure ? 'TRUE' : 'FALSE';
        const expires  = Math.round(c.expirationDate || c.expires || 0);
        const name     = c.name || '';
        const value    = c.value || '';
        return `${domain}\t${flag}\t${path_}\t${secure}\t${expires}\t${name}\t${value}`;
      });

      const block = lines.join('\n');
      if (isValidNetflixBlock(block)) blocks.push(block);
    } catch { /* không phải JSON hợp lệ */ }
  }
  return blocks;
}

function textsToBlocks(rawTexts) {
  const blocks = [];
  for (const text of rawTexts) {
    const parsed = parseCookieFileIntoBlocks(text);
    if (parsed.length) blocks.push(...parsed);
    else if (isValidNetflixBlock(text)) blocks.push(text.trim());
  }
  return blocks;
}

// ─── CONVERTER ────────────────────────────────────────────────────────────────
function runConverter(rawCookie) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [path.join(__dirname, 'convert_single.py')], { cwd: __dirname });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', () => {
      const out = stdout.trim();
      if (!out) return resolve({ error: `Không có output. Stderr: ${stderr.slice(-300)}` });
      try { resolve(JSON.parse(out)); }
      catch { resolve({ error: `Không parse được JSON: ${out.slice(-200)}` }); }
    });
    child.on('error', err => resolve({ error: `Không thể chạy Python: ${err.message}` }));
    child.stdin.write(rawCookie);
    child.stdin.end();
  });
}

// ─── HTTP HEADERS ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.shrestha.live/',
};

// ─── TẦNG 1 & 2: BỎ QUA (site là React SPA — axios không lấy được data) ──────
async function scrapeViaAPI(_country) { return []; }
async function scrapeViaHTML(_country) { return []; }

// ─── HELPER: Khởi động Puppeteer browser ─────────────────────────────────────
async function launchBrowser() {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('puppeteer-core chưa cài. Chạy: npm install puppeteer-core');
  }
  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    // Windows — Chrome
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.USERPROFILE}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
    // Windows — Edge (fallback)
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    // Linux
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  const execPath = chromiumPaths.find(p => fs.existsSync(p));
  if (!execPath) throw new Error(
    'Chromium không tìm thấy.\n' +
    '  • Ubuntu/Debian: sudo apt install chromium-browser\n' +
    '  • Hoặc đặt PUPPETEER_EXECUTABLE_PATH=/path/to/chromium trong .env'
  );
  return puppeteer.launch({
    executablePath: execPath,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'],
    headless: 'new',
  });
}

// ─── TẦNG 3: PUPPETEER — Click country button để lộ cookie ───────────────────
async function scrapeViaPuppeteer(country) {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    // ── Bắt toàn bộ network responses ────────────────────────────────────
    const networkTexts = [];
    page.on('response', async (response) => {
      try {
        const url = response.url();
        // Bỏ qua assets tĩnh
        if (/\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|css)(\?|$)/i.test(url)) return;
        if (url.includes('doubleclick') || url.includes('google-analytics') || url.includes('googletagmanager')) return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('text')) return;
        const text = await response.text();
        if (text.length < 20) return;
        // Log tất cả responses có nội dung đáng chú ý
        if (text.length > 100) {
          console.log(`[Network] ${url.slice(0, 100)} (${text.length}b, hasNF=${text.includes('netflix')})`);
        }
        if (looksLikeNetflixData(text)) {
          console.log(`[Network Hit] ${url.slice(0, 100)}`);
          networkTexts.push(text);
        }
      } catch {}
    });

    // ── Hook clipboard ────────────────────────────────────────────────────
    await page.evaluateOnNewDocument(() => {
      window.__copiedTexts = [];
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (t) => { window.__copiedTexts.push(t); return Promise.resolve(); },
            readText:  () => Promise.resolve(''),
          },
        });
      } catch {}
      const _exec = document.execCommand.bind(document);
      document.execCommand = function(cmd, ...a) {
        if (cmd === 'copy') {
          const s = window.getSelection();
          if (s && s.toString()) window.__copiedTexts.push(s.toString());
        }
        return _exec(cmd, ...a);
      };
    });

    // ── Navigate & chờ React render ───────────────────────────────────────
    console.log('[Tầng 3] Navigating to shrestha.live...');
    await page.goto('https://www.shrestha.live/', { waitUntil: 'networkidle2', timeout: 60_000 });
    try {
      await page.waitForFunction(
        () => document.querySelector('#root')?.children?.length > 0 &&
              document.body.innerText.trim().length > 100,
        { timeout: 20_000 }
      );
    } catch { console.log('[Tầng 3] waitForFunction timeout — tiếp tục...'); }
    await sleep(3000);

    // ── Helper: Hút cookie từ DOM hiện tại + bên trong iframes ──────────
    const collectDomTexts = async () => {
      const found = new Set();

      // Thu thập từ DOM chính
      const mainTexts = await page.evaluate(() => {
        const results = new Set();
        document.querySelectorAll('pre, textarea, code, input[type="text"]').forEach(el => {
          const t = (el.value || el.textContent || '').trim();
          if (t.length > 50 && t.includes('netflix.com')) results.add(t);
        });
        document.querySelectorAll('*').forEach(el => {
          if (el.children.length > 0) return;
          const t = (el.textContent || '').trim();
          if (t.length > 80 && t.includes('netflix.com')) results.add(t);
        });
        (document.body.innerText || '').split(/\n{2,}/).forEach(b => {
          if (b.trim().length > 50 && b.includes('netflix.com')) results.add(b.trim());
        });
        return [...results];
      });
      for (const t of mainTexts) found.add(t);

      // Thu thập từ bên trong từng iframe
      const frames = page.frames();
      for (const frame of frames) {
        if (frame === page.mainFrame()) continue;
        try {
          const frameTexts = await frame.evaluate(() => {
            const results = new Set();
            document.querySelectorAll('pre, textarea, code, input[type="text"]').forEach(el => {
              const t = (el.value || el.textContent || '').trim();
              if (t.length > 50 && t.includes('netflix.com')) results.add(t);
            });
            document.querySelectorAll('*').forEach(el => {
              if (el.children.length > 0) return;
              const t = (el.textContent || '').trim();
              if (t.length > 80 && t.includes('netflix.com')) results.add(t);
            });
            const bodyText = document.body?.innerText || '';
            if (bodyText.includes('netflix.com')) results.add(bodyText);
            return [...results];
          });
          for (const t of frameTexts) found.add(t);
          if (frameTexts.length) console.log(`[Tầng 3 iframe] Hit: ${frame.url().slice(0, 80)} — ${frameTexts.length} texts`);
        } catch {}
      }

      return [...found];
    };

    // ── Helper: Click tất cả copy buttons trên trang hiện tại + iframes ──
    const clickCopyButtons = async () => {
      const clickFn = () => {
        let clicked = 0;
        const keywords = ['COPY','COPY COOKIE','GET COOKIE','📋 COPY','COPY ALL','DOWNLOAD'];
        document.querySelectorAll('button,[role="button"],[class*="copy"],[class*="Copy"]').forEach(el => {
          const t = (el.textContent || '').trim().toUpperCase();
          if (keywords.some(k => t.includes(k))) {
            try { el.click(); clicked++; } catch {}
          }
        });
        return clicked;
      };
      let n = await page.evaluate(clickFn);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try { n += await frame.evaluate(clickFn); } catch {}
      }
      if (n > 0) await sleep(800 + n * 200);
      return n;
    };

    // ── CHIẾN LƯỢC CHÍNH: Click vào country buttons có 🍪 ────────────────
    // Trang hiển thị danh sách country dưới dạng button với số cookie
    // Cần click từng button để mở panel/modal chứa cookie thực
    const countryButtons = await page.evaluate((filterCountry) => {
      const results = [];
      const allBtns = [...document.querySelectorAll('button,[role="button"]')];
      for (const btn of allBtns) {
        const text = (btn.textContent || '').trim();
        // Bỏ qua nút điều hướng
        if (['JOIN NOW','CLOSE TERMINAL','CHECKER','CLOSE'].some(k => text.toUpperCase().includes(k))) continue;
        // Ưu tiên button có emoji 🍪 (có cookie)
        const hasCookie = text.includes('🍪') || /\d+\s*🍪/.test(text);
        if (!hasCookie) continue;
        // Nếu filter country, kiểm tra text chứa tên country
        if (filterCountry && !text.toUpperCase().includes(filterCountry.toUpperCase())) continue;
        results.push(text.slice(0, 60));
      }
      return results;
    }, country);

    console.log(`[Tầng 3] Tìm thấy ${countryButtons.length} country buttons có 🍪`);

    // Click lần lượt từng country button, mỗi lần thu thập cookie
    const allDomTexts = [];
    const maxClicks = country ? countryButtons.length : Math.min(countryButtons.length, 10);

    for (let i = 0; i < maxClicks; i++) {
      const btnText = countryButtons[i];
      try {
        // Tìm lại element theo text (DOM có thể đã thay đổi)
        const clicked = await page.evaluate((targetText) => {
          const allBtns = [...document.querySelectorAll('button,[role="button"]')];
          for (const btn of allBtns) {
            if ((btn.textContent || '').trim().startsWith(targetText.slice(0, 30))) {
              btn.click();
              return true;
            }
          }
          return false;
        }, btnText);

        if (!clicked) continue;
        console.log(`[Tầng 3] Đã click: ${btnText.slice(0, 40)}`);

        // Chờ panel/modal/textarea xuất hiện
        await sleep(3000);

        // Debug: xem DOM thay đổi gì sau khi click
        const postClickInfo = await page.evaluate(() => ({
          bodyLen:   document.body.innerText.length,
          hasNF:     document.body.innerText.includes('netflix.com'),
          modals:    [...document.querySelectorAll('[class*="modal"],[class*="Modal"],[class*="dialog"],[class*="Dialog"],[role="dialog"]')]
                       .map(m => m.innerText.slice(0, 100)).filter(t => t).slice(0, 3),
          allText:   [...document.querySelectorAll('pre,textarea,code,input')]
                       .map(e => (e.value || e.textContent || '').trim().slice(0, 80)).filter(t => t).slice(0, 5),
          iframes:   document.querySelectorAll('iframe').length,
          netflixLines: document.body.innerText.split('\n').filter(l => l.includes('netflix.com')).slice(0, 3),
          newBtns:   [...document.querySelectorAll('button,[role="button"]')]
                       .map(b => b.textContent.trim().slice(0, 30)).filter(t => t).slice(0, 8),
        }));
        console.log(`[PostClick] bodyLen=${postClickInfo.bodyLen} hasNF=${postClickInfo.hasNF} iframes=${postClickInfo.iframes}`);
        console.log(`[PostClick] modals=${JSON.stringify(postClickInfo.modals)}`);
        console.log(`[PostClick] allText=${JSON.stringify(postClickInfo.allText)}`);
        console.log(`[PostClick] netflixLines=${JSON.stringify(postClickInfo.netflixLines)}`);
        console.log(`[PostClick] newBtns=${JSON.stringify(postClickInfo.newBtns)}`);

        // Log URL của tất cả frames
        const frameUrls = page.frames().map(f => f.url()).filter(u => u && u !== 'about:blank');
        console.log(`[PostClick] frameUrls=${JSON.stringify(frameUrls)}`);

        // Thu thập cookie từ DOM sau khi click
        const texts = await collectDomTexts();
        for (const t of texts) {
          if (!allDomTexts.includes(t)) allDomTexts.push(t);
        }

        // Click copy buttons trong panel vừa mở
        await clickCopyButtons();
        await sleep(500);

        // Đóng panel/modal nếu có (click Escape hoặc nút Close)
        await page.keyboard.press('Escape');
        await sleep(500);
        await page.evaluate(() => {
          const closeKeywords = ['CLOSE','×','✕','❌'];
          document.querySelectorAll('button,[role="button"]').forEach(btn => {
            const t = (btn.textContent || '').trim().toUpperCase();
            if (closeKeywords.some(k => t === k)) { try { btn.click(); } catch {} }
          });
        });
        await sleep(300);

        // Nếu đã có đủ cookie thì dừng sớm
        if (allDomTexts.length >= 20) break;

      } catch (err) {
        console.log(`[Tầng 3] Lỗi click button ${i}: ${err.message}`);
      }
    }

    // ── Nếu chưa có gì — thử click nút CHECKER ───────────────────────────
    if (!allDomTexts.length && !networkTexts.length) {
      console.log('[Tầng 3] Không tìm thấy từ country buttons — thử click CHECKER...');
      await page.evaluate(() => {
        document.querySelectorAll('button,[role="button"]').forEach(btn => {
          if ((btn.textContent || '').trim().toUpperCase().includes('CHECKER')) {
            try { btn.click(); } catch {}
          }
        });
      });
      await sleep(3000);
      const texts = await collectDomTexts();
      allDomTexts.push(...texts);
      await clickCopyButtons();
    }

    // ── Thu thập clipboard ────────────────────────────────────────────────
    const copiedTexts = await page.evaluate(() => window.__copiedTexts || []);

    const all = [...new Set([...copiedTexts, ...allDomTexts, ...networkTexts])];
    console.log(`[Tầng 3] clipboard=${copiedTexts.length} dom=${allDomTexts.length} network=${networkTexts.length} total=${all.length}`);
    return all.filter(t => t && looksLikeNetflixData(t));

  } finally {
    await browser.close();
  }
}

// ─── SCRAPE CHÍNH ────────────────────────────────────────────────────────────
async function scrapeShrestha(country = null) {
  const errors = [];

  try {
    console.log('[scrape] Tầng 1: Direct API...');
    const rawTexts = await scrapeViaAPI(country);
    if (rawTexts.length) {
      const blocks = textsToBlocks(rawTexts);
      if (blocks.length) { console.log(`[scrape] Tầng 1 OK: ${blocks.length} blocks`); return { blocks }; }
    }
    errors.push('T1: Không tìm thấy cookie');
  } catch (err) { errors.push(`T1: ${err.message}`); }

  try {
    console.log('[scrape] Tầng 2: HTML Parse...');
    const rawTexts = await scrapeViaHTML(country);
    if (rawTexts.length) {
      const blocks = textsToBlocks(rawTexts);
      if (blocks.length) { console.log(`[scrape] Tầng 2 OK: ${blocks.length} blocks`); return { blocks }; }
    }
    errors.push('T2: Không tìm thấy cookie');
  } catch (err) { errors.push(`T2: ${err.message}`); }

  try {
    console.log('[scrape] Tầng 3: Puppeteer...');
    const rawTexts = await scrapeViaPuppeteer(country);
    if (rawTexts.length) {
      const blocks = textsToBlocks(rawTexts);
      if (blocks.length) { console.log(`[scrape] Tầng 3 OK: ${blocks.length} blocks`); return { blocks }; }
    }
    errors.push('T3: Không tìm thấy cookie');
  } catch (err) { errors.push(`T3: ${err.message}`); }

  return { blocks: [], error: errors.join(' | ') };
}

// ─── DEBUG: Xem raw HTML shrestha.live ───────────────────────────────────────
async function debugFetchShrestha() {
  // Site là React SPA — cần Puppeteer để xem DOM thật sau khi render
  let browser;
  try { browser = await launchBrowser(); }
  catch (e) { return { error: e.message }; }

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

    const networkUrls = [];
    page.on('response', async (res) => {
      try {
        const ct = res.headers()['content-type'] || '';
        if (ct.includes('json') || ct.includes('text/plain')) {
          const text = await res.text();
          if (text.length > 20 && res.url().includes('shrestha')) {
            networkUrls.push({ url: res.url(), len: text.length, hasNF: text.includes('netflix') });
          }
        }
      } catch {}
    });

    await page.goto('https://www.shrestha.live/', { waitUntil: 'networkidle2', timeout: 60_000 });

    // Chờ React render
    try {
      await page.waitForFunction(
        () => document.querySelector('#root')?.children?.length > 0 && document.body.innerText.length > 100,
        { timeout: 20_000 }
      );
    } catch {}
    await sleep(3000);

    // Scroll để lazy-load
    await page.evaluate(async () => {
      for (let i = 0; i < 3; i++) {
        window.scrollBy(0, window.innerHeight);
        await new Promise(r => setTimeout(r, 500));
      }
    });
    await sleep(1500);

    const info = await page.evaluate(() => ({
      title:          document.title,
      bodyTextLen:    document.body.innerText.length,
      bodySnippet:    document.body.innerText.slice(0, 500),
      hasNetflix:     document.body.innerText.toLowerCase().includes('netflix'),
      hasNetflixCom:  document.body.innerText.includes('netflix.com'),
      hasNetflixId:   /NetflixId/i.test(document.body.innerText),
      hasTabs:        /\.netflix\.com\t/.test(document.body.innerText),
      rootChildren:   document.querySelector('#root')?.children?.length ?? 0,
      buttons:        [...document.querySelectorAll('button,[role="button"]')]
                        .map(b => b.textContent.trim().slice(0, 40))
                        .filter(t => t)
                        .slice(0, 15),
      textareas:      [...document.querySelectorAll('pre,textarea,code')]
                        .map(e => (e.value || e.textContent || '').trim().slice(0, 80))
                        .filter(t => t)
                        .slice(0, 5),
    }));

    const html = await page.content();

    const summary = [
      `📏 Body text length: ${info.bodyTextLen} chars`,
      `🏷️ Page title: ${info.title}`,
      `🌳 #root children: ${info.rootChildren}`,
      `🔑 Contains "netflix": ${info.hasNetflix}`,
      `🔑 Contains "netflix.com": ${info.hasNetflixCom}`,
      `🔑 Contains "NetflixId": ${info.hasNetflixId}`,
      `🔑 Contains tab+netflix: ${info.hasTabs}`,
      `📡 Network responses: ${networkUrls.length}`,
    ];

    return {
      summary,
      snippet:     info.bodySnippet.replace(/`/g, "'"),
      apiRefs:     networkUrls.slice(0, 8).map(u => `${u.url.slice(0, 80)} (${u.len}b, netflix=${u.hasNF})`),
      buttons:     info.buttons,
      textareas:   info.textareas,
      html,
    };
  } finally {
    await browser.close();
  }
}

// ─── DISCORD CLIENT ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('start').setDescription('Lấy link Netflix (PC hoặc Điện Thoại)'),
  new SlashCommandBuilder()
    .setName('upcookie').setDescription('Upload file cookie thô vào bộ nhớ (Admin only)')
    .addAttachmentOption(opt => opt.setName('file').setDescription('File .txt hoặc .json chứa cookie Netflix').setRequired(true)),
  new SlashCommandBuilder().setName('clearcookie').setDescription('Xóa toàn bộ cookie trong bộ nhớ (Admin only)'),
  new SlashCommandBuilder()
    .setName('fetchcookie').setDescription('Tự động lấy cookie từ shrestha.live (Admin only)')
    .addStringOption(opt => opt.setName('country').setDescription('Tên quốc gia — bỏ trống = lấy tất cả').setRequired(false)),
  new SlashCommandBuilder().setName('status').setDescription('Xem số cookie đang có trong bộ nhớ'),
  new SlashCommandBuilder().setName('debug').setDescription('Debug: xem raw data từ shrestha.live (Admin only)'),
].map(c => c.toJSON());

async function registerCommands() {
  const rest  = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(DISCORD_CLIENT_ID);
  try {
    await rest.put(route, { body: commands });
    console.log(`✅ Đã đăng ký ${commands.length} slash commands`);
  } catch (err) {
    console.error('❌ Lỗi đăng ký commands:', err.message);
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function planToEmoji(plan = '') {
  const p = plan.toLowerCase();
  if (p.includes('premium'))  return '💎';
  if (p.includes('standard')) return '⭐';
  if (p.includes('basic'))    return '🔵';
  if (p.includes('mobile'))   return '📱';
  return '🎬';
}

function updateStatus() {
  const count = countCookies();
  client.user?.setPresence({
    status: 'idle',
    activities: [{ name: count > 0 ? `🎬 ${count} cookie sẵn sàng` : '⏳ Tự động nạp khi cần', type: ActivityType.Watching }],
  });
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  console.log(`🐍 Python: ${PYTHON_BIN}`);
  console.log('💾 Chế độ: IN-MEMORY queue (không dùng DB)');
  await registerCommands();
  updateStatus();
});

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── /start ─────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
    const count = countCookies();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_phone').setLabel('📱 Link Điện Thoại').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('btn_pc').setLabel('🖥️ Link Máy Tính').setStyle(ButtonStyle.Primary),
    );
    const rowGuide = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('📖 Hướng Dẫn Điện Thoại').setStyle(ButtonStyle.Link).setURL('https://drive.google.com/drive/folders/1QAw4249og5hJuqF4jAcwCecTvyytv2jZ?usp=drive_link'),
      new ButtonBuilder().setLabel('📖 Hướng Dẫn Máy Tính').setStyle(ButtonStyle.Link).setURL('https://drive.google.com/drive/folders/1S7bINLNLjy_Phmhc76DSugm1xgA44OJ_?usp=drive_link'),
    );
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🎬 Netflix của Tún Kịt')
      .setDescription(
        '**Chọn loại link bạn muốn tạo:**\n\n' +
        '📱 **Điện Thoại** – Tối ưu cho mobile\n' +
        '🖥️ **Máy Tính** – Tối ưu cho desktop\n\n' +
        (count > 0 ? `> 🗂️ Còn **${count}** cookie sẵn sàng\n\n` : `> ⚡ Sẽ tự động lấy cookie khi bạn bấm nút\n\n`) +
        '> ⚠️ Nếu acc không xem được pls log out và đổi qua acc khác, ping admin nếu có thắc mắc',
      )
      .setFooter({ text: 'Bot by Sếp Tún Kịt' });
    await interaction.reply({ embeds: [embed], components: [row, rowGuide] });
    return;
  }

  // ── /status ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'status') {
    const count = countCookies();
    await interaction.reply({
      content: count > 0
        ? `🗂️ Hiện có **${count}** cookie trong bộ nhớ.`
        : `📭 Queue đang trống — bot sẽ tự scrape khi user bấm nút.`,
      ephemeral: true,
    });
    return;
  }

  // ── /debug ─────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'debug') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });

    const { summary, snippet, apiRefs, buttons, textareas, error, html } = await debugFetchShrestha();

    if (error) {
      await interaction.editReply(`❌ Lỗi khi fetch shrestha.live:\n\`\`\`\n${error}\n\`\`\``);
      return;
    }

    const debugFile = path.join(__dirname, 'debug_shrestha.html');
    try { fs.writeFileSync(debugFile, html || '', 'utf8'); } catch {}

    const summaryText  = summary.join('\n');
    const apiText      = (apiRefs || []).length ? apiRefs.join('\n') : '(không có)';
    const btnText      = (buttons || []).length ? buttons.join(' | ') : '(không tìm thấy)';
    const taText       = (textareas || []).length ? textareas.map((t,i) => `[${i}] ${t}`).join('\n') : '(không có)';
    const snippetClean = (snippet || '').replace(/`/g, "'").slice(0, 500);

    await interaction.editReply(
      `**🔍 Debug shrestha.live (sau khi React render):**\n\`\`\`\n${summaryText}\n\`\`\`` +
      `\n**🖱️ Buttons trên trang:**\n\`\`\`\n${btnText}\n\`\`\`` +
      `\n**📋 pre/textarea/code:**\n\`\`\`\n${taText.slice(0,300)}\n\`\`\`` +
      `\n**📡 Network responses:**\n\`\`\`\n${apiText.slice(0,400)}\n\`\`\`` +
      `\n**📄 Body text snippet:**\n\`\`\`\n${snippetClean}\n\`\`\``
    );
    return;
  }

  // ── /clearcookie ───────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'clearcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền.', ephemeral: true });
      return;
    }
    const removed = clearCookies();
    updateStatus();
    await interaction.reply({ content: `🗑️ Đã xóa **${removed}** cookie. Queue: **0**.`, ephemeral: true });
    return;
  }

  // ── /fetchcookie ───────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'fetchcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền.', ephemeral: true });
      return;
    }
    const country = interaction.options.getString('country') || null;
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply(`🌐 Đang scrape shrestha.live${country ? ` (${country})` : ''}... (~30-60s)`);

    const { blocks, error } = await scrapeShrestha(country);

    if (!blocks.length) {
      await interaction.editReply(
        `❌ Scrape thất bại:\n\`\`\`\n${(error || 'Không rõ lỗi').slice(0, 800)}\n\`\`\`\n` +
        `💡 Dùng \`/debug\` để xem raw HTML, hoặc \`/upcookie\` để upload thủ công.`
      );
      return;
    }

    const saved = pushCookies(blocks);
    updateStatus();
    await interaction.editReply(`✅ Đã nạp **${saved}** cookie.\n🗂️ Tổng: **${countCookies()}** cookie.`);
    return;
  }

  // ── /upcookie ──────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'upcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền.', ephemeral: true });
      return;
    }
    const attachment = interaction.options.getAttachment('file');
    const fname      = attachment.name.toLowerCase();
    if (!fname.endsWith('.txt') && !fname.endsWith('.json')) {
      await interaction.reply({ content: '❌ Chỉ nhận file `.txt` hoặc `.json`.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const res    = await axios.get(attachment.url, { responseType: 'text', timeout: 10_000 });
      const blocks = parseCookieFileIntoBlocks(res.data);
      if (!blocks.length) {
        await interaction.editReply(
          '❌ Không tìm thấy cookie hợp lệ.\n' +
          'File cần chứa cookie Netflix dạng Netscape (`.netflix.com` tab-separated) hoặc JSON array.'
        );
        return;
      }
      const saved = pushCookies(blocks);
      updateStatus();
      await interaction.editReply(`✅ Đã thêm **${saved}** cookie.\n🗂️ Tổng: **${countCookies()}** cookie.`);
    } catch (err) {
      await interaction.editReply(`❌ Lỗi: ${err.message}`);
    }
    return;
  }

  // ── Buttons ────────────────────────────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId === 'btn_phone' || interaction.customId === 'btn_pc')) {
    const mode = interaction.customId === 'btn_phone' ? 'phone' : 'pc';
    await interaction.deferReply();

    if (countCookies() === 0) {
      await interaction.editReply('⏳ Kho trống — đang tự động lấy cookie từ shrestha.live...');

      const { added, error } = await autoRefill();

      if (added === 0) {
        await interaction.editReply(
          `❌ Không lấy được cookie tự động.\n` +
          (error ? `> \`${error.slice(0, 250)}\`\n\n` : '') +
          `Vui lòng ping admin **Tún Kịt** để upload thủ công qua \`/upcookie\`.`
        );
        return;
      }

      await interaction.editReply(`✅ Nạp được **${added}** cookie — đang tạo link...`);
    } else {
      await interaction.editReply('⏳ Đang tạo link NFToken, vui lòng chờ...');
    }

    const rawCookie = popCookie();
    if (!rawCookie) {
      await interaction.editReply('❌ Hết cookie! Vui lòng thử lại.');
      return;
    }

    updateStatus();
    const result = await runConverter(rawCookie);

    if (result.error) {
      console.error('[runConverter]', result.error);
      await interaction.editReply(
        `🍪❌ Cookie lỗi, bấm lại để thử cookie khác — còn **${countCookies()}** cookie.`
      );
      return;
    }

    const link = mode === 'phone' ? result.phone_link : result.pc_link;

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Tạo Link Thành Công!')
      .addFields(
        { name: '📧 Email',                         value: `\`${result.email || '??'}\``, inline: true },
        { name: `${planToEmoji(result.plan)} Plan`, value: result.plan    || '??',        inline: true },
        { name: '🌍 Country',                       value: result.country || '??',        inline: true },
        { name: mode === 'phone' ? '📱 Link Điện Thoại' : '🖥️ Link Máy Tính', value: link || '(không có link)' },
      )
      .setFooter({ text: `Sếp Tún Kịt • ${new Date().toLocaleTimeString('vi-VN')}` });

    await interaction.editReply({ content: '', embeds: [embed] });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('❌ Thiếu DISCORD_TOKEN hoặc DISCORD_CLIENT_ID trong .env');
  process.exit(1);
}
client.login(DISCORD_TOKEN);