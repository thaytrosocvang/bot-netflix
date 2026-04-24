import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

// __dirname cho ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Thư mục lưu cookie
const cookieDir = path.join(__dirname, 'cookies');
if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });

// Ready + trạng thái “Chờ”
client.once(Events.ClientReady, (c) => {
  console.log(`Bot ready: ${c.user.tag}`);
  c.user.setPresence({
    status: 'idle', // 🟡 Chờ
    activities: [{ name: 'Netflix Free', type: 0 }],
  });
});

// Upload cookie bằng cách gửi file .txt vào chat
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  // Nếu có file đính kèm
  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();
    const name = (attachment?.name || '').toLowerCase();

    if (!name.endsWith('.txt')) {
      await message.reply('❌ Chỉ nhận file .txt');
      return;
    }

    try {
      const res = await axios.get(attachment.url, { responseType: 'arraybuffer' });
      const filePath = path.join(cookieDir, 'cookies.txt');
      fs.writeFileSync(filePath, res.data);
      await message.reply('✅ Upload cookie thành công!');
      console.log('Cookie saved to:', filePath);
    } catch (err) {
      console.error(err);
      await message.reply('❌ Lỗi khi tải file.');
    }
    return;
  }

  // Lệnh test
  if (message.content === '!checkcookie') {
    const filePath = path.join(cookieDir, 'cookies.txt');
    if (!fs.existsSync(filePath)) {
      await message.reply('⚠ Chưa có file cookie.');
      return;
    }
    await message.reply('📂 Cookie file tồn tại, sẵn sàng check.');
  }
});

// Login
if (!process.env.TOKEN) {
  console.error('❌ Missing TOKEN in env');
  process.exit(1);
}
client.login(process.env.TOKEN);