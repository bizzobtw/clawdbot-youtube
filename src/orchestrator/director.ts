// orchestrator/director.ts  (UPDATED)
// Handles two workflows:
//   1. ORIGINAL: user gives topic → full pipeline
//   2. REMAKE:   Scout drops a brief → Director picks it up and remakes it

import { v4 as uuid } from 'uuid';
import redis from '../utils/redis';
import { heartbeat, sendMessage, pushTask, alert } from '../utils/dashboard';
import { generateScript } from '../agents/writer';
import { generateVoiceover } from '../agents/narrator';
import { generateScenes } from '../agents/cinematographer';
import { assembleVideo } from '../agents/editor';
import { researchTopic } from '../agents/researcher';
import { publishVideo } from '../agents/publisher';
import type { PipelineJob } from '../types/storyboard';
import type { RemakeBrief } from '../agents/scout';

// ── Workflow 1: Original content ─────────────────────────────────────────────

export async function runVideoPipeline(request: {
  topic: string;
  duration_minutes: number;
  style: string;
  raw_script?: string;           // optional — user provides their own script to refine
  channel_id?: string;           // which YouTube channel to post to
  auto_publish?: boolean;
  schedule_at?: string;          // ISO timestamp to schedule the publish
  discord_channel_id: string;
  discord_user_id: string;
}): Promise<PipelineJob> {

  const job = initJob(request);
  await saveJob(job);
  await heartbeat('busy', `Pipeline: "${request.topic}"`);

  try {
    // Phase 0: Research (skip if raw script provided — user already knows what they want)
    let research;
    if (!request.raw_script) {
      await updateStatus(job, 'writing', '🔍 SUB-4 researching topic via Manus...');
      try {
        research = await researchTopic(request.topic, request.style);
      } catch {
        console.warn('[Director] Research unavailable, proceeding without it');
      }
    }

    // Phase 1: Script + Storyboard
    await updateStatus(job, 'writing', '✍️ SUB-1 generating script and storyboard...');
    const storyboard = await generateScript({
      topic: request.topic,
      duration_minutes: request.duration_minutes,
      style: request.style,
      raw_script: request.raw_script,
      research,
    });

    job.storyboard = storyboard;
    await saveJob(job);
    await sendMessage('master', `Script ready: ${storyboard.scenes.length} scenes, ~${Math.round(storyboard.total_estimated_duration / 60)} min`);

    // Phases 2+3: Voiceover + Scenes in parallel
    await runProductionPhases(job);

    // Phase 4: Publish
    if (request.auto_publish !== false) {
      await runPublishPhase(job, {
        channel_id: request.channel_id,
        schedule_at: request.schedule_at,
        privacy: request.schedule_at ? 'private' : 'public',
      });
    }

    await finalize(job, request.discord_channel_id);
    return job;

  } catch (err: any) {
    return handleError(job, err);
  }
}

// ── Workflow 2: Remake from Scout brief ──────────────────────────────────────

export async function runRemakeWorkflow(brief: RemakeBrief, options: {
  channel_id?: string;
  auto_publish?: boolean;
  schedule_at?: string;
  discord_channel_id: string;
  discord_user_id: string;
}): Promise<PipelineJob> {

  console.log(`[Director] Remake workflow: ${brief.brief_id}`);
  await sendMessage('master', `📋 Starting remake: "${brief.suggested_title}"`);

  const job = initJob({
    topic: brief.suggested_title,
    duration_minutes: brief.target_duration_minutes,
    style: brief.suggested_style,
  });
  job.source_brief_id = brief.brief_id;
  await saveJob(job);
  await heartbeat('busy', `Remake: "${brief.suggested_title}"`);

  try {
    // Skip research — Scout brief already contains competitive intelligence
    // Pass the adapted summary to Writer as a seed — it rewrites into a full storyboard
    await updateStatus(job, 'writing', '✍️ SUB-1 adapting script from Scout brief...');

    const storyboard = await generateScript({
      topic: brief.suggested_title,
      duration_minutes: brief.target_duration_minutes,
      style: brief.suggested_style,
      raw_script: buildRemakePrompt(brief),
    });

    job.storyboard = storyboard;
    await saveJob(job);

    // Rest of pipeline identical to original workflow
    await runProductionPhases(job);

    if (options.auto_publish !== false) {
      await runPublishPhase(job, {
        channel_id: options.channel_id,
        schedule_at: options.schedule_at,
        privacy: options.schedule_at ? 'private' : 'public',
      });
    }

    await finalize(job, options.discord_channel_id);
    return job;

  } catch (err: any) {
    return handleError(job, err);
  }
}

// ── Scout brief poller ───────────────────────────────────────────────────────
// Runs continuously — blocks on Redis until Scout drops a brief, then remakes it

export async function pollScoutBriefs(options: {
  discord_channel_id: string;
  discord_user_id: string;
  channel_id?: string;
  auto_publish?: boolean;
  schedule_at?: string;
}): Promise<void> {

  console.log('[Director] Watching for Scout briefs...');

  while (true) {
    // BRPOP blocks until data arrives — zero CPU usage while waiting
    const result = await redis.brpop('scout:briefs', 60);

    if (result) {
      const [, briefJson] = result;
      const brief: RemakeBrief = JSON.parse(briefJson);
      console.log(`[Director] Brief received: ${brief.brief_id}`);

      // Fire and forget — keep polling for more briefs
      runRemakeWorkflow(brief, options).catch(err => {
        console.error('[Director] Remake failed:', err.message);
      });
    }
  }
}

// ── Shared production phases ─────────────────────────────────────────────────

async function runProductionPhases(job: PipelineJob) {
  await updateStatus(job, 'narrating', '🎙️+🎨 Voiceover and scenes generating in parallel...');

  const [voiceoverPath, scenePaths] = await Promise.all([
    generateVoiceover(job.storyboard!).then(p => {
      sendMessage('master', '🎙️ Voiceover complete');
      return p;
    }),
    generateScenes(job.storyboard!).then(p => {
      sendMessage('master', `🎨 All ${p.length} scenes rendered`);
      return p;
    }),
  ]);

  job.voiceover_path = voiceoverPath;
  job.scene_paths = scenePaths;
  await saveJob(job);

  await updateStatus(job, 'assembling', '🎬 Editor assembling final video with FFmpeg...');
  const videoPath = await assembleVideo({
    storyboard: job.storyboard!,
    voiceoverPath,
    scenePaths,
  });

  job.final_video_path = videoPath;
  await saveJob(job);
}

async function runPublishPhase(job: PipelineJob, opts: {
  channel_id?: string;
  schedule_at?: string;
  privacy?: 'private' | 'unlisted' | 'public';
}) {
  await updateStatus(job, 'publishing', '📤 SEO agent publishing to YouTube...');

  const result = await publishVideo({
    video_path: job.final_video_path!,
    storyboard: job.storyboard!,
    channel_id: opts.channel_id,
    privacy: opts.privacy || 'public',
    schedule_at: opts.schedule_at,
  });

  job.publish_result = result;
  await saveJob(job);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildRemakePrompt(brief: RemakeBrief): string {
  return `REMAKE BRIEF — use this as research and inspiration, NOT as copy-paste:

Source: ${brief.source_url}
Why it went viral: ${brief.virality_reason}
Core narrative to adapt: ${brief.adapted_script_summary}
Key points to cover: ${brief.key_points.join(' | ')}
Original hook to rewrite in our style: "${brief.hook}"
Visual style of original: ${brief.identified_visual_style}

IMPORTANT: Create a completely original script covering the same topic.
Do not plagiarize. Rewrite everything in our style with our own angle.`;
}

function initJob(request: any): PipelineJob {
  return {
    job_id: uuid(),
    status: 'queued',
    request,
    started_at: new Date().toISOString(),
  };
}

async function updateStatus(job: PipelineJob, status: PipelineJob['status'], message: string) {
  job.status = status;
  await saveJob(job);
  await pushTask({ id: `${job.job_id}-${status}`, name: message, assignedTo: 'pipeline', priority: 'med' });
  console.log(`[Director][${job.job_id}] ${message}`);
}

async function saveJob(job: PipelineJob) {
  await redis.hset('pipeline:jobs', job.job_id, JSON.stringify(job));
  await redis.publish('dashboard:tasks', JSON.stringify({ type: 'pipeline_update', job, ts: Date.now() }));
}

async function finalize(job: PipelineJob, discordChannelId: string) {
  job.status = 'done';
  job.completed_at = new Date().toISOString();
  await saveJob(job);
  await heartbeat('idle');

  const url = job.publish_result?.video_url || job.final_video_path || 'see dashboard';
  await redis.publish('discord:send', JSON.stringify({
    channelId: discordChannelId,
    message: `🎬 **Video Complete!**\n**Title:** ${job.storyboard?.title}\n**URL:** ${url}`,
  }));
}

async function handleError(job: PipelineJob, err: Error): Promise<PipelineJob> {
  job.status = 'error';
  job.error = err.message;
  await saveJob(job);
  await alert(`Pipeline failed: ${err.message}`, 'error');
  await heartbeat('error', `Failed: ${err.message}`);
  throw err;
}
