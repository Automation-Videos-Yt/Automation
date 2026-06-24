import { calculateRunCost } from "@youtube-automation/pricing";

console.log("60s en:");
console.log(calculateRunCost({durationSec: 60, languageCode: "en", generateThumbnail: false, generateSubtitles: false}).total);

console.log("90s es + thumb + subs:");
console.log(calculateRunCost({durationSec: 90, languageCode: "es", generateThumbnail: true, generateSubtitles: true}).total);
