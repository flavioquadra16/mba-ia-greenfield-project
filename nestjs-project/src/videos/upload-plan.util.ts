export function expectedPartCount(
  sizeBytes: number,
  partSizeBytes: number,
): number {
  if (sizeBytes <= 0 || partSizeBytes <= 0) return 0;
  return Math.ceil(sizeBytes / partSizeBytes);
}

export function downloadFilename(title: string, extension: string): string {
  const base =
    title
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'video';
  return `${base}.${extension}`;
}
