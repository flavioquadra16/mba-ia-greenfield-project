import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  partSizeBytes: parseInt(process.env.VIDEO_PART_SIZE_BYTES || '67108864', 10),
  maxBytes: parseInt(process.env.VIDEO_MAX_BYTES || '10737418240', 10),
  uploadUrlExpiresSeconds: parseInt(
    process.env.VIDEO_UPLOAD_URL_EXPIRES_SECONDS || '3600',
    10,
  ),
  playbackUrlExpiresSeconds: parseInt(
    process.env.VIDEO_PLAYBACK_URL_EXPIRES_SECONDS || '900',
    10,
  ),
  processingAttempts: parseInt(
    process.env.VIDEO_PROCESSING_ATTEMPTS || '3',
    10,
  ),
}));
