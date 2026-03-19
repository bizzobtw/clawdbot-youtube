// agents/editor.ts
// SUB-5: Assembles the final video using FFmpeg
// Applies Ken Burns effect, overlays voiceover, renders final MP4

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { downloadFile, uploadFile } from '../utils/storage';
import { trackCost } from '../utils/dashboard';
import type { Storyboard } from '../types/storyboard';

export async function assembleVideo(params: {
  storyboard: Storyboard;
  voiceoverPath: string;
  scenePaths: string[];
}): Promise<string> {

  const { storyboard, voiceoverPath, scenePaths } = params;
  const { video_id, scenes } = storyboard;
  const workDir = `/tmp/${video_id}`;

  // Set up working directory
  fs.mkdirSync(workDir, { recursive: true });

  console.log(`[Editor] Downloading assets for ${video_id}...`);

  // Download all files from storage to local /tmp for FFmpeg
  const localVoiceover = path.join(workDir, 'voiceover.mp3');
  await downloadFile(voiceoverPath, localVoiceover);

  const localScenes: string[] = [];
  for (let i = 0; i < scenePaths.length; i++) {
    if (scenePaths[i] === 'FAILED') {
      // Use a black frame placeholder for failed scenes
      const placeholder = path.join(workDir, `scene_${String(i + 1).padStart(2, '0')}.png`);
      createBlackFrame(placeholder);
      localScenes.push(placeholder);
    } else {
      const localPath = path.join(workDir, `scene_${String(i + 1).padStart(2, '0')}.png`);
      await downloadFile(scenePaths[i], localPath);
      localScenes.push(localPath);
    }
  }

  console.log(`[Editor] Assembling ${scenes.length} scenes...`);

  // Build FFmpeg filter complex for Ken Burns + concatenation
  const filterComplex = buildKenBurnsFilter(scenes, localScenes);

  // Build FFmpeg concat list
  const concatFile = path.join(workDir, 'concat.txt');
  const outputPath = path.join(workDir, 'final_video.mp4');

  // Write the FFmpeg command
  const ffmpegArgs = buildFFmpegCommand({
    scenes,
    localScenes,
    localVoiceover,
    filterComplex,
    outputPath,
    workDir,
  });

  console.log('[Editor] Running FFmpeg...');

  await runFFmpeg(ffmpegArgs);

  // Upload final video to storage
  const storagePath = await uploadFile(outputPath, `videos/${video_id}/final.mp4`);

  // Cleanup temp files
  fs.rmSync(workDir, { recursive: true, force: true });

  console.log(`[Editor] Video assembled: ${storagePath}`);
  return storagePath;
}

// ── FFmpeg Command Builder ───────────────────────────────────────────────────

function buildFFmpegCommand(params: {
  scenes: Storyboard['scenes'];
  localScenes: string[];
  localVoiceover: string;
  filterComplex: string;
  outputPath: string;
  workDir: string;
}): string[] {

  const { scenes, localScenes, localVoiceover, filterComplex, outputPath } = params;

  const args: string[] = ['-y']; // overwrite output

  // Input: one image per scene
  for (const scenePath of localScenes) {
    args.push('-loop', '1', '-i', scenePath);
  }

  // Input: voiceover audio
  args.push('-i', localVoiceover);

  // Filter complex for Ken Burns + concatenation
  args.push('-filter_complex', filterComplex);

  // Map outputs
  args.push('-map', '[vout]');
  args.push('-map', `${localScenes.length}:a`); // voiceover is the last input

  // Output settings — YouTube-optimized
  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',      // balance quality/speed (use 'fast' on Railway to save CPU)
    '-crf', '23',             // quality (18=best, 28=worst)
    '-pix_fmt', 'yuv420p',   // required for YouTube compatibility
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '44100',
    '-movflags', '+faststart', // optimize for streaming
    '-shortest',               // stop when voiceover ends
    outputPath
  );

  return args;
}

// ── Ken Burns Effect Filter ──────────────────────────────────────────────────
// Applies subtle zoom + pan to each static image to create motion

function buildKenBurnsFilter(scenes: Storyboard['scenes'], localScenes: string[]): string {
  const W = 1920;
  const H = 1080;
  const filters: string[] = [];
  const sceneLabels: string[] = [];

  scenes.forEach((scene, i) => {
    const duration = scene.estimated_duration_seconds;
    const totalFrames = Math.round(duration * 30); // 30fps
    const label = `[v${i}]`;

    // Alternate between zoom-in and zoom-out for variety
    const isZoomIn = i % 2 === 0;

    // Scale image to slightly larger than output (allows panning/zooming)
    const scaleW = Math.round(W * 1.2);
    const scaleH = Math.round(H * 1.2);

    let zoomExpr: string;
    let xExpr: string;
    let yExpr: string;

    if (isZoomIn) {
      // Slow zoom in from 1.0 to 1.1
      zoomExpr = `1+0.1*on/${totalFrames}`;
      xExpr = `iw/2-(iw/zoom/2)`;
      yExpr = `ih/2-(ih/zoom/2)`;
    } else {
      // Slow pan left to right
      zoomExpr = '1.05';
      xExpr = `${Math.round(scaleW * 0.1)} * on/${totalFrames}`;
      yExpr = `ih/2-(ih/zoom/2)`;
    }

    // Build zoompan filter for this scene
    const filter = `[${i}:v]scale=${scaleW}:${scaleH},` +
      `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':` +
      `d=${totalFrames}:s=${W}x${H}:fps=30,` +
      `setsar=1${label}`;

    filters.push(filter);
    sceneLabels.push(label);
  });

  // Concatenate all scene clips
  const concatInput = sceneLabels.join('');
  filters.push(`${concatInput}concat=n=${scenes.length}:v=1:a=0[vout]`);

  return filters.join('; ');
}

// ── FFmpeg Runner ────────────────────────────────────────────────────────────

async function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);

    ffmpeg.stderr.on('data', (data: Buffer) => {
      // FFmpeg writes progress to stderr
      const line = data.toString();
      if (line.includes('frame=') || line.includes('time=')) {
        process.stdout.write(`\r[FFmpeg] ${line.trim()}`);
      }
    });

    ffmpeg.on('close', (code) => {
      console.log(); // newline after progress
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg exited with code ${code}`));
    });

    ffmpeg.on('error', reject);
  });
}

// Creates a black 1920x1080 placeholder PNG for failed scenes
function createBlackFrame(outputPath: string) {
  execSync(`ffmpeg -y -f lavfi -i color=black:size=1920x1080 -frames:v 1 ${outputPath}`);
}
