import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Routes
} from 'discord.js';

import { REST } from '@discordjs/rest';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import fs from 'fs';
import { spawn } from 'child_process';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);

  client.user.setPresence({
    status: 'idle',
    activities: [{ name: 'Netflix Free', type: 0 }]
  });
});

const commands = [
  new SlashCommandBuilder()
    .setName('upcookie')
    .setDescription('Upload file cookie (Admin only)')
    .addAttachmentOption(option =>
      option.setName('file')
        .setDescription('File txt cookie')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Lấy link netflix')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  await rest.put(
    Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
    { body: commands }
  );
})();

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // ===============================
  // UP COOKIE
  // ===============================
  if (interaction.commandName === 'upcookie') {

    if (interaction.user.id !== process.env.ADMIN_ID) {
      return interaction.reply({
        content: '❌ Chỉ admin mới dùng được.',
        ephemeral: true
      });
    }

    const attachment = interaction.options.getAttachment('file');

    const response = await fetch(attachment.url);
    const text = await response.text();

    const blocks = text.split('– Email:').slice(1);

    if (!blocks.length) {
      return interaction.reply('❌ Không tìm thấy cookie hợp lệ.');
    }

    let count = 0;

    for (const block of blocks) {
      const cookie = '– Email:' + block.trim();

      await pool.query(
        'INSERT INTO cookies (cookie_text) VALUES ($1)',
        [cookie]
      );

      count++;
    }

    interaction.reply(`✅ Đã upload ${count} cookie thành công.`);
  }

  // ===============================
  // START CONVERT
  // ===============================
  if (interaction.commandName === 'start') {

    await interaction.deferReply();

    const result = await pool.query(
      'SELECT * FROM cookies ORDER BY id ASC LIMIT 1'
    );

    if (!result.rows.length) {
      return interaction.editReply(
        '❌ Hết link cookie netflix! Vui lòng chờ admin Tún Kịt upload thêm.'
      );
    }

    const cookie = result.rows[0];
    const cookieText = cookie.cookie_text;

    const python = spawn('python', ['convert_single.py', cookieText]);

    let output = '';

    python.stdout.on('data', data => {
      output += data.toString();
    });

    python.on('close', async () => {
      try {
        const data = JSON.parse(output);

        await pool.query(
          'DELETE FROM cookies WHERE id = $1',
          [cookie.id]
        );

        const message = `
🎬 **NETFLIX FREE**

📧 Email: ${data.email}
📦 Plan: ${data.plan}

📱 Mobile: ${data.mobile}
💻 PC: ${data.pc}
📺 TV: ${data.tv}
        `;

        interaction.editReply(message);

      } catch (err) {
        interaction.editReply('❌ Lỗi convert cookie.');
      }
    });
  }
});

client.login(process.env.DISCORD_TOKEN);