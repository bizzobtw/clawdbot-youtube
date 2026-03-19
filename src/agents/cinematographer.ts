// agents/cinematographer.ts
// SUB-3: Generates all scene images in parallel batches
// Uses Gemini Imagen for primary generation, NanoBanana as fallback

import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { trackCost, sendMessage } from '../utils/dashboard';
import { uploadFile } from '../utils/storage';
import type { Storyboard, Scene } from '../types/storyboard';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// How many scenes to generate simultaneously
// Keep at 3-5 to avoid rate limits
const PARALLEL_BATCH_SIZE = 4;

export async function generateScenes(storyboard: Storyboard): Promise<string[]> {
  const scenes = storyboard.scenes;
  const scenePaths: string[] = new Array(scenes.length);

  console.log(`[Cinematographer] Generating ${scenes.length} scenes in batches of ${PARALLEL_BATCH_SIZE}`);

  // Split into batches and process in parallel
  for (let i = 0; i < scenes.length; i += PARALLEL_BATCH_SIZE) {
    const batch = scenes.slice(i, i + PARALLEL_BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map((scene, batchIndex) =>
        generateOneScene(scene, storyboard.character_bible, storyboard.video_id)
          .then(imgPath => {
            scenePaths[i + batchIndex] = imgPath;
            return imgPath;
          })
      )
    );

    // Log progress
    const completed = i + batch.length;
    await sendMessage('master', `Scenes rendered: ${completed}/${scenes.length}`);

    // Handle any failures — use placeholder for failed scenes
    batchResults.forEach((result, batchIndex) => {
      if (result.status === 'rejected') {
        console.error(`[Cinematographer] Scene ${i + batchIndex + 1} failed:`, result.reason);
        scenePaths[i + batchIndex] = 'FAILED'; // editor will handle this
      }
    });

    // Small delay between batches to respect rate limits
    if (i + PARALLEL_BATCH_SIZE < scenes.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const successCount = scenePaths.filter(p => p !== 'FAILED').length;
  console.log(`[Cinematographer] Done: ${successCount}/${scenes.length} scenes generated`);

  return scenePaths;
}

async function generateOneScene(
  scene: Scene,
  characterBible: string,
  videoId: string
): Promise<string> {

  // Combine the character bible with the scene-specific prompt
  // This is the Ryker Method — every image stays visually consistent
  const fullPrompt = `${characterBible}

SCENE: ${scene.visual_description}

Technical requirements: 16:9 aspect ratio, high resolution, cinematic quality, 
no text overlays, no watermarks, suitable for video background.
Style tags: ${scene.style_tags.join(', ')}`;

  let imageBuffer: Buffer;

  try {
    // Primary: Gemini Imagen
    imageBuffer = await generateWithGemini(fullPrompt);
    await trackCost('gemini', 0.004); // ~$0.004 per image with Imagen
  } catch (geminiErr) {
    console.warn(`[Cinematographer] Gemini failed for scene ${scene.scene_number}, trying NanoBanana`);
    try {
      // Fallback: NanoBanana
      imageBuffer = await generateWithNanaBanana(fullPrompt);
      await trackCost('nanobanana', 0.02);
    } catch (nbErr) {
      throw new Error(`Both image generators failed for scene ${scene.scene_number}`);
    }
  }

  // Save and upload
  const filename = `scene_${String(scene.scene_number).padStart(2, '0')}.png`;
  const tmpPath = path.join('/tmp', `${videoId}_${filename}`);
  fs.writeFileSync(tmpPath, imageBuffer);

  const storagePath = await uploadFile(tmpPath, `scenes/${videoId}/${filename}`);
  return storagePath;
}

async function generateWithGemini(prompt: string): Promise<Buffer> {
  // Using Gemini's image generation model
  const model = genAI.getGenerativeModel({ model: 'imagen-3.0-generate-001' });

  const result = await (model as any).generateImages({
    prompt,
    numberOfImages: 1,
    aspectRatio: '16:9',
    safetySetting: 'block_only_high',
  });

  if (!result.images?.[0]?.imageBytes) {
    throw new Error('Gemini returned no image data');
  }

  return Buffer.from(result.images[0].imageBytes, 'base64');
}

async function generateWithNanaBanana(prompt: string): Promise<Buffer> {
  // NanoBanana API — adjust endpoint/params to match their actual API
  const response = await fetch('https://api.nanabanana.pro/v1/generate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NANABANANA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      width: 1920,
      height: 1080,
      steps: 30,
      cfg_scale: 7,
    }),
  });

  if (!response.ok) {
    throw new Error(`NanaBanana error: ${response.status}`);
  }

  const data = await response.json();
  return Buffer.from(data.image_base64, 'base64');
}
