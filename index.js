import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

// __dirname cho ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== ENV =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===== THƯ MỤC LƯU COOKIE =====
const cookieDir = path.join(__dirname, 'cookies');
if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });

// ===== READY =====
client.once(Events.ClientReady, (c) => {
  console.log(`Bot ready: ${c.user.tag}`);

  // 🟡 Chờ
  c.user.setPresence({
    status: 'idle',
    activities: [{ name: 'Tún Kịt súc vật', type: 0 }],
  });
});

// ===== UPLOAD COOKIE BẰNG FILE TXT TRONG CHAT =====
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // 1) Nếu có file đính kèm
  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    const name = (attachment?.name || '').toLowerCase();

    if (!name.endsWith('.txt')) {
      await message.reply('❌ Chỉ nhận file .txt');
      return;
    }

    try {
      const res = await axios.get(attachment.url, { responseType: 'arraybuffer' });

      // Lưu cố định vào cookies/cookies.txt
      const filePath = path.join(cookieDir, 'cookies.txt');
      fs.writeFileSync(filePath, res.data);

      await message.reply('✅ Upload cookie thành công! (đã lưu vào cookies/cookies.txt)');
      console.log('Cookie saved to:', filePath);
    } catch (err) {
      console.error(err);
      await message.reply('❌ Lỗi khi tải file.');
    }
    return;
  }

  // 2) Lệnh test
  if (message.content.trim() === '!checkcookie') {
    const filePath = path.join(cookieDir, 'cookies.txt');
    if (!fs.existsSync(filePath)) {
      await message.reply('⚠ Chưa có file cookie. Hãy gửi file cookies.txt vào đây.');
      return;
    }
    const size = fs.statSync(filePath).size;
    await message.reply(`📂 Đã có cookies.txt (size: ${size} bytes).`);
  }
});

// ===== LOGIN =====
if (!DISCORD_TOKEN) {
  console.error('❌ Missing DISCORD_TOKEN in env (Railway Variables).');
  process.exit(1);
}
client.login(DISCORD_TOKEN);