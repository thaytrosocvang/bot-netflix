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

// ─── TẦNG 1: DIRECT API ───────────────────────────────────────────────────────
async function scrapeViaAPI(country) {
  const apiPaths = [
    '/api/cookies',
    '/api/netflix',
    '/api/netflix-cookies',
    '/api/get-cookies',
    '/api/accounts',
    '/api/data',
    '/cookies.json',
    '/data/netflix.json',
    '/api/cookie',
    '/api/free',
    '/api/free-cookies',
    '/api/list',
  ];
  const base = 'https://www.shrestha.live';

  for (const p of apiPaths) {
    try {
      const url = country ? `${base}${p}?country=${encodeURIComponent(country)}` : `${base}${p}`;
      const res = await axios.get(url, { headers: HTTP_HEADERS, timeout: 15_000 });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if (looksLikeNetflixData(text)) {
        console.log(`[Tầng 1] Hit: ${p}`);
        return [text];
      }
    } catch { /* thử path tiếp theo */ }
  }
  return [];
}

// ─── TẦNG 2: HTML PARSE ───────────────────────────────────────────────────────
async function scrapeViaHTML(country) {
  const urls = [
    country
      ? `https://www.shrestha.live/?country=${encodeURIComponent(country)}`
      : 'https://www.shrestha.live/',
    'https://www.shrestha.live/netflix',
    'https://www.shrestha.live/cookies',
    'https://www.shrestha.live/free',
  ];

  const found = new Set();

  for (const url of urls) {
    try {
      const res  = await axios.get(url, { headers: HTTP_HEADERS, timeout: 20_000 });
      const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

      // a) __NEXT_DATA__ / __NUXT_DATA__ (SSR inline JSON)
      for (const re of [
        /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
        /<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i,
        /<script[^>]*>([\s\S]*?netflix[\s\S]*?)<\/script>/gi,
      ]) {
        const ssrMatch = re.exec(html);
        if (ssrMatch && looksLikeNetflixData(ssrMatch[1])) {
          found.add(ssrMatch[1]);
        }
      }

      // b) Đoạn text có .netflix.com trong source HTML — mở rộng pattern
      const chunks = html.match(/\.netflix\.com[\s\S]{0,3000}?(?=\.netflix\.com|<\/(?:script|div|pre|textarea|code)|$)/g) || [];
      for (const chunk of chunks) {
        if (looksLikeNetflixData(chunk)) found.add(chunk);
      }

      // c) Các element textarea, pre, code chứa cookie
      const elementMatches = html.match(/<(?:textarea|pre|code)[^>]*>([\s\S]*?)<\/(?:textarea|pre|code)>/gi) || [];
      for (const el of elementMatches) {
        const inner = el.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        if (looksLikeNetflixData(inner)) found.add(inner);
      }

      // d) Tìm /api/... refs trong source rồi gọi thêm
      const apiRefs = [...new Set([...html.matchAll(/['"`](\/api\/[^'"`\s?#]+)/g)].map(m => m[1]))];
      for (const ref of apiRefs.slice(0, 15)) {
        try {
          const apiRes = await axios.get(`https://www.shrestha.live${ref}`, { headers: HTTP_HEADERS, timeout: 10_000 });
          const text = typeof apiRes.data === 'string' ? apiRes.data : JSON.stringify(apiRes.data);
          if (looksLikeNetflixData(text)) {
            console.log(`[Tầng 2] API ref hit: ${ref}`);
            found.add(text);
          }
        } catch { /* bỏ qua */ }
      }

      // e) Tìm window.__data__ / props / pageProps JSON
      const dataMatches = [
        ...html.matchAll(/window\.__(?:data|props|state|cookies|INITIAL_DATA)__\s*=\s*(\{[\s\S]*?\});/gi),
        ...html.matchAll(/(?:pageProps|initialProps|serverData)\s*[=:]\s*(\{[\s\S]*?netflix[\s\S]*?\});/gi),
      ];
      for (const m of dataMatches) {
        if (looksLikeNetflixData(m[1])) found.add(m[1]);
      }

    } catch (err) {
      console.log(`[Tầng 2] Lỗi ${url}: ${err.message}`);
    }
  }

  console.log(`[Tầng 2] ${found.size} candidate(s)`);
  return [...found].filter(t => looksLikeNetflixData(t));
}

// ─── TẦNG 3: PUPPETEER ───────────────────────────────────────────────────────
async function scrapeViaPuppeteer(country) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('puppeteer-core chưa cài');
  }

  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  const execPath = chromiumPaths.find(p => fs.existsSync(p));
  if (!execPath) throw new Error('Chromium không tìm thấy.');

  const browser = await puppeteer.launch({
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
    headless: 'new',
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const apiBlocks = [];
    page.on('response', async (response) => {
      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('text')) return;
        const text = await response.text();
        if (looksLikeNetflixData(text)) apiBlocks.push(text);
      } catch {}
    });

    await page.evaluateOnNewDocument(() => {
      window.__copiedTexts = [];
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (t) => { window.__copiedTexts.push(t); return Promise.resolve(); },
            readText: () => Promise.resolve(''),
          },
        });
      } catch {}
      const _exec = document.execCommand.bind(document);
      document.execCommand = function(cmd, ...a) {
        if (cmd === 'copy') { const s = window.getSelection(); if (s) window.__copiedTexts.push(s.toString()); }
        return _exec(cmd, ...a);
      };
    });

    const targetUrl = country
      ? `https://www.shrestha.live/?country=${encodeURIComponent(country)}`
      : 'https://www.shrestha.live/';

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(6000);

    if (country) {
      for (const sel of ['input[placeholder*="SEARCH"]','input[placeholder*="search"]','input[type="text"]','input[type="search"]']) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(country, { delay: 80 });
            await sleep(2000);
            const clicked = await page.evaluate(c => {
              for (const el of document.querySelectorAll('li,[class*="item"],[class*="result"],[class*="option"]')) {
                if ((el.textContent||'').trim().toUpperCase().includes(c.toUpperCase())) { el.click(); return true; }
              }
              return false;
            }, country);
            if (!clicked) await page.keyboard.press('Enter');
            await sleep(3000);
            break;
          }
        } catch {}
      }
    }

    await sleep(2000);

    // Click tất cả nút có vẻ là copy
    const n = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('button,[role="button"],[class*="copy"],[class*="Copy"],span,div,a').forEach(el => {
        const t = (el.textContent||el.value||'').trim().toUpperCase();
        if (t === 'COPY' || t === '📋 COPY' || t === 'COPY COOKIE' || t === 'GET COOKIE' || t === 'DOWNLOAD') {
          try { el.click(); n++; } catch {}
        }
      });
      return n;
    });

    await sleep(800 + n * 150);
    const copiedTexts = await page.evaluate(() => window.__copiedTexts || []);

    const domTexts = await page.evaluate(() => {
      const found = new Set();
      // Tìm trong leaf nodes
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const t = (el.textContent||'').trim();
        if (t.length > 30 && t.includes('netflix.com')) found.add(t);
      });
      // pre/textarea/code elements
      document.querySelectorAll('pre,textarea,code').forEach(el => {
        const t = (el.value||el.textContent||'').trim();
        if (t.includes('netflix.com')) found.add(t);
      });
      // body text paragraphs
      (document.body.innerText||'').split(/\n{2,}/).forEach(b => {
        if (b.includes('netflix.com')) found.add(b.trim());
      });
      return [...found];
    });

    console.log(`[Tầng 3] clipboard=${copiedTexts.length} dom=${domTexts.length} api=${apiBlocks.length}`);
    return [...new Set([...copiedTexts, ...domTexts, ...apiBlocks])].filter(t => t && looksLikeNetflixData(t));

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
  try {
    const res  = await axios.get('https://www.shrestha.live/', { headers: HTTP_HEADERS, timeout: 20_000 });
    const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

    // Tóm tắt những gì tìm thấy
    const summary = [];
    summary.push(`📏 HTML length: ${html.length} chars`);
    summary.push(`🔑 Contains "netflix.com": ${html.includes('netflix.com')}`);
    summary.push(`🔑 Contains "NetflixId": ${/NetflixId/i.test(html)}`);
    summary.push(`🔑 Contains "SecureNetflixId": ${/SecureNetflixId/i.test(html)}`);
    summary.push(`🔑 Contains "nfvdid": ${/nfvdid/i.test(html)}`);
    summary.push(`🔑 Contains tab+netflix: ${/\.netflix\.com\t/i.test(html)}`);
    summary.push(`🔑 Contains JSON cookie: ${/"domain"\s*:\s*"\.?netflix\.com"/i.test(html)}`);
    summary.push(`🔑 Contains "__NEXT_DATA__": ${html.includes('__NEXT_DATA__')}`);
    summary.push(`🔑 Contains "api/": ${html.includes('/api/')}`);

    // Lấy 800 chars đầu của body content
    const bodyStart = html.indexOf('<body');
    const snippet   = html.slice(bodyStart > 0 ? bodyStart : 0, (bodyStart > 0 ? bodyStart : 0) + 800);

    // Tìm các API paths
    const apiRefs = [...new Set([...html.matchAll(/['"`](\/api\/[^'"`\s?#]{1,60})/g)].map(m => m[1]))].slice(0, 10);

    return { summary, snippet: snippet.replace(/[\r\n]+/g, ' ').slice(0, 600), apiRefs, html };
  } catch (err) {
    return { error: err.message };
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

    const { summary, snippet, apiRefs, error, html } = await debugFetchShrestha();

    if (error) {
      await interaction.editReply(`❌ Lỗi khi fetch shrestha.live:\n\`\`\`\n${error}\n\`\`\``);
      return;
    }

    // Ghi raw HTML vào file tạm để debug sâu hơn
    const debugFile = path.join(__dirname, 'debug_shrestha.html');
    try { fs.writeFileSync(debugFile, html, 'utf8'); } catch {}

    const summaryText  = summary.join('\n');
    const apiText      = apiRefs.length ? apiRefs.join('\n') : '(không tìm thấy)';
    const snippetClean = snippet.replace(/`/g, "'");

    await interaction.editReply(
      `**🔍 Debug shrestha.live:**\n\`\`\`\n${summaryText}\n\`\`\`` +
      `\n**📡 API paths tìm thấy:**\n\`\`\`\n${apiText}\n\`\`\`` +
      `\n**📄 Body snippet (600 chars):**\n\`\`\`html\n${snippetClean}\n\`\`\``
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