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

    const embed = new EmbedBuilder()
      .setColor(0xe50914)
      .setTitle('🎬 Netflix Link Generator')
      .setDescription(
        '**Chọn loại link bạn muốn tạo:**\n\n' +
        '📱 **Điện Thoại** – Tối ưu cho mobile\n' +
        '🖥️ **Máy Tính** – Tối ưu cho desktop\n\n' +
        `> 🗂️ Còn **${count}** cookie trong kho`,
      )
      .setFooter({ text: 'Bot by DINO STORE NETFLIX' });

    await interaction.reply({ embeds: [embed], components: [row] });
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
        `❌ Cookie không hợp lệ hoặc đã hết hạn. (${result.error})\n` +
        `Cookie đã bị xóa. Vui lòng thử lại — còn **${await countCookies()}** cookie khác.`,
      );
      return;
    }

    const link = mode === 'phone' ? result.phone_link : result.pc_link;

    // Guard: link rỗng (checker chỉ tạo được 1 loại token)
    if (!link) {
      const fallbackLink = mode === 'phone' ? result.pc_link : result.phone_link;
      const fallbackName = mode === 'phone' ? '🖥️ Link Máy Tính' : '📱 Link Điện Thoại';
      if (fallbackLink) {
        await interaction.editReply(
          `⚠️ Không tạo được link ${mode === 'phone' ? 'Điện Thoại' : 'PC'} cho cookie này.\n` +
          `Sử dụng ${fallbackName} thay thế:\n\`${fallbackLink}\``,
        );
      } else {
        await interaction.editReply(
          `❌ Cookie này không tạo được link NFToken. Cookie đã bị xóa.\n` +
          `Còn **${await countCookies()}** cookie khác — vui lòng thử lại.`,
        );
      }
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xe50914)
      .setTitle('✅ Tạo Link Thành Công!')
      .addFields(
        { name: '📧 Email',                               value: `\`${result.email || '??'}\``,   inline: true },
        { name: `${planToEmoji(result.plan)} Plan`,       value: result.plan    || '??',           inline: true },
        { name: '🌍 Country',                             value: result.country || '??',           inline: true },
        {
          name:  mode === 'phone' ? '📱 Link Điện Thoại' : '🖥️ Link Máy Tính',
          value: `[Mở Link](${link})\n\`${link}\``,
        },
      )
      .setFooter({ text: `DINO STORE NETFLIX • ${new Date().toLocaleTimeString('vi-VN')}` });

    await interaction.editReply({ content: '', embeds: [embed] });
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('❌ Thiếu DISCORD_TOKEN hoặc DISCORD_CLIENT_ID trong .env');
  process.exit(1);
}
client.login(DISCORD_TOKEN);