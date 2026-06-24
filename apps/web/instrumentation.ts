import { registerOTel } from '@vercel/otel';

export function register() {
  registerOTel('youtube_automation_web');
}
