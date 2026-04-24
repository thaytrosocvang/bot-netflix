const { Client, GatewayIntentBits } = require("discord.js");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ===== TẠO THƯ MỤC LƯU COOKIE =====
const cookieDir = path.join(__dirname, "cookies");

if (!fs.existsSync(cookieDir)) {
  fs.mkdirSync(cookieDir);
}

// ===== BOT READY =====
client.on("clientReady", () => {
  console.log(`Bot ready: ${client.user.tag}`);
});

// ===== NHẬN FILE COOKIE =====
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // Nếu có file đính kèm
  if (message.attachments.size > 0) {
    const attachment = message.attachments.first();

    if (!attachment.name.endsWith(".txt")) {
      return message.reply("❌ Chỉ nhận file .txt");
    }

    try {
      const response = await axios.get(attachment.url, {
        responseType: "arraybuffer",
      });

      const filePath = path.join(cookieDir, "cookies.txt");

      fs.writeFileSync(filePath, response.data);

      message.reply("✅ Upload cookie thành công!");
      console.log("Cookie saved to:", filePath);
    } catch (err) {
      console.error(err);
      message.reply("❌ Lỗi khi tải file.");
    }
  }

  // Test lệnh đơn giản
  if (message.content === "!checkcookie") {
    const filePath = path.join(cookieDir, "cookies.txt");

    if (!fs.existsSync(filePath)) {
      return message.reply("⚠ Chưa có file cookie.");
    }

    message.reply("📂 Cookie file tồn tại, sẵn sàng check.");
  }
});

// ===== LOGIN =====
client.login(process.env.TOKEN);