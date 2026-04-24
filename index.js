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
const DATABASE_URL      = process.env.DATABASE_URL; // Railway tự inject

// ─── POSTGRESQL ───────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cookie_queue (
      id         SERIAL PRIMARY KEY,
      raw_cookie TEXT    NOT NULL,
      email      TEXT,
      plan       TEXT,
      added_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ DB ready');
}

/** Lấy số lượng cookie còn lại */
async function countCookies() {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM cookie_queue');
  return parseInt(rows[0].cnt, 10);
}

/** Lấy 1 cookie đầu hàng (FIFO) rồi XÓA luôn */
async function popCookie() {
  const { rows } = await pool.query(`
    DELETE FROM cookie_queue
    WHERE id = (SELECT id FROM cookie_queue ORDER BY id ASC LIMIT 1)
    RETURNING *
  `);
  return rows[0] || null;
}

/** Lưu nhiều cookie vào DB */
async function pushCookies(blocks) {
  if (!blocks.length) return 0;
  const values = blocks.map((b, i) =>
    `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`
  ).join(', ');
  const params = blocks.flatMap(b => [b.raw, b.email || null, b.plan || null]);
  await pool.query(
    `INSERT INTO cookie_queue (raw_cookie, email, plan) VALUES ${values}`,
    params,
  );
  return blocks.length;
}

// ─── COOKIE FILE PARSER ───────────────────────────────────────────────────────
/**
 * Tách file txt chứa nhiều cookie block thành mảng.
 * Mỗi block = phần metadata (– Email:...) + dòng Netscape (.netflix.com\t...)
 *
 * Format ví dụ:
 *   – Email: xxx@gmail.com
 *   – Plan: Standard
 *   ...
 *   .netflix.com   TRUE  /  TRUE  12345  NetflixId  xxx
 *   .netflix.com   TRUE  /  TRUE  12345  SecureNetflixId  xxx
 *   (dòng trống)
 *   – Email: yyy@gmail.com   ← block tiếp theo
 */
function parseMultiCookieFile(rawText) {
  const blocks  = [];
  const lines   = rawText.split(/\r?\n/);
  let current   = null; // { metaLines, cookieLines }

  function flushBlock() {
    if (!current) return;
    const cookieLines = current.cookieLines.filter(l => l.trim());
    if (!cookieLines.length) return;

    // Ghép lại thành Netscape format chuẩn (chỉ các dòng cookie thật)
    const raw = cookieLines.join('\n');

    // Trích email và plan từ metadata
    const emailLine = current.metaLines.find(l => /email/i.test(l));
    const planLine  = current.metaLines.find(l => /plan/i.test(l));

    const email = emailLine ? emailLine.replace(/.*:\s*/, '').trim() : null;
    const plan  = planLine  ? planLine.replace(/.*:\s*/, '').trim() : null;

    blocks.push({ raw, email, plan });
    current = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Dòng bắt đầu block mới (dòng metadata – Email:)
    if (/^[–\-—]\s*Email:/i.test(trimmed)) {
      flushBlock();
      current = { metaLines: [trimmed], cookieLines: [] };
      continue;
    }

    if (!current) continue;

    // Dòng metadata khác (– Plan:, – Country:...)
    if (/^[–\-—]\s*\w+:/.test(trimmed)) {
      current.metaLines.push(trimmed);
      continue;
    }

    // Dòng Netscape cookie (.netflix.com\t...)
    if (trimmed.startsWith('.netflix.com') || trimmed.startsWith('#')) {
      current.cookieLines.push(trimmed);
      continue;
    }

    // Dòng trống = kết thúc block hiện tại
    if (!trimmed) {
      flushBlock();
    }
  }

  flushBlock(); // flush block cuối nếu file không kết thúc bằng dòng trống
  return blocks;
}

// ─── COOKIE HELPERS ───────────────────────────────────────────────────────────
function parseCookieLines(raw) {
  const cookies = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    cookies[parts[5].trim()] = parts[6].trim();
  }
  return cookies;
}

function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
}

function generateTvCode(nftoken) {
  return nftoken.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8);
}

function buildLinks(nftoken) {
  return {
    phone: `https://www.netflix.com/unsupported?nftoken=${nftoken}`,
    pc:    `https://www.netflix.com/?nftoken=${nftoken}`,
    tv:    generateTvCode(nftoken),
  };
}

async function convertCookieToNFToken(cookieHeader, mode = 'both') {
  const headers = {
    Cookie: cookieHeader,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.netflix.com/',
  };
  const cfg = { headers, timeout: 15_000 };

  const acct = await axios.get('https://www.netflix.com/YourAccount', cfg);
  if (!acct.data.includes('netflix-sans')) throw new Error('INVALID_COOKIE');

  const email   = acct.data.match(/"emailAddress"\s*:\s*"([^"]+)"/)?.[1]   || '??';
  const plan    = acct.data.match(/"planName"\s*:\s*"([^"]+)"/)?.[1]        || '??';
  const country = acct.data.match(/"countryOfSignup"\s*:\s*"([^"]+)"/)?.[1] || '??';

  const tok = await axios.get('https://www.netflix.com/api/mre/login-with-token/v1', {
    ...cfg,
    params: {
      appName:     mode === 'mobile' ? 'nflx-android-app' : 'nflx-web',
      deviceModel: mode === 'mobile' ? 'phone' : 'browser',
    },
  });

  if (!tok.data?.nftoken) throw new Error('TOKEN_FETCH_FAILED');
  return { email, plan, country, nftoken: tok.data.nftoken, links: buildLinks(tok.data.nftoken) };
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
    .setDescription('Hiển thị bảng chọn thiết bị để lấy link Netflix'),

  new SlashCommandBuilder()
    .setName('upcookie')
    .setDescription('Upload file TXT chứa nhiều cookie (Admin only)')
    .addAttachmentOption(opt =>
      opt.setName('file')
        .setDescription('File .txt chứa nhiều cookie block')
        .setRequired(true)
    ),
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID)
      : Routes.applicationCommands(DISCORD_CLIENT_ID);
    await rest.put(route, { body: commands });
    console.log(`✅ Đã đăng ký ${commands.length} slash commands`);
  } catch (err) {
    console.error('❌ Lỗi đăng ký commands:', err.message);
  }
}

// ─── HELPERS UI ───────────────────────────────────────────────────────────────
function planToEmoji(plan) {
  const p = (plan || '').toLowerCase();
  if (p.includes('premium'))  return '💎';
  if (p.includes('standard')) return '⭐';
  if (p.includes('basic'))    return '🔵';
  if (p.includes('mobile'))   return '📱';
  return '🎬';
}

function friendlyError(msg) {
  return {
    INVALID_COOKIE:          'Cookie không hợp lệ hoặc đã hết hạn.',
    TOKEN_FETCH_FAILED:      'Không lấy được NFToken. Thử lại sau.',
    MISSING_NETFLIX_COOKIES: 'Cookie thiếu `NetflixId`. Kiểm tra lại file.',
  }[msg] || `Lỗi: ${msg}`;
}

function buildResultEmbed(result, mode) {
  const { email, plan, country, links } = result;
  const embed = new EmbedBuilder()
    .setColor(0xe50914)
    .setTitle('✅ Tạo Link Thành Công!')
    .addFields(
      { name: '📧 Email',                  value: `\`${email}\``, inline: true },
      { name: `${planToEmoji(plan)} Plan`, value: plan,            inline: true },
      { name: '🌍 Country',                value: country,         inline: true },
    )
    .setFooter({ text: `DINO STORE NETFLIX • ${new Date().toLocaleTimeString('vi-VN')}` });

  if (mode === 'mobile' || mode === 'both')
    embed.addFields({ name: '📱 Link Điện Thoại', value: `[Mở Link](${links.phone})\n\`${links.phone}\`` });
  if (mode === 'pc' || mode === 'both')
    embed.addFields({ name: '🖥️ Link Máy Tính',   value: `[Mở Link](${links.pc})\n\`${links.pc}\`` });
  if (mode === 'tv' || mode === 'both')
    embed.addFields({ name: '📺 TV Code',          value: `\`\`\`${links.tv}\`\`\`` });

  return embed;
}

/** Cập nhật status bot theo số cookie còn lại */
async function updateStatus() {
  const count = await countCookies();
  if (count === 0) {
    client.user.setPresence({
      status: 'idle',
      activities: [{ name: '❌ Hết cookie — chờ admin upload', type: ActivityType.Watching }],
    });
  } else {
    client.user.setPresence({
      status: 'idle',
      activities: [{ name: `🎬 ${count} cookie sẵn sàng`, type: ActivityType.Watching }],
    });
  }
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
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
      new ButtonBuilder().setCustomId('btn_phone').setLabel('📱 Link Điện Thoại').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('btn_pc')   .setLabel('🖥️ Link Máy Tính')  .setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('btn_tv')   .setLabel('📺 TV Code')         .setStyle(ButtonStyle.Secondary),
    );

    const embed = new EmbedBuilder()
      .setColor(0xe50914)
      .setTitle('🎬 Netflix Link Generator')
      .setDescription(
        '**Chọn loại link bạn muốn tạo:**\n\n' +
        '📱 **Điện Thoại** – Tối ưu cho mobile\n' +
        '🖥️ **Máy Tính** – Tối ưu cho desktop\n' +
        '📺 **TV** – Mã TV 8 ký tự\n\n' +
        `> 🗂️ Còn **${count}** cookie trong kho`,
      )
      .setFooter({ text: 'Bot by DINO STORE NETFLIX' });

    await interaction.reply({ embeds: [embed], components: [row] });
    return;
  }

  // ── /upcookie ──────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'upcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: '❌ Bạn không có quyền dùng lệnh này.' });
      return;
    }

    const attachment = interaction.options.getAttachment('file');
    if (!attachment.name.toLowerCase().endsWith('.txt')) {
      await interaction.reply({ content: '❌ Chỉ nhận file `.txt`.' });
      return;
    }

    await interaction.deferReply();

    try {
      const res     = await axios.get(attachment.url, { responseType: 'text', timeout: 10_000 });
      const blocks  = parseMultiCookieFile(res.data);

      if (!blocks.length) {
        await interaction.editReply('❌ Không tìm thấy cookie hợp lệ trong file. Kiểm tra lại format.');
        return;
      }

      const saved = await pushCookies(blocks);
      await updateStatus();
      await interaction.editReply(`✅ Đã thêm **${saved}** cookie vào hàng đợi. Tổng hiện tại: **${await countCookies()}** cookie.`);
    } catch (err) {
      await interaction.editReply(`❌ Lỗi: ${err.message}`);
      console.error('[upcookie]', err);
    }
    return;
  }

  // ── Button clicks ──────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const modeMap = { btn_phone: 'mobile', btn_pc: 'pc', btn_tv: 'tv' };
    const mode    = modeMap[interaction.customId];
    if (!mode) return;

    await interaction.deferReply();

    // Kiểm tra hết cookie
    const count = await countCookies();
    if (count === 0) {
      await interaction.editReply(
        '❌ Hết link cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.',
      );
      return;
    }

    // Pop cookie đầu tiên khỏi DB
    const row = await popCookie();
    if (!row) {
      await interaction.editReply('❌ Hết link cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.');
      return;
    }

    try {
      const cookies = parseCookieLines(row.raw_cookie);

      if (!cookies['NetflixId'] && !cookies['authURL']) {
        // Cookie này lỗi → thử pop cái tiếp theo không, chỉ báo lỗi
        await interaction.editReply('⚠️ Cookie vừa lấy bị lỗi và đã bị xoá. Thử lại để lấy cookie khác.');
        await updateStatus();
        return;
      }

      const result = await convertCookieToNFToken(buildCookieHeader(cookies), mode);
      await interaction.editReply({ embeds: [buildResultEmbed(result, mode)] });
    } catch (err) {
      await interaction.editReply(`❌ ${friendlyError(err.message)}`);
      console.error('[button]', err.message);
    }

    // Cập nhật status sau mỗi lần dùng
    await updateStatus();
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('❌ Thiếu DISCORD_TOKEN hoặc DISCORD_CLIENT_ID trong .env');
  process.exit(1);
}
client.login(DISCORD_TOKEN);