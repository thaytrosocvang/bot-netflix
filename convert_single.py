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

// ─── PYTHON BINARY (Windows compatible) ──────────────────────────────────────
const PYTHON_BIN = (() => {
  const candidates = [
    path.join(__dirname, 'venv', 'Scripts', 'python.exe'),
    path.join(__dirname, 'venv', 'bin', 'python3'),
    path.join(__dirname, 'venv', 'bin', 'python'),
    'python',
    'python3',
  ];
  for (const p of candidates) {
    if (p.includes('venv')) {
      if (fs.existsSync(p)) return p;
    } else {
      return p;
    }
  }
  return 'python';
})();

// ─── IN-MEMORY COOKIE QUEUE ───────────────────────────────────────────────────
const cookieQueue = [];
const countCookies = () => cookieQueue.length;
const popCookie    = () => cookieQueue.shift() || null;
const pushCookies  = (blocks) => { cookieQueue.push(...blocks); return blocks.length; };
const clearCookies = () => { const n = cookieQueue.length; cookieQueue.length = 0; return n; };
const requeueCookie = (block) => { cookieQueue.push(block); }; // đẩy lại cuối queue

// ─── PARSER ───────────────────────────────────────────────────────────────────
function parseCookieFileIntoBlocks(rawText) {
  const blocks = [];
  const lines  = rawText.split(/\r?\n/);
  let cur = [];

  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('.netflix.com') || t.startsWith('netflix.com')) {
      cur.push(line);
    } else {
      if (cur.length > 0) {
        const block = cur.join('\n');
        if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) blocks.push(block);
        cur = [];
      }
    }
  }
  if (cur.length > 0) {
    const block = cur.join('\n');
    if (/NetflixId/i.test(block) || /SecureNetflixId/i.test(block)) blocks.push(block);
  }
  return blocks;
}

// ─── CONVERTER ────────────────────────────────────────────────────────────────
function runConverter(rawCookie) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [path.join(__dirname, 'convert_single.py')], {
      cwd: __dirname,
      shell: process.platform === 'win32', // cần trên Windows
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', () => {
      const out = stdout.trim();
      if (!out) return resolve({ error: `Không có output`, detail: stderr.slice(-300) });
      try { resolve(JSON.parse(out)); }
      catch { resolve({ error: `Không parse được JSON`, detail: out.slice(-200) }); }
    });
    child.on('error', err => resolve({ error: `Không thể chạy Python: ${err.message}` }));
    child.stdin.write(rawCookie);
    child.stdin.end();
  });
}

// ─── DISCORD CLIENT ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Lấy link Netflix (PC hoặc Điện Thoại)'),

  new SlashCommandBuilder()
    .setName('upcookie')
    .setDescription('Upload file cookie cho bot (Admin only)')
    .addAttachmentOption(opt =>
      opt.setName('file').setDescription('File .txt chứa cookie Netflix (Netscape format)').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('clearcookie')
    .setDescription('Xóa toàn bộ cookie trong kho (Admin only)'),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Xem số cookie đang có trong kho'),
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
    status: count > 0 ? 'online' : 'idle',
    activities: [{
      name: count > 0 ? `🎬 ${count} cookie sẵn sàng` : '❌ Hết cookie — chờ admin',
      type: ActivityType.Streaming,
      url: 'https://www.twitch.tv/tunkit2302',
    }],
  });
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  console.log(`🐍 Python: ${PYTHON_BIN}`);
  await registerCommands();
  updateStatus();
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── /start ─────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
    const count = countCookies();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_phone').setLabel('📱 Link Điện Thoại').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('btn_pc').setLabel('🖥️ Link Máy Tính').setStyle(ButtonStyle.Primary),
    );

    const rowGuide = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('📖 Hướng Dẫn Điện Thoại').setStyle(ButtonStyle.Link)
        .setURL('https://drive.google.com/drive/folders/1QAw4249og5hJuqF4jAcwCecTvyytv2jZ?usp=drive_link'),
      new ButtonBuilder()
        .setLabel('📖 Hướng Dẫn Máy Tính').setStyle(ButtonStyle.Link)
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

  // ── /status ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'status') {
    const count = countCookies();
    await interaction.reply({
      content: count > 0
        ? `🗂️ Hiện có **${count}** cookie trong kho.`
        : `📭 Kho đang trống — dùng \`/upcookie\` để thêm cookie.`,
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
      content: `🗑️ Đã xóa **${removed}** cookie!\n✅ Kho hiện tại: **0** cookie.`,
      ephemeral: true,
    });
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
        await interaction.editReply('❌ Không tìm thấy cookie hợp lệ trong file.\nCần dòng `.netflix.com` có `NetflixId` hoặc `SecureNetflixId`.');
        return;
      }
      const saved = pushCookies(blocks);
      updateStatus();
      await interaction.editReply(`✅ Đã thêm **${saved}** cookie vào kho.\n🗂️ Tổng: **${countCookies()}** cookie.`);
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
      await interaction.editReply('❌ Hết cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.');
      return;
    }

    // ── Retry loop: thử tối đa 3 cookie liên tiếp ──────────────────────────
    const MAX_ATTEMPTS = 3;
    let result = null;
    let usedCookie = null;
    let attempts = 0;

    while (attempts < MAX_ATTEMPTS && countCookies() > 0) {
      attempts++;
      const rawCookie = popCookie();
      if (!rawCookie) break;

      await interaction.editReply(`⏳ Đang tạo link NFToken (lần thử ${attempts})...`);
      result = await runConverter(rawCookie);

      if (!result.error) {
        usedCookie = rawCookie;
        break; // thành công
      }

      // Thất bại — log và đẩy cookie về cuối queue để dùng lại sau
      console.error(`[attempt ${attempts}] Cookie lỗi:`, result.error, result.detail || '');
      requeueCookie(rawCookie); // ← đẩy lại thay vì bỏ luôn
      result = null;

      // Delay nhỏ giữa các lần thử để tránh rate limit
      await new Promise(r => setTimeout(r, 1500));
    }

    updateStatus();

    if (!result || result.error) {
      await interaction.editReply(
        `⚠️ Không tạo được link sau **${attempts}** lần thử.\n` +
        `Có thể do proxy không ổn định hoặc Netflix đang throttle.\n` +
        `Còn **${countCookies()}** cookie trong kho — vui lòng thử lại sau ít phút.`
      );
      return;
    }

    const link = mode === 'phone' ? result.phone_link : result.pc_link;

    if (!link) {
      // Có result nhưng thiếu link mode được chọn
      const altLink = mode === 'phone' ? result.pc_link : result.phone_link;
      const altLabel = mode === 'phone' ? '🖥️ Link Máy Tính' : '📱 Link Điện Thoại';
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⚠️ Chỉ có link thay thế')
        .setDescription(`Không có link ${mode === 'phone' ? 'Điện Thoại' : 'Máy Tính'}, dùng link thay thế bên dưới:`)
        .addFields(
          { name: '📧 Email',                         value: `\`${result.email || '??'}\``, inline: true },
          { name: `${planToEmoji(result.plan)} Plan`, value: result.plan    || '??',        inline: true },
          { name: '🌍 Country',                       value: result.country || '??',        inline: true },
          { name: altLabel, value: altLink || '(không có link nào)' },
        )
        .setFooter({ text: `Sếp Tún Kịt • ${new Date().toLocaleTimeString('vi-VN')}` });
      await interaction.editReply({ content: '', embeds: [embed] });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('✅ Tạo Link Thành Công!')
      .addFields(
        { name: '📧 Email',                         value: `\`${result.email || '??'}\``, inline: true },
        { name: `${planToEmoji(result.plan)} Plan`, value: result.plan    || '??',        inline: true },
        { name: '🌍 Country',                       value: result.country || '??',        inline: true },
        { name: mode === 'phone' ? '📱 Link Điện Thoại' : '🖥️ Link Máy Tính', value: link },
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