// agents/narrator.ts
// SUB-2: Converts the script to audio using ElevenLabs API

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import fs from 'fs';
import path from 'path';
import { trackCost } from '../utils/dashboard';
import { uploadFile } from '../utils/storage';
import type { Storyboard } from '../types/storyboard';

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// Voice presets — find voice IDs at elevenlabs.io/voice-library
// These are example IDs, replace with your chosen voices
const VOICE_PRESETS: Record<string, string> = {
  'Yarnhub':      'pNInz6obpgDQGcFmaJgB', // deep, authoritative male
  'Kurzgesagt':   'EXAVITQu4vr4xnSDxMaL', // clear, enthusiastic
  'documentary':  'VR6AewLTigWG4xSOukaG', // neutral documentary narrator
  'default':      'pNInz6obpgDQGcFmaJgB',
};

export async function generateVoiceover(storyboard: Storyboard): Promise<string> {
  const voiceId = VOICE_PRESETS[storyboard.style] || VOICE_PRESETS['default'];

  // Concatenate all scene narration with natural pauses between scenes
  const fullScript = storyboard.scenes
    .map(scene => scene.narration_text)
    .join('\n\n<break time="0.8s" />\n\n');  // ElevenLabs SSML pause between scenes

  console.log(`[Narrator] Generating voiceover: ${fullScript.length} characters`);

  // Generate audio
  const audioStream = await elevenlabs.textToSpeech.convert(voiceId, {
    text: fullScript,
    modelId: 'eleven_multilingual_v2',    // highest quality
    outputFormat: 'mp3_44100_128',
    voiceSettings: {
      stability: 0.5,          // 0-1, higher = more consistent
      similarityBoost: 0.75,   // 0-1, higher = closer to original voice
      style: 0.3,              // expressiveness
      useSpeakerBoost: true,
    },
  });

  // Save to temp file
  const outputPath = path.join('/tmp', `${storyboard.video_id}_voiceover.mp3`);
  const writeStream = fs.createWriteStream(outputPath);

  await new Promise<void>((resolve, reject) => {
    (audioStream as any).pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  // Upload to persistent storage (Railway volume or R2)
  const storagePath = await uploadFile(outputPath, `voiceovers/${storyboard.video_id}.mp3`);

  // Track cost: ElevenLabs charges per character
  const charCount = fullScript.length;
  const costPerChar = 0.0003; // ~$0.30 per 1000 chars on Creator plan
  await trackCost('elevenlabs', charCount * costPerChar);

  console.log(`[Narrator] Voiceover saved: ${storagePath} (${charCount} chars)`);
  return storagePath;
}
