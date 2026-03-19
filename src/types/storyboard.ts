// types/storyboard.ts

export interface Scene {
  scene_number: number;
  narration_text: string;
  visual_description: string;
  estimated_duration_seconds: number;
  b_roll: boolean;
  b_roll_description?: string;
  image_path?: string;
  style_tags: string[];
}

export interface Storyboard {
  video_id: string;
  title: string;
  topic: string;
  style: string;
  target_duration_seconds: number;
  total_estimated_duration: number;
  character_bible: string;       // Ryker Method — locked visual style for all scenes
  scenes: Scene[];
  created_at: string;
}

export interface PublishResult {
  video_id: string;
  video_url: string;
  title: string;
  published_at: string;
}

export interface PipelineJob {
  job_id: string;
  source_brief_id?: string;     // set if this is a Scout remake job
  status:
    | 'queued'
    | 'writing'
    | 'narrating'
    | 'rendering'
    | 'assembling'
    | 'publishing'
    | 'done'
    | 'error';
  request: {
    topic: string;
    duration_minutes: number;
    style: string;
    channel_name?: string;
  raw_script?: string; raw_script?: string;
  };
  storyboard?: Storyboard;
  voiceover_path?: string;
  scene_paths?: string[];
  final_video_path?: string;
  publish_result?: PublishResult;
  error?: string;
  started_at: string;
  completed_at?: string;
}

export interface ResearchReport {
  topic: string;
  trending_angles: string[];
  competitor_videos: Array<{
    title: string;
    channel: string;
    views: string;
    hook: string;
    why_it_works: string;
  }>;
  suggested_title: string;
  suggested_hook: string;
  content_gaps: string[];
  source_urls: string[];
}
