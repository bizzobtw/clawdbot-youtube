// agents/researcher.ts
// SUB-4: Delegates research to Manus via Telegram
// Manus can watch YouTube videos, scrape TikTok, analyze competitors

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage } from 'telegram/events';
import { trackCost, heartbeat, sendMessage } from '../utils/dashboard';
import type { ResearchReport } from '../types/storyboard';

// Initialize Telegram client using your dedicated research account
// Session string is generated once locally (see setup guide)
const client = new TelegramClient(
  new StringSession(process.env.SUB4_TELEGRAM_SESSION!),
  parseInt(process.env.TELEGRAM_API_ID!),
  process.env.TELEGRAM_API_HASH!,
  { connectionRetries: 5 }
);

let isConnected = false;

async function ensureConnected() {
  if (!isConnected) {
    await client.connect();
    isConnected = true;
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function researchTopic(topic: string, style: string): Promise<ResearchReport> {
  await ensureConnected();
  await heartbeat('busy', `Researching: "${topic}"`);

  const prompt = buildResearchPrompt(topic, style);
  const rawResult = await askManus(prompt, 4 * 60 * 1000); // 4 min timeout

  // Parse Manus's response into our ResearchReport structure
  const report = await parseResearchResponse(rawResult, topic, style);

  await sendMessage('master', `Research done for "${topic}": ${report.suggested_title}`);
  await trackCost('manus', 0.10); // estimate per research task
  await heartbeat('idle');

  return report;
}

// Watch a YouTube video and extract insights
export async function analyzeYouTubeVideo(url: string, question: string): Promise<string> {
  await ensureConnected();
  await heartbeat('busy', `Analyzing YouTube: ${url}`);

  const prompt = `Watch this YouTube video: ${url}

Then provide:
1. Full summary of the video content
2. Script structure breakdown (intro, sections, outro)
3. Hook used in the first 30 seconds
4. Pacing and editing style notes
5. Answer this specific question: ${question}

Format as structured text with clear sections.`;

  const result = await askManus(prompt, 6 * 60 * 1000); // 6 min for video analysis
  await trackCost('manus', 0.15);
  await heartbeat('idle');

  return result;
}

// Research trending content in a niche
export async function findTrendingContent(niche: string): Promise<string> {
  await ensureConnected();

  const prompt = `Research what's currently trending on YouTube in the "${niche}" niche.

Find:
1. Top 10 most-viewed videos in this niche from the past 30 days
2. Common video formats and structures being used
3. Most effective thumbnail styles
4. Most common hooks in the first 10 seconds
5. Average video length that performs best
6. Key topics that haven't been covered yet (content gaps)

Return as structured data I can use for video planning.`;

  const result = await askManus(prompt, 5 * 60 * 1000);
  await trackCost('manus', 0.10);
  return result;
}

// ── Core Manus communication ─────────────────────────────────────────────────

async function askManus(prompt: string, timeoutMs: number = 5 * 60 * 1000): Promise<string> {
  const MANUS_USERNAME = process.env.MANUS_TELEGRAM_USERNAME || 'ManusAIBot';

  return new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Manus timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    // Set up listener BEFORE sending (avoid race condition)
    let responseBuffer = '';
    let responseTimer: NodeJS.Timeout;

    const handler = async (event: any) => {
      const msg = event.message;
      if (!msg) return;

      const sender = await msg.getSender();
      if ((sender as any)?.username !== MANUS_USERNAME) return;

      // Manus sometimes sends multiple messages for long responses
      // Buffer them and wait 3s of silence before resolving
      responseBuffer += (responseBuffer ? '\n' : '') + msg.text;

      clearTimeout(responseTimer);
      responseTimer = setTimeout(() => {
        clearTimeout(timeout);
        client.removeEventHandler(handler, new NewMessage({}));
        resolve(responseBuffer);
      }, 3000); // 3s of silence = response complete
    };

    client.addEventHandler(handler, new NewMessage({}));

    // Send the task to Manus
    await client.sendMessage(MANUS_USERNAME, { message: prompt });
    console.log(`[Researcher] Task sent to Manus (${prompt.length} chars)`);
  });
}

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildResearchPrompt(topic: string, style: string): string {
  return `I need research for a YouTube video. Do all of this in one task:

TOPIC: "${topic}"
TARGET STYLE: ${style}

1. Search YouTube for the top 10 videos about this topic. For each, note:
   - Title, channel, approximate view count
   - The hook used in the first 30 seconds
   - Why it performed well

2. Identify 3-5 content gaps — important angles about this topic that nobody has covered well yet

3. Suggest the single best angle/approach for a NEW video that would stand out

4. Write one killer YouTube title for that angle (optimized for clicks + SEO)

5. Write one killer opening hook sentence (first line of the video script)

Return everything as structured text with clear headings. Be specific and actionable.`;
}

// ── Response parser ──────────────────────────────────────────────────────────

async function parseResearchResponse(
  raw: string,
  topic: string,
  style: string
): Promise<ResearchReport> {

  // Use Claude to parse Manus's free-text response into structured data
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', // cheap model for parsing
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Extract structured data from this research report. Return ONLY valid JSON:

${raw}

JSON structure:
{
  "topic": "${topic}",
  "trending_angles": ["angle1", "angle2"],
  "competitor_videos": [
    { "title": "", "channel": "", "views": "", "hook": "", "why_it_works": "" }
  ],
  "suggested_title": "",
  "suggested_hook": "",
  "content_gaps": ["gap1", "gap2"],
  "source_urls": []
}`
    }]
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch {
    // If parsing fails, return a minimal valid report
    return {
      topic,
      trending_angles: [],
      competitor_videos: [],
      suggested_title: `The ${topic} Explained`,
      suggested_hook: `What if everything you knew about ${topic} was wrong?`,
      content_gaps: [],
      source_urls: [],
    };
  }
}
