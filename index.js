import 'dotenv/config';
import express from 'express';
import pg from 'pg';
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const app = express();
const PORT = Number(process.env.PORT || 3000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id SERIAL PRIMARY KEY,
      platform TEXT NOT NULL CHECK (platform IN ('phone', 'pc', 'tv')),
      url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function getNextLink(platform) {
  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    const result = await db.query(
      `
      SELECT id, url
      FROM links
      WHERE platform = $1
      ORDER BY id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [platform]
    );

    if (result.rows.length === 0) {
      await db.query('COMMIT');
      return null;
    }

    const row = result.rows[0];

    await db.query('DELETE FROM links WHERE id = $1', [row.id]);

    await db.query('COMMIT');
    return row.url;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

function parseTxtContent(content) {
  const validPlatforms = new Set(['phone', 'pc', 'tv']);
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const rows = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i];

    if (line.startsWith('#')) continue;

    const parts = line.split('|');
    if (parts.length < 2) {
      errors.push(`Dòng ${lineNumber}: sai format, phải là platform|url`);
      continue;
    }

    const platform = parts[0].trim().toLowerCase();
    const url = parts.slice(1).join('|').trim();

    if (!validPlatforms.has(platform)) {
      errors.push(`Dòng ${lineNumber}: platform không hợp lệ (${platform})`);
      continue;
    }

    try {
      new URL(url);
    } catch {
      errors.push(`Dòng ${lineNumber}: URL không hợp lệ`);
      continue;
    }

    rows.push({ platform, url });
  }

  return { rows, errors };
}

async function insertLinks(rows) {
  if (!rows.length) return 0;

  const db = await pool.connect();

  try {
    await db.query('BEGIN');

    for (const row of rows) {
      await db.query(
        'INSERT INTO links (platform, url) VALUES ($1, $2)',
        [row.platform, row.url]
      );
    }

    await db.query('COMMIT');
    return rows.length;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Hiển thị bảng chọn thiết bị'),

  new SlashCommandBuilder()
    .setName('uploadtxt')
    .setDescription('Upload file txt để thêm link vào database')
    .addAttachmentOption(option =>
      option
        .setName('file')
        .setDescription('File txt chứa link theo format platform|url')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(cmd => cmd.toJSON());

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
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'start') {
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

      if (interaction.commandName === 'uploadtxt') {
        const attachment = interaction.options.getAttachment('file', true);

        if (!attachment.name.toLowerCase().endsWith('.txt')) {
          await interaction.reply({
            content: '❌ Chỉ chấp nhận file .txt',
            ephemeral: true
          });
          return;
        }

        await interaction.deferReply({ ephemeral: true });

        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`Không tải được file: HTTP ${response.status}`);
        }

        const text = await response.text();
        const { rows, errors } = parseTxtContent(text);

        const inserted = await insertLinks(rows);

        const summary = [
          `✅ Đã thêm **${inserted}** link vào database.`,
          rows.length ? '' : 'Không có dòng hợp lệ nào để thêm.'
        ];

        if (errors.length) {
          summary.push('', `⚠️ Có **${errors.length}** dòng lỗi:`);
          summary.push(...errors.slice(0, 10));
          if (errors.length > 10) {
            summary.push(`... và ${errors.length - 10} lỗi khác`);
          }
        }

        await interaction.editReply({
          content: summary.join('\n')
        });
        return;
      }
    }

    if (interaction.isButton()) {
      let platform = null;

      if (interaction.customId === 'platform_phone') platform = 'phone';
      if (interaction.customId === 'platform_pc') platform = 'pc';
      if (interaction.customId === 'platform_tv') platform = 'tv';

      if (!platform) return;

      const link = await getNextLink(platform);
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
        components: [openRow],
        ephemeral: true
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
    await initDb();
    await registerCommands();
    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    console.error('Lỗi khởi động bot:', error);
  }
})();