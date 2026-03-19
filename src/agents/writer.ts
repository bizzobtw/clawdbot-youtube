// agents/writer.ts
// SUB-1: Generates the full script and storyboard.json using Claude

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuid } from 'uuid';
import { trackCost } from '../utils/dashboard';
import type { Storyboard, Scene, ResearchReport } from '../types/storyboard';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Style presets — add your own
const STYLE_PRESETS: Record<string, string> = {
  'Yarnhub': `Military history documentary style. Serious, precise narration. 
    Dramatic pacing. Visuals: gritty, desaturated, cinematic stills, maps, 
    period-accurate uniforms, battlefield photography aesthetic.`,

  'Kurzgesagt': `Optimistic, curious tone. Educational but accessible. 
    Visuals: flat design, bright colors, birds as characters, 
    clean infographic aesthetic, minimalist backgrounds.`,

  'Oversimplified': `Comedic take on serious history. Absurdist humor mixed with 
    real facts. Fast pacing. Visuals: simple cartoon characters, 
    exaggerated expressions, map animations.`,

  'documentary': `Neutral journalistic tone. Authoritative. 
    Visuals: cinematic photography, archival footage aesthetic, 
    dramatic lighting, realistic environments.`,
};

export async function generateScript(params: {
  topic: string;
  duration_minutes: number;
  style: string;
  research?: ResearchReport;
}): Promise<Storyboard> {

  const { topic, duration_minutes, style, research } = params;
  const styleGuide = STYLE_PRESETS[style] || STYLE_PRESETS['documentary'];
  const target_seconds = duration_minutes * 60;
  const target_words = Math.round((target_seconds / 60) * 150); // 150 wpm

  // Build the research context if available
  const researchContext = research ? `
RESEARCH FINDINGS (use these to inform the script):
- Best performing angle: ${research.suggested_hook}
- Suggested title: ${research.suggested_title}
- Content gaps to fill: ${research.content_gaps.join(', ')}
- Competing videos to differentiate from:
  ${research.competitor_videos.slice(0, 3).map(v => `  • "${v.title}" — ${v.why_it_works}`).join('\n')}
` : '';

  const prompt = `You are a professional YouTube scriptwriter. Create a complete video script.

PARAMETERS:
- Topic: ${topic}
- Style: ${style}
- Style Guide: ${styleGuide}
- Target Length: ${duration_minutes} minutes (approximately ${target_words} words)
- Target Scenes: ${Math.round(duration_minutes * 3)} scenes (about 20-30 seconds each)

${researchContext}

THE RYKER METHOD — CHARACTER BIBLE (apply to every visual prompt):
Create a consistent visual style locked across ALL scenes. Define once:
- Primary color palette (3-4 colors maximum)  
- Lighting style (e.g., "dramatic side lighting, golden hour warmth")
- Camera style (e.g., "medium shots, slight Dutch angle for tension")
- Era/setting visual anchors
Apply this bible to EVERY visual_description so all scenes look like they belong together.

OUTPUT FORMAT — respond with ONLY valid JSON, no markdown, no explanation:
{
  "video_id": "${uuid()}",
  "title": "YouTube-optimized video title",
  "topic": "${topic}",
  "style": "${style}",
  "target_duration_seconds": ${target_seconds},
  "total_estimated_duration": <sum of all scene durations>,
  "character_bible": "Full Ryker Method style description for this video",
  "scenes": [
    {
      "scene_number": 1,
      "narration_text": "The actual words spoken in this scene",
      "visual_description": "Detailed image generation prompt using the character bible style. Include: subject, environment, lighting, mood, camera angle, style tags",
      "estimated_duration_seconds": <word_count / 2.5>,
      "b_roll": false,
      "b_roll_description": null,
      "style_tags": ["cinematic", "dramatic"]
    }
  ]
}

RULES:
- Each narration_text should be 40-80 words (20-30 seconds when spoken)
- estimated_duration_seconds = word_count / 2.5 (150wpm = 2.5 words/sec)
- visual_description must be 50+ words, specific enough for AI image generation
- Mark b_roll: true for scenes needing maps, statistics, or archival-style shots
- The sum of all estimated_duration_seconds must equal approximately ${target_seconds}
- First scene MUST have a powerful hook in the narration_text
- DO NOT include any text outside the JSON`;

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Track cost (rough estimate: ~$0.015 per 1k output tokens for Opus)
  const outputTokens = response.usage.output_tokens;
  await trackCost('anthropic', (outputTokens / 1000) * 0.015);

  // Parse the JSON — strip any accidental markdown fences
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const storyboard: Storyboard = JSON.parse(clean);

  console.log(`[Writer] Script generated: ${storyboard.scenes.length} scenes, ~${Math.round(storyboard.total_estimated_duration / 60)} min`);
  return storyboard;
}
