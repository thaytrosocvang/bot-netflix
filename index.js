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
const DATABASE_URL      = process.env.DATABASE_URL;

// ─── POSTGRESQL ───────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cookie_queue (
      id         SERIAL PRIMARY KEY,
      email      TEXT,
      plan       TEXT,
      country    TEXT,
      pc_link    TEXT NOT NULL,
      phone_link TEXT NOT NULL,
      added_at   TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ DB ready');
}

async function countCookies() {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM cookie_queue');
  return parseInt(rows[0].cnt, 10);
}

/** Lấy 1 entry đầu hàng rồi xoá luôn (atomic) */
async function popEntry() {
  const { rows } = await pool.query(`
    DELETE FROM cookie_queue
    WHERE id = (SELECT id FROM cookie_queue ORDER BY id ASC LIMIT 1)
    RETURNING *
  `);
  return rows[0] || null;
}

async function pushEntries(entries) {
  if (!entries.length) return 0;
  const values = entries.map((_, i) =>
    `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
  ).join(', ');
  const params = entries.flatMap(e => [e.email, e.plan, e.country, e.pcLink, e.phoneLink]);
  await pool.query(
    `INSERT INTO cookie_queue (email, plan, country, pc_link, phone_link) VALUES ${values}`,
    params,
  );
  return entries.length;
}

// ─── PARSER: Netflix Checker output format ────────────────────────────────────
/**
 * Parse file output từ Netflix Cookie Checker.
 * Mỗi block trông như sau:
 *
 *   NETFLIX HIT : ⚙
 *   Name: Geni
 *   Email: genisafir01@gmail.com
 *   Country: US
 *   Plan: Premium
 *   ...
 *   NFToken DETAILS : ⚙
 *   NFToken: xxx
 *   PC Login: https://www.netflix.com/?nftoken=xxx
 *   Phone Login: https://www.netflix.com/unsupported?nftoken=xxx
 *   Valid Till (UTC): ...
 *   ---...
 */
function parseCheckerOutput(rawText) {
  const entries = [];
  const lines   = rawText.split(/\r?\n/);

  let inBlock  = false;
  let current  = {};

  function flush() {
    if (current.pcLink && current.phoneLink) {
      entries.push({ ...current });
    }
    current = {};
    inBlock = false;
  }

  for (const line of lines) {
    const t = line.trim();

    // Bắt đầu block mới
    if (/^NETFLIX HIT/i.test(t)) {
      if (inBlock) flush();
      inBlock = true;
      current = {};
      continue;
    }

    if (!inBlock) continue;

    // Dấu phân cách → kết thúc block
    if (/^-{10,}/.test(t)) {
      flush();
      continue;
    }

    // Trích thông tin
    const emailM   = t.match(/^Email:\s*(.+)/i);
    const planM    = t.match(/^Plan:\s*(.+)/i);
    const countryM = t.match(/^Country:\s*(.+)/i);
    const pcM      = t.match(/^PC Login:\s*(https?:\/\/\S+)/i);
    const phoneM   = t.match(/^Phone Login:\s*(https?:\/\/\S+)/i);

    if (emailM)   current.email    = emailM[1].trim();
    if (planM)    current.plan     = planM[1].trim();
    if (countryM) current.country  = countryM[1].trim();
    if (pcM)      current.pcLink   = pcM[1].trim();
    if (phoneM)   current.phoneLink = phoneM[1].trim();
  }

  // Flush block cuối nếu file không kết thúc bằng dashes
  if (inBlock) flush();

  return entries;
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
    .setDescription('Upload file output từ Netflix Checker (Admin only)')
    .addAttachmentOption(opt =>
      opt.setName('file')
        .setDescription('File .txt output từ Netflix Cookie Checker')
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
      name: count > 0 ? `🎬 ${count} link sẵn sàng` : '❌ Hết link — chờ admin',
      type: ActivityType.Watching,
    }],
  });
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
        `> 🗂️ Còn **${count}** link trong kho`,
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
      await interaction.reply({ content: '❌ Chỉ nhận file `.txt` output từ Netflix Checker.' });
      return;
    }

    await interaction.deferReply();

    try {
      const res     = await axios.get(attachment.url, { responseType: 'text', timeout: 10_000 });
      const entries = parseCheckerOutput(res.data);

      if (!entries.length) {
        await interaction.editReply(
          '❌ Không tìm thấy link hợp lệ trong file.\n' +
          'Đảm bảo file là output từ **Netflix Cookie Checker** có dòng `PC Login:` và `Phone Login:`.',
        );
        return;
      }

      const saved = await pushEntries(entries);
      await updateStatus();
      const total = await countCookies();
      await interaction.editReply(
        `✅ Đã thêm **${saved}** link vào hàng đợi.\n🗂️ Tổng hiện tại: **${total}** link.`,
      );
    } catch (err) {
      await interaction.editReply(`❌ Lỗi: ${err.message}`);
      console.error('[upcookie]', err);
    }
    return;
  }

  // ── Button clicks ──────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const mode = interaction.customId === 'btn_phone' ? 'phone' : 'pc';
    await interaction.deferReply();

    const count = await countCookies();
    if (count === 0) {
      await interaction.editReply(
        '❌ Hết link cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.',
      );
      return;
    }

    const entry = await popEntry();
    if (!entry) {
      await interaction.editReply(
        '❌ Hết link cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.',
      );
      return;
    }

    const link = mode === 'phone' ? entry.phone_link : entry.pc_link;

    const embed = new EmbedBuilder()
      .setColor(0xe50914)
      .setTitle('✅ Tạo Link Thành Công!')
      .addFields(
        { name: '📧 Email',                            value: `\`${entry.email || '??'}\``, inline: true },
        { name: `${planToEmoji(entry.plan)} Plan`,     value: entry.plan    || '??',        inline: true },
        { name: '🌍 Country',                          value: entry.country || '??',        inline: true },
        {
          name:  mode === 'phone' ? '📱 Link Điện Thoại' : '🖥️ Link Máy Tính',
          value: `[Mở Link](${link})\n\`${link}\``,
        },
      )
      .setFooter({ text: `DINO STORE NETFLIX • ${new Date().toLocaleTimeString('vi-VN')}` });

    await interaction.editReply({ embeds: [embed] });
    await updateStatus();
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('❌ Thiếu DISCORD_TOKEN hoặc DISCORD_CLIENT_ID trong .env');
  process.exit(1);
}
client.login(DISCORD_TOKEN);