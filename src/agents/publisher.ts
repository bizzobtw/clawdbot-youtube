// agents/publisher.ts
// The "Manager" — generates optimized SEO metadata and uploads to YouTube

import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import { trackCost, sendMessage, alert } from '../utils/dashboard';
import type { Storyboard } from '../types/storyboard';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ────────────────────────────────────────────────────────────────────

export interface SEOPackage {
  title: string;
  description: string;
  tags: string[];
  category_id: string;   // YouTube category (e.g. "27" = Education, "22" = People & Blogs)
  thumbnail_prompt: string; // prompt to generate thumbnail image
}

export interface PublishResult {
  video_id: string;
  video_url: string;
  title: string;
  published_at: string;
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function publishVideo(params: {
  video_path: string;             // local path to final_video.mp4
  storyboard: Storyboard;
  channel_id?: string;            // which YouTube channel (if you have multiple)
  privacy?: 'private' | 'unlisted' | 'public';
  schedule_at?: string;           // ISO timestamp to schedule publish (optional)
}): Promise<PublishResult> {

  const { video_path, storyboard, privacy = 'private', schedule_at } = params;

  // Step 1: Generate SEO package
  const seo = await generateSEOPackage(storyboard);

  // Step 2: Upload to YouTube
  const result = await uploadToYouTube({
    video_path,
    seo,
    privacy,
    schedule_at,
    channel_id: params.channel_id,
  });

  await sendMessage('master', `✅ Published: "${seo.title}" → ${result.video_url}`);
  return result;
}

// ── SEO Generation ───────────────────────────────────────────────────────────

export async function generateSEOPackage(storyboard: Storyboard): Promise<SEOPackage> {
  // Concatenate script for context
  const fullScript = storyboard.scenes
    .map(s => s.narration_text)
    .join(' ')
    .slice(0, 3000); // first 3000 chars for context

  const prompt = `You are a YouTube SEO expert. Generate optimized metadata for this video.

VIDEO TOPIC: ${storyboard.topic}
VIDEO TITLE (working): ${storyboard.title}
VIDEO STYLE: ${storyboard.style}
SCRIPT EXCERPT: ${fullScript}

Generate a complete SEO package. Return ONLY valid JSON:
{
  "title": "Final optimized YouTube title. Max 70 chars. Must be click-worthy AND keyword-rich. Include a number or power word if natural.",
  "description": "Full YouTube description. 400-600 words. Include:\\n- Hook paragraph (2-3 sentences)\\n- What viewers will learn (bullet points)\\n- Chapter timestamps placeholder: '00:00 Introduction\\n02:30 [section]...'\\n- Call to action (like, subscribe, comment)\\n- Relevant keywords woven naturally\\n- 3-5 relevant hashtags at the end",
  "tags": ["tag1", "tag2", "...up to 15 tags, mix of broad and specific"],
  "category_id": "27",
  "thumbnail_prompt": "Detailed image generation prompt for a thumbnail. Should be: high contrast, bold text space on left side, dramatic/eye-catching, 1280x720px. Describe the visual without text."
}

SEO RULES:
- Title should front-load the main keyword
- Description first 150 chars must be compelling (shown in search preview)
- Tags: 3-4 broad (e.g. "history"), 5-6 medium (e.g. "world war 2"), 3-4 specific (e.g. "battle of stalingrad")
- Do NOT use clickbait that misrepresents the content`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',       // use best model for SEO — it matters for revenue
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  await trackCost('anthropic', (response.usage.output_tokens / 1000) * 0.015);

  return JSON.parse(clean);
}

// ── YouTube Upload ───────────────────────────────────────────────────────────

async function uploadToYouTube(params: {
  video_path: string;
  seo: SEOPackage;
  privacy: 'private' | 'unlisted' | 'public';
  schedule_at?: string;
  channel_id?: string;
}): Promise<PublishResult> {

  const { video_path, seo, privacy, schedule_at } = params;

  // Set up OAuth2 client
  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // Build status object
  const status: any = { privacyStatus: privacy };
  if (schedule_at && privacy === 'private') {
    // YouTube requires privacyStatus = 'private' + publishAt for scheduling
    status.publishAt = schedule_at;
  }

  console.log(`[Publisher] Uploading to YouTube: "${seo.title}"`);

  const fileSize = fs.statSync(video_path).size;
  let uploadedBytes = 0;

  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: seo.title,
        description: seo.description,
        tags: seo.tags,
        categoryId: seo.category_id,
        defaultLanguage: 'en',
      },
      status,
    },
    media: {
      mimeType: 'video/mp4',
      body: fs.createReadStream(video_path).on('data', (chunk) => {
        uploadedBytes += chunk.length;
        const pct = Math.round((uploadedBytes / fileSize) * 100);
        if (pct % 10 === 0) {
          process.stdout.write(`\r[Publisher] Upload progress: ${pct}%`);
        }
      }),
    },
  });

  console.log('\n[Publisher] Upload complete');

  const videoId = response.data.id!;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  return {
    video_id: videoId,
    video_url: videoUrl,
    title: seo.title,
    published_at: new Date().toISOString(),
  };
}

// ── YouTube OAuth Setup (run once) ───────────────────────────────────────────
// Run this script locally ONCE to get your refresh token, then add to Railway env vars

export async function getRefreshToken() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    'urn:ietf:wg:oauth:2.0:oob'   // manual copy/paste flow
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
  });

  console.log('1. Open this URL in your browser:');
  console.log(authUrl);
  console.log('\n2. Authorize and paste the code here:');

  // After pasting code:
  // const { tokens } = await oauth2Client.getToken(CODE_FROM_BROWSER);
  // console.log('YOUTUBE_REFRESH_TOKEN =', tokens.refresh_token);
  // Add this to Railway env vars
}
