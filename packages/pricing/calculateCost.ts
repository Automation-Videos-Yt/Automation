import { PRICING_RATES, PRICING_VERSION } from "./constants";
import { VideoOptions, CostSnapshot } from "./types";

export function calculateRunCost(options: VideoOptions): CostSnapshot {
  let durationCost = 0;
  if (options.durationSec > 60) {
    const extraSeconds = options.durationSec - 60;
    const extraChunks = Math.ceil(extraSeconds / 15);
    durationCost = extraChunks * PRICING_RATES.DURATION_15S;
  }

  const languageCost = options.languageCode === 'en' ? 0 : PRICING_RATES.NON_ENGLISH;
  const thumbnailCost = options.generateThumbnail ? PRICING_RATES.THUMBNAIL : 0;
  const subtitlesCost = options.generateSubtitles ? PRICING_RATES.SUBTITLES : 0;

  const total = PRICING_RATES.BASE_VIDEO + durationCost + languageCost + thumbnailCost + subtitlesCost;

  return {
    version: PRICING_VERSION,
    rates: {
      base: PRICING_RATES.BASE_VIDEO,
      duration15: PRICING_RATES.DURATION_15S,
      language: PRICING_RATES.NON_ENGLISH,
      thumbnail: PRICING_RATES.THUMBNAIL,
      subtitles: PRICING_RATES.SUBTITLES,
    },
    breakdown: {
      base: PRICING_RATES.BASE_VIDEO,
      duration: durationCost,
      language: languageCost,
      thumbnail: thumbnailCost,
      subtitles: subtitlesCost,
    },
    total,
  };
}
