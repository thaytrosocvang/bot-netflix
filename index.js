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
import pg from 'pg';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── ENV ──────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const ADMIN_IDS         = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const DATABASE_URL      = process.env.DATABASE_URL;

// ─── PYTHON BINARY ────────────────────────────────────────────────────────────
// Ưu tiên dùng Python từ venv (Docker), fallback sang python3 / python
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
      return p; // system PATH binary
    }
  }
  return 'python3';
})();

// ─── POSTGRESQL ───────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  // Bảng lưu raw cookie (Netscape format) chờ xử lý
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cookie_queue (
      id         SERIAL PRIMARY KEY,
      raw_cookie TEXT NOT NULL,
      added_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ DB ready');
}

async function countCookies() {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM cookie_queue');
  return parseInt(rows[0].cnt, 10);
}

/** Lấy 1 cookie đầu hàng rồi xoá luôn (atomic) */
async function popCookie() {
  const { rows } = await pool.query(`
    DELETE FROM cookie_queue
    WHERE id = (SELECT id FROM cookie_queue ORDER BY id ASC LIMIT 1)
    RETURNING *
  `);
  return rows[0] || null;
}

/** Lưu danh sách raw cookie blocks vào DB */
async function pushCookies(blocks) {
  if (!blocks.length) return 0;
  const values = blocks.map((_, i) => `($${i + 1})`).join(', ');
  const params = blocks;
  await pool.query(
    `INSERT INTO cookie_queue (raw_cookie) VALUES ${values}`,
    params,
  );
  return blocks.length;
}

// ─── PARSER: tách file cookie thô thành từng block ───────────────────────────
/**
 * File cookie upload (image 2 format) có dạng:
 *   - Email: xxx
 *   - Plan: xxx
 *   ...
 *   .netflix.com  TRUE  /  TRUE  timestamp  NetflixId  xxx
 *   .netflix.com  TRUE  /  TRUE  timestamp  gsid  xxx
 *   ...
 *   (dòng trống)
 *   - Email: ...  (block tiếp theo)
 *
 * Hàm này trích xuất từng nhóm dòng .netflix.com liên tiếp thành 1 block.
 * Mỗi block = raw cookie của 1 tài khoản (Netscape format).
 */
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
        // Kết thúc 1 block cookie — kiểm tra có đủ NetflixId không
        const block = currentLines.join('\n');
        if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) {
          blocks.push(block);
        }
        currentLines = [];
      }
    }
  }

  // Flush block cuối
  if (currentLines.length > 0) {
    const block = currentLines.join('\n');
    if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) {
      blocks.push(block);
    }
  }

  return blocks;
}

// ─── CONVERTER: gọi convert_single.py ────────────────────────────────────────
/**
 * Truyền raw cookie text vào convert_single.py qua stdin.
 * Trả về { email, plan, country, pc_link, phone_link } hoặc { error }.
 */
function runConverter(rawCookie) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'convert_single.py');

    const child = spawn(PYTHON_BIN, [scriptPath], {
      cwd: __dirname,
    });

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

    // Ghi cookie vào stdin rồi đóng
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

    // Chặn tài nguyên nặng để load nhanh hơn
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Ghi đè clipboard để bắt nội dung nút COPY
    await page.evaluateOnNewDocument(() => {
      window.__copiedTexts = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: (text) => {
            window.__copiedTexts.push(text);
            return Promise.resolve();
          },
          readText: () => Promise.resolve(''),
        },
      });
    });

    await page.goto('https://www.shrestha.live/', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });

    // Nếu có country → tìm kiếm và click
    if (country) {
      const searchSel = 'input[placeholder*="SEARCH"], input[placeholder*="search"], input[placeholder*="Search"]';
      try {
        await page.waitForSelector(searchSel, { timeout: 8000 });
        await page.click(searchSel);
        await page.type(searchSel, country, { delay: 80 });
        await sleep(1800);

        // Click vào kết quả đầu tiên trong dropdown
        const dropdownItem = await page.$(
          '[class*="result"]:first-child, [class*="suggestion"]:first-child, ' +
          '[class*="dropdown"] li:first-child, [class*="list"] li:first-child'
        );
        if (dropdownItem) {
          await dropdownItem.click();
        } else {
          // Thử nhấn Enter
          await page.keyboard.press('Enter');
        }
        await sleep(2500);
      } catch (e) {
        console.warn('[scrapeShrestha] Không tìm thấy ô search:', e.message);
      }
    }

    // Đợi các card cookie load xong
    await sleep(3000);

    // Bấm toàn bộ nút COPY trên trang
    const clickedCount = await page.evaluate(() => {
      let count = 0;
      document.querySelectorAll('button').forEach(btn => {
        const t = (btn.textContent || btn.innerText || '').trim().toUpperCase();
        if (t === 'COPY' || t.includes('COPY')) {
          btn.click();
          count++;
        }
      });
      return count;
    });

    // Chờ clipboard xử lý xong
    await sleep(500 + clickedCount * 100);

    // Lấy tất cả text đã copy
    const copiedTexts = await page.evaluate(() => window.__copiedTexts || []);

    // Fallback: tìm trực tiếp trong DOM các dòng .netflix.com
    const domTexts = await page.evaluate(() => {
      const found = new Set();
      document.querySelectorAll('pre, textarea, code, [class*="cookie"], [class*="raw"]').forEach(el => {
        const t = el.innerText || el.textContent || '';
        if (t.includes('.netflix.com') && (t.includes('NetflixId') || t.includes('SecureNetflixId'))) {
          found.add(t.trim());
        }
      });
      return [...found];
    });

    const all = [...copiedTexts, ...domTexts];
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
    .setDescription('Upload file cookie thô cho bot (Admin only)')
    .addAttachmentOption(opt =>
      opt.setName('file')
        .setDescription('File .txt chứa cookie Netflix (Netscape format)')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('clearcookie')
    .setDescription('Xóa toàn bộ cookie trong kho (Admin only)'),

  new SlashCommandBuilder()
    .setName('fetchcookie')
    .setDescription('Tự động lấy cookie từ shrestha.live (Admin only)')
    .addStringOption(opt =>
      opt.setName('country')
        .setDescription('Tên quốc gia (ví dụ: France, Brazil, US) — bỏ trống = lấy tất cả đang hiển thị')
        .setRequired(false)
    ),
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

async function updateStatus() {
  const count = await countCookies();
  client.user.setPresence({
    status: 'idle',
    activities: [{
      name: count > 0 ? `🎬 ${count} cookie sẵn sàng` : '❌ Hết cookie — chờ admin',
      type: ActivityType.Watching,
    }],
  });
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  console.log(`🐍 Python binary: ${PYTHON_BIN}`);
  await initDB();
  await registerCommands();
  await updateStatus();
});

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── /start ─────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
    const count = await countCookies();

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
        `> 🗂️ Còn **${count}** cookie trong kho\n\n` +
        '> ⚠️ Nếu acc không xem được pls log out và đổi qua acc khác, ping admin nếu có thắc mắc',
      )
      .setFooter({ text: 'Bot by Sếp Tún Kịt' });

    await interaction.reply({ embeds: [embed], components: [row, rowGuide] });
    return;
  }

  // ── /clearcookie ───────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'clearcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền dùng lệnh này.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const before = await countCookies();
      await pool.query('DELETE FROM cookie_queue');
      await updateStatus();
      await interaction.editReply(
        `🗑️ Đã xóa toàn bộ **${before}** cookie khỏi kho!\n✅ Kho hiện tại: **0** cookie.`,
      );
    } catch (err) {
      await interaction.editReply(`❌ Lỗi khi xóa cookie: ${err.message}`);
      console.error('[clearcookie]', err);
    }
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
          'Có thể tên quốc gia không đúng hoặc trang đang bảo trì.'
        );
        return;
      }

      // Parse từng text thành cookie blocks (mỗi text có thể là 1 block hoặc nhiều blocks)
      const blocks = [];
      for (const text of rawTexts) {
        const parsed = parseCookieFileIntoBlocks(text);
        if (parsed.length > 0) {
          blocks.push(...parsed);
        } else if (text.includes('NetflixId') || text.includes('SecureNetflixId')) {
          // Text đã là 1 block hoàn chỉnh
          blocks.push(text.trim());
        }
      }

      if (!blocks.length) {
        await interaction.editReply('❌ Tìm thấy dữ liệu nhưng không parse được cookie hợp lệ.');
        return;
      }

      const saved = await pushCookies(blocks);
      await updateStatus();
      const total = await countCookies();

      await interaction.editReply(
        `✅ Đã lấy và lưu **${saved}** cookie từ shrestha.live${country ? ` (${country})` : ''}.\n` +
        `🗂️ Tổng kho hiện tại: **${total}** cookie.`
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

      const saved = await pushCookies(blocks);
      await updateStatus();
      const total = await countCookies();
      await interaction.editReply(
        `✅ Đã thêm **${saved}** cookie vào hàng đợi.\n🗂️ Tổng hiện tại: **${total}** cookie.`,
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

    // Kiểm tra còn cookie không
    const count = await countCookies();
    if (count === 0) {
      await interaction.editReply(
        '❌ Hết cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.',
      );
      return;
    }

    // Pop 1 cookie — sẽ bị xóa khỏi DB ngay lập tức
    const entry = await popCookie();
    if (!entry) {
      await interaction.editReply(
        '❌ Hết cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.',
      );
      return;
    }

    // Thông báo đang xử lý
    await interaction.editReply('⏳ Đang tạo link NFToken, vui lòng chờ...');

    // Chạy checker Python
    const result = await runConverter(entry.raw_cookie);
    await updateStatus();

    // Xử lý lỗi từ checker
    if (result.error) {
      console.error('[runConverter] error:', result.error, result.detail || '');
      await interaction.editReply(
        `🍪❌ Cookie bị lỗi, vui lòng bấm lại để nhận token mới — còn **${await countCookies()}** cookie khác.`,
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
          value: link,
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