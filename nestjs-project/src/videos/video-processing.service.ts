import { execFile } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { promisify } from 'util';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoMetadata } from './entities/video.entity';
import { thumbnailObjectKey, VideoStatus } from './video.constants';

const execFileAsync = promisify(execFile);

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface ProbeResult {
  format?: { duration?: string; format_name?: string };
  streams?: ProbeStream[];
}

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videos.findOne({ where: { id: videoId } });
    if (!video) return;
    if (
      video.status === VideoStatus.Ready ||
      video.status === VideoStatus.Error
    ) {
      return;
    }
    if (video.status !== VideoStatus.Processing) return;

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-'));
    const extension = extname(video.original_key) || '.mp4';
    const inputPath = join(workDir, `original${extension}`);
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.storage.downloadToFile(video.original_key, inputPath);
      const metadata = await this.probe(inputPath);
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        inputPath,
        '-vf',
        'thumbnail,scale=640:-2',
        '-frames:v',
        '1',
        thumbnailPath,
      ]);
      const thumbnailKey = thumbnailObjectKey(video.id);
      await this.storage.putFile(thumbnailKey, thumbnailPath, 'image/jpeg');
      video.duration_seconds = Math.round(metadata.duration);
      video.metadata = metadata;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.Ready;
      video.processing_error = null;
      await this.videos.save(video);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  async markFailed(videoId: string, message: string): Promise<void> {
    const video = await this.videos.findOne({ where: { id: videoId } });
    if (!video || video.status === VideoStatus.Ready) return;
    video.status = VideoStatus.Error;
    video.processing_error = message.slice(0, 2000);
    await this.videos.save(video);
  }

  private async probe(inputPath: string): Promise<VideoMetadata> {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);
    const probe = JSON.parse(stdout) as ProbeResult;
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration)) {
      throw new Error('ffprobe did not return a duration');
    }
    const videoStream = probe.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    const audioStream = probe.streams?.find(
      (stream) => stream.codec_type === 'audio',
    );
    return {
      duration,
      width: videoStream?.width ?? null,
      height: videoStream?.height ?? null,
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
      formatName: probe.format?.format_name ?? null,
    };
  }
}
