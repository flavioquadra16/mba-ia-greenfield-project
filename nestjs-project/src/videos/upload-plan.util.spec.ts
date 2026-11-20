import { downloadFilename, expectedPartCount } from './upload-plan.util';

const PART = 64 * 1024 * 1024;
const TEN_GB = 10 * 1024 * 1024 * 1024;

describe('expectedPartCount', () => {
  it('uses one part for a file smaller than the part size', () => {
    expect(expectedPartCount(1, PART)).toBe(1);
  });

  it('uses one part when the file is exactly one part', () => {
    expect(expectedPartCount(PART, PART)).toBe(1);
  });

  it('splits 10GiB into 160 parts of 64MiB', () => {
    expect(expectedPartCount(TEN_GB, PART)).toBe(160);
  });
});

describe('downloadFilename', () => {
  it('keeps a safe basename and the extension', () => {
    expect(downloadFilename('My Video!', 'mp4')).toBe('My-Video.mp4');
  });

  it('falls back when the title has no safe characters', () => {
    expect(downloadFilename('!!!', 'webm')).toBe('video.webm');
  });
});
