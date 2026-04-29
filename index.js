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

import { initAppEmojis, e, btnEmoji, flag, planEmoji } from './utils/emoji.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── ENV ──────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN     = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID          = process.env.GUILD_ID;
const ADMIN_IDS         = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── STREAMING CONFIG ─────────────────────────────────────────────────────────
const STREAMING_URL = 'https://www.twitch.tv/tunkit2302';

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
const countCookies  = () => cookieQueue.length;
const popCookie     = () => cookieQueue.shift() || null;
const pushCookies   = (blocks) => { cookieQueue.push(...blocks); return blocks.length; };
const clearCookies  = () => { const n = cookieQueue.length; cookieQueue.length = 0; return n; };
// const requeueCookie = (block) => { cookieQueue.push(block); }; // đã bỏ requeue, cookie lỗi bị loại luôn

// ─── USER TOKEN SESSION STORAGE ─────────────────────────────────────────────
// Mỗi lần /start pop 1 cookie, tạo token 1 lần; user có thể lấy cả phone + pc
// từ cùng 1 token. Muốn tạo thêm phải /start mới.
const userTokenData = new Map();

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
      shell: process.platform === 'win32',
    });
    let stdout = '', stderr = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill('SIGTERM'); } catch {}
        resolve({ error: 'Timeout: Python process quá 30 giây', detail: stderr.slice(-300) });
      }
    }, 30000);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      const out = stdout.trim();
      if (!out) return resolve({ error: `Không có output`, detail: stderr.slice(-300) });
      try { resolve(JSON.parse(out)); }
      catch { resolve({ error: `Không parse được JSON`, detail: out.slice(-200) }); }
    });
    child.on('error', err => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve({ error: `Không thể chạy Python: ${err.message}` });
    });
    try {
      child.stdin.write(rawCookie, 'utf8');
      child.stdin.end();
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ error: `Lỗi ghi stdin: ${err.message}` });
      }
    }
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
// Application-emoji aware version (falls back to Unicode if no custom emoji uploaded)
function planToEmoji(plan = '') {
  return planEmoji(plan);
}

async function updateStatus() {
  const count = countCookies();
  // NOTE: Discord presence (status) only supports Unicode emojis, never custom/app emojis
  const statusText = count > 0 ? `🎬 ${count} cookie sẵn sàng` : '❌ Hết cookie — chờ admin';

  try {
    console.log('[DEBUG] Setting presence:', statusText, 'URL:', STREAMING_URL);
    const result = await client.user?.setPresence({
      status: 'online',
      activities: [{
        name: statusText,
        type: 1, // ActivityType.Streaming = 1
        url: STREAMING_URL,
      }],
    });
    console.log('[DEBUG] setPresence result:', result ? 'OK' : 'undefined');
  } catch (err) {
    console.error('❌ Lỗi setPresence:', err.message);
  }
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online: ${c.user.tag}`);
  console.log(`🐍 Python: ${PYTHON_BIN}`);
  await registerCommands();

  // Load application emojis so e('name') / btnEmoji('name') work everywhere
  await initAppEmojis(client);

  // Delay nhỏ để Discord API sẵn sàng trước khi set presence
  setTimeout(() => {
    updateStatus().then(() => {
      console.log('✅ Đã set Streaming activity (status tím)');
    }).catch(err => {
      console.error('❌ Lỗi set status:', err.message);
    });
  }, 2000);
});

// ─── INTERACTIONS ─────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── /start ─────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
    // Reset session cũ -> muốn tạo thêm phải /start mới
    userTokenData.delete(interaction.user.id);
    const count = countCookies();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_phone')
        .setLabel('Link Điện Thoại')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(btnEmoji('phone') ?? { name: '📱' }),
      new ButtonBuilder()
        .setCustomId('btn_pc')
        .setLabel('Link Máy Tính')
        .setStyle(ButtonStyle.Primary)
        .setEmoji(btnEmoji('pc') ?? { name: '🖥️' }),
    );

    const rowGuide = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Hướng Dẫn Điện Thoại')
        .setStyle(ButtonStyle.Link)
        .setURL('https://drive.google.com/drive/folders/1QAw4249og5hJuqF4jAcwCecTvyytv2jZ?usp=drive_link')
        .setEmoji(btnEmoji('guide') ?? { name: '📖' }),
      new ButtonBuilder()
        .setLabel('Hướng Dẫn Máy Tính')
        .setStyle(ButtonStyle.Link)
        .setURL('https://drive.google.com/drive/folders/1S7bINLNLjy_Phmhc76DSugm1xgA44OJ_?usp=drive_link')
        .setEmoji(btnEmoji('guide') ?? { name: '📖' }),
    );

    const rowFixGuide = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Hướng dẫn fix lỗi')
        .setStyle(ButtonStyle.Link)
        .setURL('https://drive.google.com/drive/folders/1f_9E-brb-bFNP4JKmKPxTsg9oF2AsDFV?usp=drive_link')
        .setEmoji(btnEmoji('fix') ?? { name: '🔧' }),
    );

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`${e('netflix')} Netflix của Tún Kịt`)
      .setDescription(
        `**Chọn loại link bạn muốn tạo:**\n\n` +
        `${e('phone')} **Điện Thoại** – Tối ưu cho mobile\n` +
        `${e('pc')} **Máy Tính** – Tối ưu cho desktop\n\n` +
        `> ${e('files')} Còn **${count}** cookie trong kho\n\n` +
        `> ${e('warning')} Nếu acc không xem được pls log out và đổi qua acc khác, ping admin nếu có thắc mắc`,
      )
      .setFooter({ text: 'Bot by Sếp Tún Kịt' });

    await interaction.reply({ embeds: [embed], components: [row, rowGuide, rowFixGuide] });
    return;
  }

  // ── /status ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'status') {
    const count = countCookies();
    await interaction.reply({\n      content: count > 0\n        ? `${e('files')} Hiện có **${count}** cookie trong kho.`\n        : `${e('inbox')} Kho đang trống — dùng \`/upcookie\` để thêm cookie.`,\n    });\n    return;
  }

  // ── /clearcookie ───────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'clearcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: `${e('error')} Bạn không có quyền dùng lệnh này.`, ephemeral: true });
      return;
    }
    const removed = clearCookies();
    updateStatus();
    await interaction.reply({
      content: `${e('trash')} Đã xóa **${removed}** cookie!\n${e('success')} Kho hiện tại: **0** cookie.`,
      ephemeral: true,
    });
    return;
  }

  // ── /upcookie ──────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'upcookie') {
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(interaction.user.id)) {
      await interaction.reply({ content: `${e('error')} Bạn không có quyền dùng lệnh này.`, ephemeral: true });
      return;
    }
    const attachment = interaction.options.getAttachment('file');
    if (!attachment.name.toLowerCase().endsWith('.txt')) {
      await interaction.reply({ content: `${e('error')} Chỉ nhận file \`.txt\` chứa cookie Netflix.`, ephemeral: true });
      return;
    }
    await interaction.deferReply();
    try {
      const res    = await axios.get(attachment.url, { responseType: 'text', timeout: 10_000 });
      const blocks = parseCookieFileIntoBlocks(res.data);
      if (!blocks.length) {
        await interaction.editReply(`${e('error')} Không tìm thấy cookie hợp lệ trong file.\nCần dòng \`.netflix.com\` có \`NetflixId\` hoặc \`SecureNetflixId\`.`);
        return;
      }
      const saved = pushCookies(blocks);
      updateStatus();
      await interaction.editReply(`${e('success')} Đã thêm **${saved}** cookie vào kho.\n${e('files')} Tổng: **${countCookies()}** cookie.`);
    } catch (err) {
      await interaction.editReply(`${e('error')} Lỗi: ${err.message}`);
    }
    return;
  }

  // ── Buttons ────────────────────────────────────────────────────────────────
  if (interaction.isButton() && (interaction.customId === 'btn_phone' || interaction.customId === 'btn_pc')) {
    const userId = interaction.user.id;
    const mode = interaction.customId === 'btn_phone' ? 'phone' : 'pc';
    await interaction.deferReply();

    let data = userTokenData.get(userId);

    // Nếu chưa có token cho session này -> pop cookie và tạo
    if (!data) {
      if (countCookies() === 0) {
        await interaction.editReply(`${e('error')} Hết cookie netflix! Vui lòng chờ admin **Tún Kịt** upload thêm.`);
        return;
      }

      const MAX_ATTEMPTS = Math.min(5, countCookies());
      let result = null;
      let attempts = 0;

      while (attempts < MAX_ATTEMPTS && countCookies() > 0) {
        attempts++;
        const rawCookie = popCookie();
        if (!rawCookie) break;

        await interaction.editReply(`${e('loading')} Đang tạo link NFToken (lần thử ${attempts}/${MAX_ATTEMPTS})...`);
        result = await runConverter(rawCookie);

        if (!result.error) break;

        console.error(`[attempt ${attempts}/${MAX_ATTEMPTS}] Cookie lỗi:`, result.error, result.detail || '');
        result = null;
        await new Promise(r => setTimeout(r, 2000));
      }

      updateStatus();

      if (!result || result.error) {
        await interaction.editReply(
          `${e('warning')} Không tạo được link sau **${attempts}** lần thử.\n` +
          `Có thể do proxy không ổn định hoặc Netflix đang throttle.\n` +
          `Còn **${countCookies()}** cookie trong kho — vui lòng thử lại sau ít phút.`
        );
        return;
      }

      data = { result, claimedPhone: false, claimedPc: false };
      userTokenData.set(userId, data);
    }

    // Kiểm tra đã lấy link mode này chưa
    if (mode === 'phone' && data.claimedPhone) {
      await interaction.editReply(`${e('error')} Bạn đã lấy link Điện Thoại rồi! Dùng \`/start\` để tạo mới.`);
      return;
    }
    if (mode === 'pc' && data.claimedPc) {
      await interaction.editReply(`${e('error')} Bạn đã lấy link Máy Tính rồi! Dùng \`/start\` để tạo mới.`);
      return;
    }

    // Đánh dấu đã lấy
    if (mode === 'phone') data.claimedPhone = true;
    else data.claimedPc = true;

    const result = data.result;
    const link = mode === 'phone' ? result.phone_link : result.pc_link;

    if (!link) {
      const altLink  = mode === 'phone' ? result.pc_link : result.phone_link;
      const altLabel = mode === 'phone' ? `${e('pc')} Link Máy Tính` : `${e('phone')} Link Điện Thoại`;
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(`${e('warning')} Chỉ có link thay thế`)
        .setDescription(`Không có link ${mode === 'phone' ? 'Điện Thoại' : 'Máy Tính'}, dùng link thay thế bên dưới:`)
        .addFields(
          { name: `${e('email')} Email`,                         value: `\`${result.email || '??'}\``, inline: true },
          { name: `${planToEmoji(result.plan)} Plan`,            value: result.plan    || '??',        inline: true },
          { name: `${flag(result.country || '')} Country`,       value: result.country || '??',        inline: true },
          { name: altLabel, value: altLink || '(không có link nào)' },
        )
        .setFooter({ text: `Sếp Tún Kịt • ${new Date().toLocaleTimeString('vi-VN')}` });
      await interaction.editReply({ content: '', embeds: [embed] });
    } else {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`${e('success')} Tạo Link Thành Công!`)
        .addFields(
          { name: `${e('email')} Email`,                         value: `\`${result.email || '??'}\``, inline: true },
          { name: `${planToEmoji(result.plan)} Plan`,            value: result.plan    || '??',        inline: true },
          { name: `${flag(result.country || '')} Country`,       value: result.country || '??',        inline: true },
          { name: mode === 'phone' ? `${e('phone')} Link Điện Thoại` : `${e('pc')} Link Máy Tính`, value: link },
        )
        .setFooter({ text: `Sếp Tún Kịt • ${new Date().toLocaleTimeString('vi-VN')}` });
      await interaction.editReply({ content: '', embeds: [embed] });
    }

    // Gửi GIF ping user
    try {
      await interaction.channel.send({
        content: `<@${userId}> đã tạo token thành công! ${e('party')}`,
        embeds: [new EmbedBuilder().setImage('https://c.tenor.com/VcmLE85OOPUAAAAd/tenor.gif').setColor(0x2ecc71)],
      });
    } catch (e) {
      console.error('Lỗi gửi GIF:', e.message);
    }
  }
});

// ─── LOGIN ────────────────────────────────────────────────────────────────────
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('❌ Thiếu DISCORD_TOKEN hoặc DISCORD_CLIENT_ID trong .env');
  process.exit(1);
}
client.login(DISCORD_TOKEN);
