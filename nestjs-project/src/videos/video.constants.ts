export enum VideoStatus {
  Draft = 'draft',
  Processing = 'processing',
  Ready = 'ready',
  Error = 'error',
}

export const ALLOWED_VIDEO_CONTENT_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
] as const;

export type AllowedVideoContentType =
  (typeof ALLOWED_VIDEO_CONTENT_TYPES)[number];

const EXTENSION_BY_CONTENT_TYPE: Record<AllowedVideoContentType, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
};

export function extensionForContentType(contentType: string): string {
  return EXTENSION_BY_CONTENT_TYPE[contentType as AllowedVideoContentType];
}

export function originalObjectKey(
  videoId: string,
  contentType: string,
): string {
  return `videos/${videoId}/original.${extensionForContentType(contentType)}`;
}

export function thumbnailObjectKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
