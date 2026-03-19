// agents/scout.ts
// The "Trend Hunter" — runs on a schedule, finds viral content,
// generates remake_brief.json files that trigger the Director automatically

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import redis from '../utils/redis';
import { heartbeat, sendMessage, alert, trackCost } from '../utils/dashboard';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ────────────────────────────────────────────────────────────────────

export interface RemakeBrief {
  brief_id: string;
  source_url: string;
  platform: 'youtube' | 'x';
  original_metrics: {
    views: number;
    likes: number;
    shares?: number;
  };
  adapted_script_summary: string;    // core narrative rewritten for our style
  identified_visual_style: string;   // what the original looks like visually
  hook: string;                      // the opening line that made it viral
  key_points: string[];              // main arguments/sections
  target_duration_minutes: number;   // suggested length for our remake
  suggested_style: string;           // e.g. "Yarnhub", "documentary"
  suggested_title: string;
  virality_reason: string;           // WHY this content went viral
  created_at: string;
}

export interface ScoutConfig {
  keywords: string[];
  creator_accounts?: string[];       // specific YouTube channels or X accounts to watch
  virality_threshold: {
    min_views: number;
    min_likes: number;
  };
  target_style: string;             // what style to adapt found content into
  check_interval_minutes: number;   // how often to scan (default: 60)
}

// ── Main Scout loop ──────────────────────────────────────────────────────────

export async function runScout(config: ScoutConfig): Promise<void> {
  console.log('[Scout] Starting trend hunter...');

  while (true) {
    try {
      await heartbeat('busy', 'Scanning for viral content...');
      const briefs = await scanForTrends(config);

      for (const brief of briefs) {
        // Save brief to Redis — Director polls this queue
        await redis.lpush('scout:briefs', JSON.stringify(brief));
        await sendMessage('master', `🔥 Viral content found: "${brief.suggested_title}" (${formatViews(brief.original_metrics.views)} views)`);
        console.log(`[Scout] Brief queued: ${brief.brief_id}`);
      }

      await heartbeat('idle');
    } catch (err: any) {
      console.error('[Scout] Error:', err.message);
      await alert(`Scout error: ${err.message}`, 'error');
    }

    // Wait for next scan
    const waitMs = config.check_interval_minutes * 60 * 1000;
    console.log(`[Scout] Next scan in ${config.check_interval_minutes} minutes`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// ── Scanning logic ───────────────────────────────────────────────────────────

async function scanForTrends(config: ScoutConfig): Promise<RemakeBrief[]> {
  const briefs: RemakeBrief[] = [];

  // Use Manus via Telegram to do the actual scraping
  // Manus can watch videos, read threads, and extract content
  const manusResults = await askManusToScan(config);

  for (const result of manusResults) {
    // Check virality threshold
    if (
      result.views >= config.virality_threshold.min_views &&
      result.likes >= config.virality_threshold.min_likes
    ) {
      // Check if we've already processed this URL
      const alreadySeen = await redis.sismember('scout:seen_urls', result.url);
      if (alreadySeen) continue;

      // Generate the remake brief
      const brief = await generateRemakeBrief(result, config.target_style);
      briefs.push(brief);

      // Mark as seen so we don't process it again
      await redis.sadd('scout:seen_urls', result.url);
      await redis.expire('scout:seen_urls', 60 * 60 * 24 * 30); // 30 day memory
    }
  }

  return briefs;
}

// ── Manus integration for scraping ──────────────────────────────────────────

async function askManusToScan(config: ScoutConfig): Promise<Array<{
  url: string;
  platform: 'youtube' | 'x';
  title: string;
  transcript: string;
  views: number;
  likes: number;
  visual_style_notes: string;
}>> {

  const telegramClient = new TelegramClient(
    new StringSession(process.env.SUB4_TELEGRAM_SESSION!),
    parseInt(process.env.TELEGRAM_API_ID!),
    process.env.TELEGRAM_API_HASH!,
    { connectionRetries: 3 }
  );
  await telegramClient.connect();

  const keywordList = config.keywords.join('", "');
  const accountList = config.creator_accounts?.join(', ') || 'none specified';

  const prompt = `Search YouTube and X (Twitter) for trending content. Do all of this:

KEYWORDS TO SEARCH: "${keywordList}"
CREATOR ACCOUNTS TO CHECK: ${accountList}
VIRALITY THRESHOLD: At least ${formatViews(config.virality_threshold.min_views)} views AND ${formatViews(config.virality_threshold.min_likes)} likes

For each piece of viral content you find (up to 5 results):
1. Get the URL
2. Get the view count and like count  
3. Watch the video / read the thread and extract the full transcript or text
4. Note the visual style (animation type, color palette, camera style, etc.)
5. Identify the hook (what grabs attention in the first 30 seconds)

Return as a JSON array:
[
  {
    "url": "https://...",
    "platform": "youtube" or "x",
    "title": "content title",
    "transcript": "full transcript or thread text",
    "views": 1234567,
    "likes": 98765,
    "visual_style_notes": "description of visual style"
  }
]

Return ONLY the JSON array, nothing else.`;

  const result = await sendToManus(telegramClient, prompt, 8 * 60 * 1000);
  await telegramClient.disconnect();
  await trackCost('manus', 0.20);

  try {
    const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.warn('[Scout] Could not parse Manus response as JSON');
    return [];
  }
}

// ── Brief generation ─────────────────────────────────────────────────────────

async function generateRemakeBrief(
  source: {
    url: string;
    platform: 'youtube' | 'x';
    title: string;
    transcript: string;
    views: number;
    likes: number;
    visual_style_notes: string;
  },
  targetStyle: string
): Promise<RemakeBrief> {

  const prompt = `Analyze this viral content and create a remake brief for a YouTube video.

SOURCE URL: ${source.url}
PLATFORM: ${source.platform}
ORIGINAL TITLE: ${source.title}
VIEWS: ${source.views.toLocaleString()} | LIKES: ${source.likes.toLocaleString()}
VISUAL STYLE: ${source.visual_style_notes}

TRANSCRIPT/CONTENT:
${source.transcript.slice(0, 4000)} ${source.transcript.length > 4000 ? '...[truncated]' : ''}

TARGET STYLE FOR REMAKE: ${targetStyle}

Generate a remake brief. Return ONLY valid JSON:
{
  "adapted_script_summary": "Rewrite the core narrative in our target style. Keep the same key facts and story arc but make it feel original. 300-500 words.",
  "identified_visual_style": "Describe the original visual style in detail",
  "hook": "The single most compelling opening line/question from the original",
  "key_points": ["point 1", "point 2", "point 3", "...up to 7 key points"],
  "target_duration_minutes": 10,
  "suggested_style": "${targetStyle}",
  "suggested_title": "A new, original title for our remake that won't be flagged as a copy",
  "virality_reason": "In 2-3 sentences, explain WHY this content went viral"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', // cheap for parsing tasks
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  await trackCost('anthropic', (response.usage.output_tokens / 1000) * 0.0008);

  const parsed = JSON.parse(clean);

  return {
    brief_id: uuid(),
    source_url: source.url,
    platform: source.platform,
    original_metrics: {
      views: source.views,
      likes: source.likes,
    },
    created_at: new Date().toISOString(),
    ...parsed,
  };
}

// ── Telegram helper ──────────────────────────────────────────────────────────

async function sendToManus(client: TelegramClient, prompt: string, timeoutMs: number): Promise<string> {
  const MANUS_USERNAME = process.env.MANUS_TELEGRAM_USERNAME || 'ManusAIBot';
  const { NewMessage } = await import('telegram/events');

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Manus timeout')), timeoutMs);
    let buffer = '';
    let silenceTimer: NodeJS.Timeout;

    const handler = async (event: any) => {
      const msg = event.message;
      const sender = await msg.getSender();
      if ((sender as any)?.username !== MANUS_USERNAME) return;

      buffer += (buffer ? '\n' : '') + msg.text;
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        clearTimeout(timeout);
        client.removeEventHandler(handler, new NewMessage({}));
        resolve(buffer);
      }, 3000);
    };

    client.addEventHandler(handler, new NewMessage({}));
    await client.sendMessage(MANUS_USERNAME, { message: prompt });
  });
}

function formatViews(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toString();
}
