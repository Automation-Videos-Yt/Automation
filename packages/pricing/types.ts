export interface VideoOptions {
  durationSec: number;
  languageCode: string; // 'en' is base
  generateThumbnail: boolean;
  generateSubtitles: boolean;
}

export interface CostBreakdown {
  base: number;
  duration: number;
  language: number;
  thumbnail: number;
  subtitles: number;
}

export interface CostSnapshot {
  version: number;
  rates: Record<string, number>;
  breakdown: CostBreakdown;
  total: number;
}
