// index.ts — all Discord slash commands

import { SlashCommandBuilder } from 'discord.js';
import { runVideoPipeline, pollScoutBriefs } from './orchestrator/director';
import { researchTopic, analyzeYouTubeVideo } from './agents/researcher';
import { runScout } from './agents/scout';
import type { ScoutConfig } from './agents/scout';

const DISCORD_CHANNEL_ID = process.env.DISCORD_NOTIFY_CHANNEL!;
const DISCORD_USER_ID    = process.env.DISCORD_OWNER_USER_ID!;

// ── Boot: start background loops ─────────────────────────────────────────────
// These run automatically when the service starts on Railway

async function startBackgroundServices() {
  // 1. Scout — scans for trending content on a schedule
  const scoutConfig: ScoutConfig = {
    keywords: (process.env.SCOUT_KEYWORDS || 'history,war,mystery').split(','),
    creator_accounts: (process.env.SCOUT_ACCOUNTS || '').split(',').filter(Boolean),
    virality_threshold: {
      min_views: parseInt(process.env.SCOUT_MIN_VIEWS || '100000'),
      min_likes:  parseInt(process.env.SCOUT_MIN_LIKES || '5000'),
    },
    target_style: process.env.SCOUT_TARGET_STYLE || 'Yarnhub',
    check_interval_minutes: parseInt(process.env.SCOUT_INTERVAL_MINUTES || '60'),
  };

  // Run Scout and Director poller concurrently (non-blocking)
  runScout(scoutConfig).catch(err => console.error('[Scout]', err.message));

  pollScoutBriefs({
    discord_channel_id: DISCORD_CHANNEL_ID,
    discord_user_id: DISCORD_USER_ID,
    channel_id: process.env.YOUTUBE_CHANNEL_ID,
    auto_publish: process.env.AUTO_PUBLISH === 'true',
  }).catch(err => console.error('[Director poller]', err.message));

  console.log('[Boot] Scout + Director poller running');
}

startBackgroundServices();

// ── /makevideo ───────────────────────────────────────────────────────────────

export const makeVideoCommand = {
  data: new SlashCommandBuilder()
    .setName('makevideo')
    .setDescription('Generate a full YouTube video end-to-end')
    .addStringOption(o =>
      o.setName('topic').setDescription('What the video is about').setRequired(true))
    .addIntegerOption(o =>
      o.setName('duration').setDescription('Target length in minutes (8-12 recommended)')
        .setRequired(true).setMinValue(3).setMaxValue(30))
    .addStringOption(o =>
      o.setName('style').setDescription('Visual and narrative style').setRequired(true)
        .addChoices(
          { name: 'Yarnhub (military history)', value: 'Yarnhub' },
          { name: 'Kurzgesagt (explainer)', value: 'Kurzgesagt' },
          { name: 'Oversimplified (comedy history)', value: 'Oversimplified' },
          { name: 'Documentary', value: 'documentary' },
        ))
    .addStringOption(o =>
      o.setName('script').setDescription('(Optional) Paste a raw script to refine instead of generating from scratch').setRequired(false))
    .addBooleanOption(o =>
      o.setName('publish').setDescription('Auto-publish to YouTube when done? (default: yes)').setRequired(false))
    .addStringOption(o =>
      o.setName('schedule').setDescription('(Optional) Schedule publish time, e.g. "2026-04-01T18:00:00Z"').setRequired(false)),

  async execute(interaction: any) {
    const topic      = interaction.options.getString('topic');
    const duration   = interaction.options.getInteger('duration');
    const style      = interaction.options.getString('style');
    const rawScript  = interaction.options.getString('script') || undefined;
    const publish    = interaction.options.getBoolean('publish') ?? true;
    const scheduleAt = interaction.options.getString('schedule') || undefined;

    await interaction.deferReply();
    await interaction.editReply(
      `🎬 **Pipeline started!**\n` +
      `**Topic:** ${topic}\n` +
      `**Duration:** ${duration} min · **Style:** ${style}\n` +
      `**Mode:** ${rawScript ? 'Script refinement' : 'Full generation'}\n` +
      `**Publish:** ${publish ? (scheduleAt ? `Scheduled ${scheduleAt}` : 'Auto-publish') : 'Manual'}\n\n` +
      `_Phases: Research → Script → Voiceover + Scenes → Assembly → Publish_\n` +
      `_Estimated time: ${duration * 2}-${duration * 3} minutes_`
    );

    runVideoPipeline({
      topic,
      duration_minutes: duration,
      style,
      raw_script: rawScript,
      auto_publish: publish,
      schedule_at: scheduleAt,
      channel_id: process.env.YOUTUBE_CHANNEL_ID,
      discord_channel_id: interaction.channelId,
      discord_user_id: interaction.user.id,
    }).catch(async err => {
      await interaction.followUp(`❌ Pipeline failed: ${err.message}`);
    });
  },
};

// ── /research ────────────────────────────────────────────────────────────────

export const researchCommand = {
  data: new SlashCommandBuilder()
    .setName('research')
    .setDescription('Research a topic via Manus before making a video')
    .addStringOption(o =>
      o.setName('topic').setDescription('Topic to research').setRequired(true))
    .addStringOption(o =>
      o.setName('style').setDescription('Target style').setRequired(false)),

  async execute(interaction: any) {
    const topic = interaction.options.getString('topic');
    const style = interaction.options.getString('style') || 'documentary';

    await interaction.deferReply();
    await interaction.editReply(`🔍 Manus is researching **"${topic}"**...`);

    const report = await researchTopic(topic, style);

    await interaction.editReply(
      `📊 **Research complete: "${topic}"**\n\n` +
      `**Best title:** ${report.suggested_title}\n` +
      `**Hook:** ${report.suggested_hook}\n\n` +
      `**Content gaps (what competitors missed):**\n` +
      report.content_gaps.slice(0, 4).map(g => `• ${g}`).join('\n') + '\n\n' +
      `_Run \`/makevideo topic:"${topic}"\` to turn this into a video_`
    );
  },
};

// ── /watchvideo ───────────────────────────────────────────────────────────────

export const watchVideoCommand = {
  data: new SlashCommandBuilder()
    .setName('watchvideo')
    .setDescription('Have Manus watch a YouTube video and analyze it')
    .addStringOption(o =>
      o.setName('url').setDescription('YouTube URL').setRequired(true))
    .addStringOption(o =>
      o.setName('question').setDescription('What to extract / analyze').setRequired(true)),

  async execute(interaction: any) {
    const url      = interaction.options.getString('url');
    const question = interaction.options.getString('question');

    await interaction.deferReply();
    await interaction.editReply(`👁️ Manus is watching the video...`);

    const analysis = await analyzeYouTubeVideo(url, question);

    // Split if too long for Discord's 2000 char limit
    const chunks = splitForDiscord(`📹 **Video Analysis**\n\n${analysis}`, 1900);
    await interaction.editReply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp(chunks[i]);
    }
  },
};

// ── /scoutstatus ──────────────────────────────────────────────────────────────

export const scoutStatusCommand = {
  data: new SlashCommandBuilder()
    .setName('scoutstatus')
    .setDescription('Check how many Scout briefs are queued and waiting'),

  async execute(interaction: any) {
    const { default: redis } = await import('./utils/redis');
    const queueLength = await redis.llen('scout:briefs');
    const seenCount   = await redis.scard('scout:seen_urls');

    await interaction.reply(
      `📋 **Scout Status**\n\n` +
      `**Briefs queued:** ${queueLength}\n` +
      `**URLs already seen:** ${seenCount}\n\n` +
      `_Scout runs every ${process.env.SCOUT_INTERVAL_MINUTES || 60} minutes_`
    );
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitForDiscord(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

// Start Discord bot
import { Client, GatewayIntentBits, Events } from 'discord.js';
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'makevideo') await makeVideoCommand.execute(interaction);
  if (interaction.commandName === 'research') await researchCommand.execute(interaction);
  if (interaction.commandName === 'watchvideo') await watchVideoCommand.execute(interaction);
  if (interaction.commandName === 'scoutstatus') await scoutStatusCommand.execute(interaction);
});

client.once(Events.ClientReady, () => {
  console.log(`[Discord] Logged in as ${client.user?.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);
