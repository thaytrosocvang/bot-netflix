// index.js  —  FULL skeleton with cookie→token support
import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import { spawn } from 'child_process';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  ActivityType,
  PermissionFlagsBits
} from 'discord.js';

const { Pool } = pg;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
const PORT = Number(process.env.PORT || 3000);

/*──────────────────────────────────  Postgres  ─────────────────────────────*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL CHECK (platform IN ('phone','pc','tv')),
      url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

/*─────────────────────────────  Cookie ► Token  ────────────────────────────*/
/**
 * Chạy cookie_converter.py  ➜  JSON  ➜  trả mảng cookies
 */
function convertTxtToJson(buffer) {
  return new Promise((res, rej) => {
    const py = spawn('python', ['cookie_converter.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    py.stdout.on('data', d => (out += d));
    py.on('close', code => {
      if (code !== 0) return rej(new Error('converter exit ' + code));
      try {
        res(JSON.parse(out));
      } catch (e) {
        rej(e);
      }
    });
    py.stdin.end(buffer);
  });
}

/**
 * Ví dụ placeholder: nhận cookie JSON, trả về token-URL
 * TODO: thay bằng logic thật (gọi main.py hoặc API riêng)
 */
async function getTokenFromCookie(cookieJson) {
  // ... xử lý, trả về { platform, url }
  return { platform: 'phone', url: 'https://example.com/token=abc' };
}

/**
 * Lưu link (token) vào DB
 */
async function saveTokenLink(platform, url) {
  await pool.query(
    'INSERT INTO links (platform,url) VALUES ($1,$2)',
    [platform, url]
  );
}

/*──────────────────────────────  Discord cmds  ─────────────────────────────*/
const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Hiển thị bảng chọn thiết bị'),

  new SlashCommandBuilder()
    .setName('uploadtxt')
    .setDescription('Upload file txt link thường (giữ nguyên chức năng cũ)')
    .addAttachmentOption(o => o.setName('file').setDescription('file txt').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('uploadcookies')
    .setDescription('Upload file TXT cookies → token-link')
    .addAttachmentOption(o => o.setName('file').setDescription('cookie txt').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

/*──────────────────────────  Helper gửi panel / kết quả ────────────────────*/
function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('platform_phone')
      .setLabel('Link Điện Thoại')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('platform_pc')
      .setLabel('Link Máy Tính')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('platform_tv')
      .setLabel('Link TV')
      .setStyle(ButtonStyle.Success)
  );
}

function meta(platform) {
  return {
    phone: { emoji: '📱', label: 'Điện thoại' },
    pc:    { emoji: '💻', label: 'Máy tính' },
    tv:    { emoji: '📺', label: 'TV' }
  }[platform];
}

/*─────────────────────────────  Interaction logic  ─────────────────────────*/
client.on(Events.InteractionCreate, async (i) => {
  try {
    /* /start ────────────────────────────────────────────────────────────*/
    if (i.isChatInputCommand() && i.commandName === 'start') {
      const embed = new EmbedBuilder()
        .setTitle('START PANEL')
        .setDescription('Chọn loại thiết bị:\n\n📱 Điện thoại\n💻 Máy tính\n📺 TV');
      await i.reply({ embeds:[embed], components:[panelRow()] });
      return;
    }

    /* /uploadcookies ────────────────────────────────────────────────────*/
    if (i.isChatInputCommand() && i.commandName === 'uploadcookies') {
      const attach = i.options.getAttachment('file', true);
      await i.deferReply({ ephemeral:true });
      const buf = await (await fetch(attach.url)).arrayBuffer();
      const cookies = await convertTxtToJson(Buffer.from(buf).toString('utf8'));

      const added = [];
      for (const c of cookies) {
        const { platform, url } = await getTokenFromCookie(c);
        if (platform && url) {
          await saveTokenLink(platform, url);
          added.push({ platform, url });
        }
      }
      await i.editReply(`✅ Đã convert & lưu **${added.length}** token-link.`);
      return;
    }

    /* Button bấm link ──────────────────────────────────────────────────*/
    if (i.isButton()) {
      const p = i.customId.replace('platform_','');   // phone|pc|tv
      const { rows } = await pool.query(
        'SELECT id,url FROM links WHERE platform=$1 ORDER BY id LIMIT 1',
        [p]
      );
      await i.deferUpdate();
      if (!rows.length) {
        await i.channel.send(`❌ Hết link cho ${meta(p).label}! Vui lòng admin upload thêm.`);
        return;
      }
      const { id, url } = rows[0];
      await pool.query('DELETE FROM links WHERE id=$1',[id]);

      const embed = new EmbedBuilder()
        .setTitle('Tạo Link Thành Công!')
        .setDescription(`${meta(p).emoji} Thiết bị: ${meta(p).label}\n\n🔗 Link:\n${url}`);
      const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Mở Link').setStyle(ButtonStyle.Link).setURL(url)
      );
      await i.channel.send({ embeds:[embed], components:[linkRow] });
      return;
    }
  } catch(err){
    console.error(err);
    if(i.isRepliable()) {
      const msg = 'Có lỗi xảy ra.';
      i.replied || i.deferred ? i.followUp({content:msg,ephemeral:true}) : i.reply({content:msg,ephemeral:true});
    }
  }
});

/*──────────────────────────────────  Boot  ────────────────────────────────*/
app.get('/',(_q,res)=>res.send('Bot alive'));
app.listen(PORT,()=>console.log(`Web server cổng ${PORT}`));

(async()=>{
  await initDb();
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  await client.login(process.env.DISCORD_TOKEN);
})();