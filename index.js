import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
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
  ActivityType
} from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LINKS_FILE = path.resolve('./links.json');

function readLinksFile() {
  try {
    if (!fs.existsSync(LINKS_FILE)) {
      const initialData = { phone: [], pc: [], tv: [] };
      fs.writeFileSync(LINKS_FILE, JSON.stringify(initialData, null, 2), 'utf8');
      return initialData;
    }

    const raw = fs.readFileSync(LINKS_FILE, 'utf8');
    const data = JSON.parse(raw);

    return {
      phone: Array.isArray(data.phone) ? data.phone : [],
      pc: Array.isArray(data.pc) ? data.pc : [],
      tv: Array.isArray(data.tv) ? data.tv : []
    };
  } catch (error) {
    console.error('Lỗi đọc links.json:', error);
    return { phone: [], pc: [], tv: [] };
  }
}

function writeLinksFile(data) {
  fs.writeFileSync(LINKS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getNextLink(platform) {
  const linksData = readLinksFile();

  if (!linksData[platform] || linksData[platform].length === 0) {
    return null;
  }

  const nextLink = linksData[platform].shift();
  writeLinksFile(linksData);
  return nextLink;
}

function getPlatformMeta(platform) {
  if (platform === 'phone') {
    return {
      label: 'Điện thoại',
      emoji: '📱',
      buttonText: 'Link Điện Thoại'
    };
  }

  if (platform === 'pc') {
    return {
      label: 'Máy tính',
      emoji: '💻',
      buttonText: 'Link Máy Tính'
    };
  }

  return {
    label: 'TV',
    emoji: '📺',
    buttonText: 'Link TV'
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Hiển thị bảng chọn thiết bị')
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function registerCommands() {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );
}

client.once(Events.ClientReady, readyClient => {
  console.log(`Bot online: ${readyClient.user.tag}`);

  readyClient.user.setPresence({
    status: 'dnd',
    activities: [
      {
        name: 'tún kịt súc vật',
        type: ActivityType.Playing
      }
    ]
  });
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'start') {
      const embed = new EmbedBuilder()
        .setTitle('START PANEL')
        .setDescription(
          [
            'Chọn loại thiết bị:',
            '',
            '📱 Điện thoại',
            '💻 Máy tính',
            '📺 TV'
          ].join('\n')
        );

      const row = new ActionRowBuilder().addComponents(
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

      await interaction.reply({
        embeds: [embed],
        components: [row]
      });
      return;
    }

    if (interaction.isButton()) {
      let platform = null;

      if (interaction.customId === 'platform_phone') platform = 'phone';
      if (interaction.customId === 'platform_pc') platform = 'pc';
      if (interaction.customId === 'platform_tv') platform = 'tv';

      if (!platform) return;

      const link = getNextLink(platform);
      const meta = getPlatformMeta(platform);

      if (!link) {
        await interaction.reply({
          content: `❌ Hết link cho ${meta.label}!`,
          ephemeral: true
        });
        return;
      }

      const resultEmbed = new EmbedBuilder()
        .setTitle('Tạo Link Thành Công!')
        .setDescription(
          [
            `${meta.emoji} Thiết bị: ${meta.label}`,
            '',
            '🔗 Link:',
            `${link}`
          ].join('\n')
        );

      const openRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Mở Link')
          .setStyle(ButtonStyle.Link)
          .setURL(link)
      );

      await interaction.reply({
        embeds: [resultEmbed],
        components: [openRow]
      });
    }
  } catch (error) {
    console.error('Lỗi interaction:', error);

    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: 'Có lỗi xảy ra.',
          ephemeral: true
        }).catch(() => {});
      } else {
        await interaction.reply({
          content: 'Có lỗi xảy ra.',
          ephemeral: true
        }).catch(() => {});
      }
    }
  }
});

app.get('/', (_req, res) => {
  res.send('Bot is running.');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Web server chạy ở cổng ${PORT}`);
});

(async () => {
  try {
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Lỗi khởi động bot:', error);
  }
})();