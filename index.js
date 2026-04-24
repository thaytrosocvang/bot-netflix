import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── ENV ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const ALLOWED_CHANNEL = process.env.ALLOWED_CHANNEL_ID || null; // optional: restrict to 1 channel

// ─── DIRECTORIES ────────────────────────────────────────────────────────────
const cookieDir = path.join(__dirname, 'cookies');
const outputDir = path.join(__dirname, 'output');
for (const d of [cookieDir, outputDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ─── DISCORD CLIENT ─────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Parse a raw Netscape-format cookie string into a plain object.
 * Each line: domain \t flag \t path \t secure \t expiry \t name \t value
 */
function parseCookieFile(rawText) {
  const cookies = {};
  for (const line of rawText.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const name  = parts[5].trim();
    const value = parts[6].trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

/**
 * Parse JSON array of cookie objects (browser-export format).
 */
function parseCookieJson(rawText) {
  try {
    const arr = JSON.parse(rawText);
    const cookies = {};
    for (const c of arr) {
      if (c.name && c.value) cookies[c.name] = c.value;
    }
    return cookies;
  } catch {
    return null;
  }
}

/**
 * Build axios cookie header string from parsed cookie map.
 */
function buildCookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Core: call Netflix to exchange a session cookie for an NFToken.
 * Returns { nftoken, email, plan, country } or throws.
 *
 * mode: "pc" | "mobile" | "tv" | "both"
 */
async function convertCookieToNFToken(cookieHeader, mode = 'both', proxy = null) {
  const headers = {
    'Cookie': cookieHeader,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.netflix.com/',
  };

  const axiosCfg = { headers, timeout: 15_000 };

  // ── 1. Fetch account page to verify login + extract basic info ──
  const acctRes = await axios.get(
    'https://www.netflix.com/YourAccount',
    axiosCfg,
  );

  if (!acctRes.data.includes('netflix-sans')) {
    throw new Error('INVALID_COOKIE'); // not logged in
  }

  // Extract email
  const emailMatch = acctRes.data.match(/"userInfo":\s*{[^}]*"emailAddress"\s*:\s*"([^"]+)"/);
  const email = emailMatch ? emailMatch[1] : 'unknown@netflix.com';

  // Extract plan label
  const planMatch = acctRes.data.match(/"planName"\s*:\s*"([^"]+)"/);
  const plan = planMatch ? planMatch[1] : 'Unknown';

  // Extract country
  const countryMatch = acctRes.data.match(/"countryOfSignup"\s*:\s*"([^"]+)"/);
  const country = countryMatch ? countryMatch[1] : '??';

  // ── 2. Request NFToken via the /nftoken endpoint ──
  // Netflix issues short-lived one-time-use login links.
  const tokenRes = await axios.get(
    'https://www.netflix.com/api/mre/login-with-token/v1',
    {
      ...axiosCfg,
      params: {
        appName: mode === 'mobile' ? 'nflx-android-app' : 'nflx-web',
        deviceModel: mode === 'mobile' ? 'phone' : 'browser',
      },
    },
  );

  const tokenData = tokenRes.data;
  if (!tokenData || !tokenData.nftoken) {
    throw new Error('TOKEN_FETCH_FAILED');
  }

  const nftoken = tokenData.nftoken;

  return {
    email,
    plan,
    country,
    nftoken,
    links: buildLinks(nftoken),
  };
}

/**
 * Build platform-specific login links from an NFToken.
 */
function buildLinks(nftoken) {
  return {
    phone: `https://www.netflix.com/unsupported?nftoken=${nftoken}`,
    pc:    `https://www.netflix.com/?nftoken=${nftoken}`,
    tv:    generateTvCode(nftoken),   // 8-char code for TV
  };
}

/**
 * Derive a human-readable 8-character TV code from an NFToken.
 * Netflix's TV pairing uses a subset of the token as a shortcode.
 */
function generateTvCode(nftoken) {
  // Take first 8 uppercase alphanumeric chars from the token
  const clean = nftoken.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return clean.slice(0, 8);
}

// ─── BOT READY ──────────────────────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot ready: ${c.user.tag}`);
  c.user.setPresence({
    status: 'online',
    activities: [{ name: 'Netflix Cookie Converter', type: 0 }],
  });
});

// ─── MESSAGE HANDLER ────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Optional: restrict to a specific channel
  if (ALLOWED_CHANNEL && message.channelId !== ALLOWED_CHANNEL) return;

  const content = message.content.trim();

  // ── /start command ─────────────────────────────────────────────────────
  if (content === '/start' || content.startsWith('/start@')) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('btn_phone')
        .setLabel('📱 Link Điện Thoại')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('btn_pc')
        .setLabel('🖥️ Link Máy Tính')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('btn_tv')
        .setLabel('📺 TV Code')
        .setStyle(ButtonStyle.Secondary),
    );

    const embed = new EmbedBuilder()
      .setColor(0xe50914)
      .setTitle('🎬 Netflix Link Generator')
      .setDescription(
        '**Chọn loại link bạn muốn tạo:**\n\n' +
        '📱 **Điện Thoại** – Tối ưu cho mobile\n' +
        '🖥️ **Máy Tính** – Tối ưu cho desktop\n' +
        '📺 **TV** – Nhập mã TV 8 ký tự',
      )
      .setFooter({ text: 'Bot by DINO STORE NETFLIX' });

    await message.reply({ embeds: [embed], components: [row] });
    return;
  }

  // ── Cookie file upload ──────────────────────────────────────────────────
  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    const name       = (attachment?.name || '').toLowerCase();

    if (!name.endsWith('.txt') && !name.endsWith('.json')) {
      await message.reply('❌ Chỉ nhận file `.txt` (Netscape) hoặc `.json` (browser export).');
      return;
    }

    // Acknowledge immediately
    const waitMsg = await message.reply('⏳ Đang tải và kiểm tra cookie…');

    try {
      const fileRes   = await axios.get(attachment.url, { responseType: 'text', timeout: 10_000 });
      const rawText   = fileRes.data;

      // Parse cookies
      let cookies;
      if (name.endsWith('.json')) {
        cookies = parseCookieJson(rawText);
        if (!cookies) throw new Error('JSON_PARSE_FAILED');
      } else {
        cookies = parseCookieFile(rawText);
      }

      if (!cookies['NetflixId'] && !cookies['authURL']) {
        throw new Error('MISSING_NETFLIX_COOKIES');
      }

      const cookieHeader = buildCookieHeader(cookies);

      // Save to disk (overwrites previous)
      const savePath = path.join(cookieDir, 'cookies.txt');
      fs.writeFileSync(savePath, rawText, 'utf8');

      // Convert
      const result = await convertCookieToNFToken(cookieHeader, 'both');

      // Save result log
      const log = JSON.stringify({ ...result, savedAt: new Date().toISOString() }, null, 2);
      fs.writeFileSync(path.join(outputDir, `${Date.now()}.json`), log, 'utf8');

      const embed = buildResultEmbed(result, 'both');
      await waitMsg.edit({ content: '', embeds: [embed] });
    } catch (err) {
      const reason = friendlyError(err.message);
      await waitMsg.edit(`❌ ${reason}`);
      console.error('[cookie upload]', err.message);
    }
    return;
  }

  // ── !checkcookie ────────────────────────────────────────────────────────
  if (content === '!checkcookie') {
    const filePath = path.join(cookieDir, 'cookies.txt');
    if (!fs.existsSync(filePath)) {
      await message.reply('⚠️ Chưa có file cookie. Hãy gửi file `cookies.txt` vào đây.');
      return;
    }
    const { size } = fs.statSync(filePath);
    await message.reply(`📂 Đã có \`cookies.txt\` (${size} bytes). Gửi lại file để convert mới.`);
    return;
  }

  // ── !help ───────────────────────────────────────────────────────────────
  if (content === '!help') {
    const embed = new EmbedBuilder()
      .setColor(0xe50914)
      .setTitle('📖 Hướng dẫn sử dụng')
      .addFields(
        { name: '/start', value: 'Mở menu chọn loại link' },
        { name: 'Upload file', value: 'Gửi file `.txt` hoặc `.json` cookie để convert' },
        { name: '!checkcookie', value: 'Kiểm tra file cookie hiện có' },
        { name: '!help', value: 'Hiện bảng này' },
      )
      .setFooter({ text: 'Bot by DINO STORE NETFLIX' });

    await message.reply({ embeds: [embed] });
    return;
  }
});

// ─── BUTTON HANDLER ─────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const modeMap = {
    btn_phone: 'mobile',
    btn_pc:    'pc',
    btn_tv:    'tv',
  };

  const mode = modeMap[interaction.customId];
  if (!mode) return;

  await interaction.deferReply({ ephemeral: false });

  const cookiePath = path.join(cookieDir, 'cookies.txt');
  if (!fs.existsSync(cookiePath)) {
    await interaction.editReply('⚠️ Chưa có file cookie. Hãy upload file `cookies.txt` trước.');
    return;
  }

  try {
    const rawText      = fs.readFileSync(cookiePath, 'utf8');
    const cookies      = parseCookieFile(rawText);

    if (!cookies['NetflixId'] && !cookies['authURL']) {
      await interaction.editReply('❌ Cookie không hợp lệ hoặc đã hết hạn. Vui lòng upload lại.');
      return;
    }

    const cookieHeader = buildCookieHeader(cookies);
    const result       = await convertCookieToNFToken(cookieHeader, mode);
    const embed        = buildResultEmbed(result, mode);

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const reason = friendlyError(err.message);
    await interaction.editReply(`❌ ${reason}`);
    console.error('[button]', err.message);
  }
});

// ─── EMBED BUILDER ──────────────────────────────────────────────────────────
function buildResultEmbed(result, mode) {
  const { email, plan, country, links } = result;
  const planEmoji = planToEmoji(plan);

  const embed = new EmbedBuilder()
    .setColor(0xe50914)
    .setTitle('✅ Tạo Link Thành Công!')
    .addFields(
      { name: '📧 Email',   value: `\`${email}\``,            inline: true },
      { name: `${planEmoji} Plan`, value: plan,               inline: true },
      { name: '🌍 Country', value: country,                   inline: true },
    )
    .setFooter({ text: `DINO STORE NETFLIX • ${new Date().toLocaleTimeString('vi-VN')}` });

  if (mode === 'mobile' || mode === 'both') {
    embed.addFields({ name: '📱 Link Điện Thoại', value: `[Mở Link](${links.phone})\n\`${links.phone}\`` });
  }
  if (mode === 'pc' || mode === 'both') {
    embed.addFields({ name: '🖥️ Link Máy Tính', value: `[Mở Link](${links.pc})\n\`${links.pc}\`` });
  }
  if (mode === 'tv' || mode === 'both') {
    embed.addFields({ name: '📺 TV Code', value: `\`\`\`${links.tv}\`\`\`` });
  }

  return embed;
}

function planToEmoji(plan) {
  const p = (plan || '').toLowerCase();
  if (p.includes('premium')) return '💎';
  if (p.includes('standard')) return '⭐';
  if (p.includes('basic'))    return '🔵';
  if (p.includes('mobile'))   return '📱';
  return '🎬';
}

function friendlyError(msg) {
  const map = {
    INVALID_COOKIE:          'Cookie không hợp lệ hoặc đã hết hạn.',
    TOKEN_FETCH_FAILED:      'Không lấy được NFToken từ Netflix. Thử lại sau.',
    MISSING_NETFLIX_COOKIES: 'File thiếu `NetflixId` / `authURL`. Kiểm tra lại định dạng.',
    JSON_PARSE_FAILED:       'File JSON không đúng định dạng.',
  };
  return map[msg] || `Lỗi không xác định: ${msg}`;
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────
if (!DISCORD_TOKEN) {
  console.error('❌ Thiếu DISCORD_TOKEN trong .env / Railway Variables.');
  process.exit(1);
}
client.login(DISCORD_TOKEN);