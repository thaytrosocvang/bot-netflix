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
import puppeteer from 'puppeteer-core';

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
// Mảng raw cookie strings, hoạt động như FIFO queue (không lưu DB)
const cookieQueue = [];

function countCookies() {
  return cookieQueue.length;
}

/** Lấy 1 cookie đầu hàng và xóa khỏi queue */
function popCookie() {
  if (cookieQueue.length === 0) return null;
  return cookieQueue.shift();
}

/** Thêm mảng cookie blocks vào cuối queue */
function pushCookies(blocks) {
  if (!blocks.length) return 0;
  cookieQueue.push(...blocks);
  return blocks.length;
}

/** Xóa toàn bộ queue */
function clearCookies() {
  const count = cookieQueue.length;
  cookieQueue.length = 0;
  return count;
}

// ─── AUTO-REFILL GUARD ────────────────────────────────────────────────────────
// Tránh nhiều request đồng thời cùng trigger scrape
let isRefilling = false;

/**
 * Tự động scrape shrestha.live để nạp lại queue.
 * Trả về số cookie đã thêm, hoặc 0 nếu thất bại / đang refill.
 */
async function autoRefill() {
  if (isRefilling) return 0;
  isRefilling = true;
  try {
    console.log('[autoRefill] Queue rỗng — tự động scrape shrestha.live...');
    const rawTexts = await scrapeShrestha(null);

    if (!rawTexts.length) {
      console.log('[autoRefill] Không lấy được cookie nào.');
      return 0;
    }

    const blocks = [];
    for (const text of rawTexts) {
      const parsed = parseCookieFileIntoBlocks(text);
      if (parsed.length > 0) {
        blocks.push(...parsed);
      } else if (text.includes('NetflixId') || text.includes('SecureNetflixId')) {
        blocks.push(text.trim());
      }
    }

    const added = pushCookies(blocks);
    console.log(`[autoRefill] Đã nạp thêm ${added} cookie vào queue.`);
    return added;
  } catch (err) {
    console.error('[autoRefill] Lỗi:', err.message);
    return 0;
  } finally {
    isRefilling = false;
  }
}

// ─── PARSER: tách file cookie thô thành từng block ───────────────────────────
function parseCookieFileIntoBlocks(rawText) {
  const blocks = [];
  const lines  = rawText.split(/\r?\n/);
  let currentLines = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('.netflix.com') || t.startsWith('netflix.com')) {
      currentLines.push(line);
    } else {
      if (currentLines.length > 0) {
        const block = currentLines.join('\n');
        if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) {
          blocks.push(block);
        }
        currentLines = [];
      }
    }
  }

  if (currentLines.length > 0) {
    const block = currentLines.join('\n');
    if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) {
      blocks.push(block);
    }
  }

  return blocks;
}

// ─── CONVERTER: gọi convert_single.py ────────────────────────────────────────
function runConverter(rawCookie) {
  return new Promise((resolve) => {
    const scriptPath = path.join(__dirname, 'convert_single.py');
    const child = spawn(PYTHON_BIN, [scriptPath], { cwd: __dirname });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', () => {
      const out = stdout.trim();
      if (!out) {
        resolve({ error: `Checker không có output. Stderr: ${stderr.slice(-300)}` });
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ error: `Không parse được JSON output: ${out.slice(-200)}` });
      }
    });

    child.on('error', err => {
      resolve({ error: `Không thể chạy Python: ${err.message}` });
    });

    child.stdin.write(rawCookie);
    child.stdin.end();
  });
}

// ─── SHRESTHA.LIVE SCRAPER ────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeShrestha(country = null) {
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH
    || '/usr/bin/chromium'
    || '/usr/bin/chromium-browser';

  const browser = await puppeteer.launch({
    executablePath: execPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ],
    headless: 'new',
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    // Ghi đè clipboard TRƯỚC khi trang load
    await page.evaluateOnNewDocument(() => {
      window.__copiedTexts = [];
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (text) => { window.__copiedTexts.push(text); return Promise.resolve(); },
            readText:  () => Promise.resolve(''),
          },
        });
      } catch {}
      const _exec = document.execCommand.bind(document);
      document.execCommand = function(cmd, ...a) {
        if (cmd === 'copy') {
          const sel = window.getSelection();
          if (sel) window.__copiedTexts.push(sel.toString());
        }
        return _exec(cmd, ...a);
      };
    });

    // Bắt API response có chứa cookie data
    const apiBlocks = [];
    page.on('response', async (response) => {
      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('text')) return;
        const text = await response.text();
        if (
          (text.includes('NetflixId') || text.includes('SecureNetflixId')) &&
          text.includes('.netflix.com')
        ) {
          apiBlocks.push(text);
        }
      } catch {}
    });

    await page.goto('https://www.shrestha.live/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await sleep(6000);

    // Tìm kiếm quốc gia nếu có
    if (country) {
      const searchSelectors = [
        'input[placeholder*="SEARCH"]',
        'input[placeholder*="search"]',
        'input[placeholder*="country"]',
        'input[placeholder*="Country"]',
        'input[type="text"]',
        'input[type="search"]',
      ];

      let typed = false;
      for (const sel of searchSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(country, { delay: 80 });
            typed = true;
            break;
          }
        } catch {}
      }

      if (typed) {
        await sleep(2000);
        const resultClicked = await page.evaluate((c) => {
          const allEls = [...document.querySelectorAll('li, [class*="item"], [class*="result"], [class*="option"], [class*="country"]')];
          for (const el of allEls) {
            const t = (el.textContent || el.innerText || '').trim().toUpperCase();
            if (t.includes(c.toUpperCase())) {
              el.click();
              return true;
            }
          }
          return false;
        }, country);

        if (!resultClicked) await page.keyboard.press('Enter');
        await sleep(3000);
      }
    }

    await sleep(2000);

    // Bấm TẤT CẢ nút COPY
    const clickedCount = await page.evaluate(() => {
      let n = 0;
      const allEls = document.querySelectorAll(
        'button, [role="button"], [class*="copy"], [class*="Copy"], [onclick], span, div, a'
      );
      allEls.forEach(el => {
        const t = (el.textContent || el.innerText || el.value || '').trim().toUpperCase();
        if (t === 'COPY' || t === '📋 COPY' || t === 'COPY COOKIE') {
          try { el.click(); n++; } catch {}
        }
      });
      return n;
    });

    console.log(`[scrapeShrestha] Clicked ${clickedCount} COPY buttons`);
    await sleep(800 + clickedCount * 150);

    const copiedTexts = await page.evaluate(() => window.__copiedTexts || []);
    console.log(`[scrapeShrestha] Clipboard captured: ${copiedTexts.length} items`);

    // Fallback: quét DOM
    const domTexts = await page.evaluate(() => {
      const found = new Set();

      document.querySelectorAll('*').forEach(el => {
        if (el.children.length > 0) return;
        const t = (el.textContent || el.innerText || '').trim();
        if (t.length > 50 && t.includes('.netflix.com') &&
            (t.includes('NetflixId') || t.includes('SecureNetflixId'))) {
          found.add(t);
        }
      });

      document.querySelectorAll('pre, textarea, code').forEach(el => {
        const t = (el.value || el.textContent || el.innerText || '').trim();
        if (t.includes('.netflix.com') &&
            (t.includes('NetflixId') || t.includes('SecureNetflixId'))) {
          found.add(t);
        }
      });

      const bodyText = document.body.innerText || '';
      bodyText.split(/\n{2,}/).forEach(block => {
        if (block.includes('.netflix.com') &&
            (block.includes('NetflixId') || block.includes('SecureNetflixId'))) {
          found.add(block.trim());
        }
      });

      return [...found];
    });

    console.log(`[scrapeShrestha] DOM texts: ${domTexts.length}, API blocks: ${apiBlocks.length}`);

    const all = [...new Set([...copiedTexts, ...domTexts, ...apiBlocks])];
    return all.filter(t => t && (t.includes('NetflixId') || t.includes('SecureNetflixId')));

  } finally {
    await browser.close();
  }
}

// ─── DISCORD CLIENT ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Lấy link Netflix (PC hoặc Điện Thoại)'),

  new SlashCommandBuilder()
    .setName('upcookie')
    .setDescription('Upload file cookie thô vào bộ nhớ (Admin only)')
    .addAttachmentOption(opt =>
      opt.setName('file')
        .setDescription('File .txt chứa cookie Netflix (Netscape format)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('clearcookie')
    .setDescription('Xóa toàn bộ cookie trong bộ nhớ (Admin only)'),

  new SlashCommandBuilder()
    .setName('fetchcookie')
    .setDescription('Tự động lấy cookie từ shrestha.live vào bộ nhớ (Admin only)')
    .addStringOption(opt =>
      opt.setName('country')
        .setDescription('Tên quốc gia (ví dụ: France, Brazil) — bỏ trống = lấy tất cả')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Xem số cookie hiện còn trong bộ nhớ'),
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
    activities: [{
      name: count > 0 ? `🎬 ${count} cookie sẵn sàng` : '⏳ Tự động nạp khi cần',
      type: ActivityType.Watching,
    }],
  });
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  console.log(`🐍 Python binary: ${PYTHON_BIN}`);
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
      new ButtonBuilder()
        .setCustomId('btn_phone')
        .setLabel('📱 Link Điện Thoại')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('btn_pc')
        .setLabel('🖥️ Link Máy Tính')
        .setStyle(ButtonStyle.Primary),
    );

    const rowGuide = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('📖 Hướng Dẫn Điện Thoại')
        .setStyle(ButtonStyle.Link)
        .setURL('https://drive.google.com/drive/folders/1QAw4249og5hJuqF4jAcwCecTvyytv2jZ?usp=drive_link'),
      new ButtonBuilder()
        .setLabel('📖 Hướng Dẫn Máy Tính')
        .setStyle(ButtonStyle.Link)
        .setURL('https://drive.google.com/drive/folders/1S7bINLNLjy_Phmhc76DSugm1xgA44OJ_?usp=drive_link'),
    );

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('🎬 Netflix của Tún Kịt')
      .setDescription(
        '**Chọn loại link bạn muốn tạo:**\n\n' +
        '📱 **Điện Thoại** – Tối ưu cho mobile\n' +
        '🖥️ **Máy Tính** – Tối ưu cho desktop\n\n' +
        (count > 0
          ? `> 🗂️ Còn **${count}** cookie sẵn sàng\n\n`
          : `> ⚡ Sẽ tự động lấy cookie khi bạn bấm nút\n\n`
        ) +
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
        ? `🗂️ Hiện có **${count}** cookie trong bộ nhớ, sẵn sàng phát.`
        : `📭 Queue đang trống — bot sẽ tự scrape shrestha.live khi user bấm nút.`,
      ephemeral: true,
    });
    return;
  }

  // ── /clearcookie ───────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'clearcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền dùng lệnh này.', ephemeral: true });
      return;
    }

    const removed = clearCookies();
    updateStatus();
    await interaction.reply({
      content: `🗑️ Đã xóa **${removed}** cookie khỏi bộ nhớ. Queue hiện tại: **0**.`,
      ephemeral: true,
    });
    return;
  }

  // ── /fetchcookie ───────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'fetchcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền dùng lệnh này.', ephemeral: true });
      return;
    }

    const country = interaction.options.getString('country') || null;
    await interaction.deferReply({ ephemeral: true });

    try {
      await interaction.editReply(
        `🌐 Đang truy cập shrestha.live${country ? ` → **${country}**` : ''}...\n⏳ Quá trình mất ~30 giây, vui lòng chờ.`
      );

      const rawTexts = await scrapeShrestha(country);

      if (!rawTexts.length) {
        await interaction.editReply(
          '❌ Không tìm thấy cookie nào trên trang.\n' +
          '💡 Thử dùng tên tiếng Anh đúng chuẩn, ví dụ: `France`, `Brazil`, `United States`.\n' +
          'Hoặc dùng `/fetchcookie` không có country để lấy tất cả đang hiển thị.'
        );
        return;
      }

      const blocks = [];
      for (const text of rawTexts) {
        const parsed = parseCookieFileIntoBlocks(text);
        if (parsed.length > 0) {
          blocks.push(...parsed);
        } else if (text.includes('NetflixId') || text.includes('SecureNetflixId')) {
          blocks.push(text.trim());
        }
      }

      if (!blocks.length) {
        await interaction.editReply('❌ Tìm thấy dữ liệu nhưng không parse được cookie hợp lệ.');
        return;
      }

      const saved = pushCookies(blocks);
      updateStatus();

      await interaction.editReply(
        `✅ Đã nạp **${saved}** cookie vào bộ nhớ${country ? ` (${country})` : ''}.\n` +
        `🗂️ Tổng hiện tại: **${countCookies()}** cookie.`
      );
    } catch (err) {
      console.error('[fetchcookie]', err);
      await interaction.editReply(
        `❌ Lỗi khi scrape: ${err.message}\n` +
        `Kiểm tra lại Chromium đã được cài chưa (PUPPETEER_EXECUTABLE_PATH).`
      );
    }
    return;
  }

  // ── /upcookie ──────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'upcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền dùng lệnh này.', ephemeral: true });
      return;
    }

    const attachment = interaction.options.getAttachment('file');
    if (!attachment.name.toLowerCase().endsWith('.txt')) {
      await interaction.reply({ content: '❌ Chỉ nhận file `.txt` chứa cookie Netflix.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const res    = await axios.get(attachment.url, { responseType: 'text', timeout: 10_000 });
      const blocks = parseCookieFileIntoBlocks(res.data);

      if (!blocks.length) {
        await interaction.editReply(
          '❌ Không tìm thấy cookie hợp lệ trong file.\n' +
          'File phải chứa các dòng `.netflix.com` (Netscape format) có `NetflixId` hoặc `SecureNetflixId`.',
        );
        return;
      }

      const saved = pushCookies(blocks);
      updateStatus();
      await interaction.editReply(
        `✅ Đã thêm **${saved}** cookie vào bộ nhớ.\n🗂️ Tổng hiện tại: **${countCookies()}** cookie.`,
      );
    } catch (err) {
      await interaction.editReply(`❌ Lỗi: ${err.message}`);
      console.error('[upcookie]', err);
    }
    return;
  }

  // ── Button clicks ──────────────────────────────────────────────────────────
  if (interaction.isButton() &&
      (interaction.customId === 'btn_phone' || interaction.customId === 'btn_pc')) {

    const mode = interaction.customId === 'btn_phone' ? 'phone' : 'pc';
    await interaction.deferReply();

    // Nếu queue rỗng → tự động scrape shrestha.live
    if (countCookies() === 0) {
      await interaction.editReply('⏳ Kho trống — đang tự động lấy cookie từ shrestha.live...');

      const added = await autoRefill();

      if (added === 0) {
        await interaction.editReply(
          '❌ Không lấy được cookie từ shrestha.live.\n' +
          'Vui lòng thử lại sau hoặc ping admin **Tún Kịt** để upload thủ công.',
        );
        return;
      }

      await interaction.editReply(`✅ Đã nạp **${added}** cookie — đang tạo link của bạn...`);
    } else {
      await interaction.editReply('⏳ Đang tạo link NFToken, vui lòng chờ...');
    }

    // Pop 1 cookie từ memory queue
    const rawCookie = popCookie();
    if (!rawCookie) {
      await interaction.editReply('❌ Hết cookie! Vui lòng thử lại.');
      return;
    }

    updateStatus();

    // Chạy checker Python
    const result = await runConverter(rawCookie);

    if (result.error) {
      console.error('[runConverter] error:', result.error, result.detail || '');
      await interaction.editReply(
        `🍪❌ Cookie bị lỗi, vui lòng bấm lại để nhận token mới — còn **${countCookies()}** cookie khác.`,
      );
      return;
    }

    const link = mode === 'phone' ? result.phone_link : result.pc_link;

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Tạo Link Thành Công!')
      .addFields(
        { name: '📧 Email',                               value: `\`${result.email || '??'}\``,   inline: true },
        { name: `${planToEmoji(result.plan)} Plan`,       value: result.plan    || '??',           inline: true },
        { name: '🌍 Country',                             value: result.country || '??',           inline: true },
        {
          name:  mode === 'phone' ? '📱 Link Điện Thoại' : '🖥️ Link Máy Tính',
          value: link || '(không có link)',
        },
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