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

/** Tự động scrape shrestha.live. Trả về { added: number, error?: string } */
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
function parseCookieFileIntoBlocks(rawText) {
  const blocks = [];
  const lines  = rawText.split(/\r?\n/);
  let cur = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('.netflix.com') || t.startsWith('netflix.com')) {
      cur.push(line);
    } else if (cur.length) {
      const block = cur.join('\n');
      if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) blocks.push(block);
      cur = [];
    }
  }
  if (cur.length) {
    const block = cur.join('\n');
    if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) blocks.push(block);
  }
  return blocks;
}

function textsToBlocks(rawTexts) {
  const blocks = [];
  for (const text of rawTexts) {
    const parsed = parseCookieFileIntoBlocks(text);
    if (parsed.length) blocks.push(...parsed);
    else if (/NetflixId/i.test(text) || /SecureNetflixId/i.test(text)) blocks.push(text.trim());
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

// ─── SHRESTHA.LIVE SCRAPER (3 TẦNG) ──────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HTTP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.shrestha.live/',
};

/**
 * Tầng 1: Gọi thẳng các API endpoint phổ biến bằng axios (không cần browser).
 */
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
  ];
  const base = 'https://www.shrestha.live';

  for (const p of apiPaths) {
    try {
      const url = country ? `${base}${p}?country=${encodeURIComponent(country)}` : `${base}${p}`;
      const res = await axios.get(url, { headers: HTTP_HEADERS, timeout: 15_000 });
      const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      if ((text.includes('NetflixId') || text.includes('SecureNetflixId')) && text.includes('.netflix.com')) {
        console.log(`[Tầng 1] Hit: ${p}`);
        return [text];
      }
    } catch { /* thử path tiếp theo */ }
  }
  return [];
}

/**
 * Tầng 2: Fetch HTML, tìm SSR data + API refs trong source.
 */
async function scrapeViaHTML(country) {
  const url = country
    ? `https://www.shrestha.live/?country=${encodeURIComponent(country)}`
    : 'https://www.shrestha.live/';

  const res  = await axios.get(url, { headers: HTTP_HEADERS, timeout: 20_000 });
  const html = res.data;
  const found = new Set();

  // a) __NEXT_DATA__ / __NUXT_DATA__ (SSR inline JSON)
  const ssrMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
                || html.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (ssrMatch && (/NetflixId/i.test(ssrMatch[1]) || /SecureNetflixId/i.test(ssrMatch[1]))) {
    found.add(ssrMatch[1]);
  }

  // b) Đoạn text có .netflix.com trong source HTML
  const chunks = html.match(/\.netflix\.com[\s\S]{0,2000}?(?=\.netflix\.com|<\/|$)/g) || [];
  for (const chunk of chunks) {
    if (/NetflixId/i.test(chunk) || /SecureNetflixId/i.test(chunk)) found.add(chunk);
  }

  // c) Tìm /api/... refs trong source rồi gọi thêm
  const apiRefs = [...new Set([...html.matchAll(/['"`](\/api\/[^'"`\s?#]+)/g)].map(m => m[1]))];
  for (const ref of apiRefs.slice(0, 10)) {
    try {
      const apiRes = await axios.get(`https://www.shrestha.live${ref}`, { headers: HTTP_HEADERS, timeout: 10_000 });
      const text = typeof apiRes.data === 'string' ? apiRes.data : JSON.stringify(apiRes.data);
      if ((text.includes('NetflixId') || text.includes('SecureNetflixId')) && text.includes('.netflix.com')) {
        found.add(text);
      }
    } catch { /* bỏ qua */ }
  }

  console.log(`[Tầng 2] ${found.size} candidate(s)`);
  return [...found].filter(t => t.includes('.netflix.com'));
}

/**
 * Tầng 3: Puppeteer headless browser. Bỏ qua nếu Chromium chưa cài.
 */
async function scrapeViaPuppeteer(country) {
  let puppeteer;
  try {
    puppeteer = (await import('puppeteer-core')).default;
  } catch {
    throw new Error('puppeteer-core chưa cài (npm install puppeteer-core)');
  }

  // Tìm Chromium
  const chromiumPaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  const execPath = chromiumPaths.find(p => fs.existsSync(p));
  if (!execPath) {
    throw new Error(
      `Chromium không tìm thấy. Hãy:\n` +
      `  1. Cài chromium: apt install chromium-browser\n` +
      `  2. Hoặc đặt PUPPETEER_EXECUTABLE_PATH=/đường/dẫn/chromium trong .env`
    );
  }

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
        if ((text.includes('NetflixId') || text.includes('SecureNetflixId')) && text.includes('.netflix.com')) {
          apiBlocks.push(text);
        }
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

    await page.goto('https://www.shrestha.live/', { waitUntil: 'domcontentloaded', timeout: 45000 });
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

    const n = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('button,[role="button"],[class*="copy"],[class*="Copy"],span,div,a').forEach(el => {
        const t = (el.textContent||el.value||'').trim().toUpperCase();
        if (t === 'COPY' || t === '📋 COPY' || t === 'COPY COOKIE') { try { el.click(); n++; } catch {} }
      });
      return n;
    });

    await sleep(800 + n * 150);
    const copiedTexts = await page.evaluate(() => window.__copiedTexts || []);

    const domTexts = await page.evaluate(() => {
      const found = new Set();
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const t = (el.textContent||'').trim();
        if (t.length > 50 && t.includes('.netflix.com') && /NetflixId|SecureNetflixId/i.test(t)) found.add(t);
      });
      document.querySelectorAll('pre,textarea,code').forEach(el => {
        const t = (el.value||el.textContent||'').trim();
        if (t.includes('.netflix.com') && /NetflixId|SecureNetflixId/i.test(t)) found.add(t);
      });
      (document.body.innerText||'').split(/\n{2,}/).forEach(b => {
        if (b.includes('.netflix.com') && /NetflixId|SecureNetflixId/i.test(b)) found.add(b.trim());
      });
      return [...found];
    });

    console.log(`[Tầng 3] clipboard=${copiedTexts.length} dom=${domTexts.length} api=${apiBlocks.length}`);
    return [...new Set([...copiedTexts, ...domTexts, ...apiBlocks])].filter(t => t && (t.includes('NetflixId') || t.includes('SecureNetflixId')));

  } finally {
    await browser.close();
  }
}

/**
 * Hàm scrape chính — thử 3 tầng theo thứ tự.
 * Trả về { blocks: string[], error?: string }
 */
async function scrapeShrestha(country = null) {
  const errors = [];

  // Tầng 1: Direct API
  try {
    console.log('[scrape] Tầng 1: Direct API...');
    const rawTexts = await scrapeViaAPI(country);
    if (rawTexts.length) {
      const blocks = textsToBlocks(rawTexts);
      if (blocks.length) { console.log(`[scrape] Tầng 1 OK: ${blocks.length} blocks`); return { blocks }; }
    }
    errors.push('T1: Không tìm thấy cookie');
  } catch (err) {
    errors.push(`T1: ${err.message}`);
  }

  // Tầng 2: HTML Parse
  try {
    console.log('[scrape] Tầng 2: HTML Parse...');
    const rawTexts = await scrapeViaHTML(country);
    if (rawTexts.length) {
      const blocks = textsToBlocks(rawTexts);
      if (blocks.length) { console.log(`[scrape] Tầng 2 OK: ${blocks.length} blocks`); return { blocks }; }
    }
    errors.push('T2: Không tìm thấy cookie');
  } catch (err) {
    errors.push(`T2: ${err.message}`);
  }

  // Tầng 3: Puppeteer
  try {
    console.log('[scrape] Tầng 3: Puppeteer...');
    const rawTexts = await scrapeViaPuppeteer(country);
    if (rawTexts.length) {
      const blocks = textsToBlocks(rawTexts);
      if (blocks.length) { console.log(`[scrape] Tầng 3 OK: ${blocks.length} blocks`); return { blocks }; }
    }
    errors.push('T3: Không tìm thấy cookie');
  } catch (err) {
    errors.push(`T3: ${err.message}`);
  }

  return { blocks: [], error: errors.join(' | ') };
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
    .addAttachmentOption(opt => opt.setName('file').setDescription('File .txt chứa cookie Netflix').setRequired(true)),
  new SlashCommandBuilder().setName('clearcookie').setDescription('Xóa toàn bộ cookie trong bộ nhớ (Admin only)'),
  new SlashCommandBuilder()
    .setName('fetchcookie').setDescription('Tự động lấy cookie từ shrestha.live (Admin only)')
    .addStringOption(opt => opt.setName('country').setDescription('Tên quốc gia — bỏ trống = lấy tất cả').setRequired(false)),
  new SlashCommandBuilder().setName('status').setDescription('Xem số cookie đang có trong bộ nhớ'),
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
        `💡 Thử \`/upcookie\` để upload thủ công.`
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
    if (!attachment.name.toLowerCase().endsWith('.txt')) {
      await interaction.reply({ content: '❌ Chỉ nhận file `.txt`.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const res    = await axios.get(attachment.url, { responseType: 'text', timeout: 10_000 });
      const blocks = parseCookieFileIntoBlocks(res.data);
      if (!blocks.length) {
        await interaction.editReply('❌ Không tìm thấy cookie hợp lệ. (Cần `NetflixId` hoặc `SecureNetflixId`)');
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

    // Queue rỗng → tự động scrape
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