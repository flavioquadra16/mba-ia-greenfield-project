import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import videoConfig from '../config/video.config';
import {
  ChannelNotFoundException,
  InvalidUploadPartsException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoUploadNotPendingException,
} from '../common/exceptions/domain.exception';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessingJob,
} from '../queue/video-processing.constants';
import {
  PresignedGet,
  PresignedPart,
  StorageService,
} from '../storage/storage.service';
import { CompleteUploadDto, InitiateUploadDto } from './dto/upload.dto';
import { Video } from './entities/video.entity';
import { createPublicId, isPublicId } from './public-id.util';
import { downloadFilename, expectedPartCount } from './upload-plan.util';
import {
  extensionForContentType,
  originalObjectKey,
  VideoStatus,
} from './video.constants';

const PG_UNIQUE_VIOLATION = '23505';

export interface VideoView {
  id: string;
  publicId: string;
  title: string;
  status: VideoStatus;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  processingError: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  channel: { id: string; nickname: string; name: string };
}

export interface InitiateUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
  title: string;
  partSize: number;
  partCount: number;
  parts: PresignedPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channels: Repository<Channel>,
    private readonly storage: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessingJob>,
    @Inject(videoConfig.KEY)
    private readonly video: ConfigType<typeof videoConfig>,
  ) {}

  async initiate(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channels.findOne({
      where: { user_id: userId },
    });
    if (!channel) throw new ChannelNotFoundException();

    const id = randomUUID();
    const key = originalObjectKey(id, dto.contentType);
    const uploadId = await this.storage.createMultipartUpload(
      key,
      dto.contentType,
    );

    try {
      const video = await this.insertDraft({
        id,
        channelId: channel.id,
        title: dto.title,
        key,
        uploadId,
        contentType: dto.contentType,
        sizeBytes: dto.sizeBytes,
      });
      const partCount = expectedPartCount(
        dto.sizeBytes,
        this.video.partSizeBytes,
      );
      const parts = await this.signParts(key, uploadId, partCount);
      return {
        id: video.id,
        publicId: video.public_id,
        status: video.status,
        title: video.title,
        partSize: this.video.partSizeBytes,
        partCount,
        parts,
      };
    } catch (error) {
      await this.storage.abortMultipartUpload(key, uploadId);
      throw error;
    }
  }

  async refreshParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<{ parts: PresignedPart[] }> {
    const video = await this.findOwnedDraft(userId, videoId);
    const partCount = this.partCountOf(video);
    for (const partNumber of partNumbers) {
      if (partNumber > partCount) throw new InvalidUploadPartsException();
    }
    if (!video.upload_id) throw new VideoUploadNotPendingException();
    const parts: PresignedPart[] = [];
    for (const partNumber of partNumbers) {
      parts.push({
        partNumber,
        url: await this.storage.presignUploadPart(
          video.original_key,
          video.upload_id,
          partNumber,
        ),
      });
    }
    return { parts };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<{ id: string; publicId: string; status: VideoStatus }> {
    const video = await this.findOwnedDraft(userId, videoId);
    this.assertPartsComplete(dto.parts, this.partCountOf(video));
    if (!video.upload_id) throw new VideoUploadNotPendingException();

    await this.storage.completeMultipartUpload(
      video.original_key,
      video.upload_id,
      dto.parts,
    );
    video.status = VideoStatus.Processing;
    video.upload_id = null;
    await this.videos.save(video);
    await this.enqueue(video.id);

    return {
      id: video.id,
      publicId: video.public_id,
      status: video.status,
    };
  }

  async abortUpload(userId: string, videoId: string): Promise<void> {
    const video = await this.findOwnedDraft(userId, videoId);
    if (video.upload_id) {
      await this.storage.abortMultipartUpload(
        video.original_key,
        video.upload_id,
      );
    }
    video.status = VideoStatus.Error;
    video.upload_id = null;
    video.processing_error = 'Upload aborted';
    await this.videos.save(video);
  }

  async getForOwner(userId: string, videoId: string): Promise<VideoView> {
    const channel = await this.channels.findOne({
      where: { user_id: userId },
    });
    if (!channel) throw new VideoNotFoundException();
    const video = await this.videos.findOne({
      where: { id: videoId, channel_id: channel.id },
      relations: { channel: true },
    });
    if (!video) throw new VideoNotFoundException();
    return this.toView(video);
  }

  async getPublic(publicId: string): Promise<VideoView> {
    const video = await this.findReadyByPublicId(publicId);
    return this.toView(video);
  }

  async playback(publicId: string): Promise<PresignedGet> {
    const video = await this.findPlayable(publicId);
    return this.storage.presignGetObject(video.original_key);
  }

  async download(
    publicId: string,
  ): Promise<PresignedGet & { filename: string }> {
    const video = await this.findPlayable(publicId);
    const filename = downloadFilename(
      video.title,
      extensionForContentType(video.content_type),
    );
    const signed = await this.storage.presignGetObject(video.original_key, {
      downloadFilename: filename,
    });
    return { ...signed, filename };
  }

  private async insertDraft(input: {
    id: string;
    channelId: string;
    title: string;
    key: string;
    uploadId: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<Video> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.videos.save(
          this.videos.create({
            id: input.id,
            public_id: createPublicId(),
            channel_id: input.channelId,
            title: input.title,
            status: VideoStatus.Draft,
            original_key: input.key,
            upload_id: input.uploadId,
            content_type: input.contentType,
            size_bytes: input.sizeBytes,
          }),
        );
      } catch (error) {
        if (!this.isPublicIdConflict(error) || attempt === 4) throw error;
      }
    }
    throw new Error('Could not allocate a public id');
  }

  private async findOwnedDraft(
    userId: string,
    videoId: string,
  ): Promise<Video> {
    const channel = await this.channels.findOne({
      where: { user_id: userId },
    });
    if (!channel) throw new VideoNotFoundException();
    const video = await this.videos.findOne({
      where: { id: videoId, channel_id: channel.id },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.Draft) {
      throw new VideoUploadNotPendingException();
    }
    return video;
  }

  private async findReadyByPublicId(publicId: string): Promise<Video> {
    if (!isPublicId(publicId)) throw new VideoNotFoundException();
    const video = await this.videos.findOne({
      where: { public_id: publicId, status: VideoStatus.Ready },
      relations: { channel: true },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private async findPlayable(publicId: string): Promise<Video> {
    if (!isPublicId(publicId)) throw new VideoNotFoundException();
    const video = await this.videos.findOne({
      where: { public_id: publicId },
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.Ready) throw new VideoNotReadyException();
    return video;
  }

  private partCountOf(video: Video): number {
    return expectedPartCount(video.size_bytes, this.video.partSizeBytes);
  }

  private assertPartsComplete(
    parts: { partNumber: number; etag: string }[],
    partCount: number,
  ): void {
    const numbers = parts.map((part) => part.partNumber);
    if (new Set(numbers).size !== numbers.length) {
      throw new InvalidUploadPartsException();
    }
    if (numbers.length !== partCount) throw new InvalidUploadPartsException();
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      if (!numbers.includes(partNumber))
        throw new InvalidUploadPartsException();
    }
  }

  private async signParts(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      parts.push({
        partNumber,
        url: await this.storage.presignUploadPart(key, uploadId, partNumber),
      });
    }
    return parts;
  }

  private async enqueue(videoId: string): Promise<void> {
    try {
      await this.queue.add(
        PROCESS_VIDEO_JOB,
        { videoId },
        {
          jobId: videoId,
          attempts: this.video.processingAttempts,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!/already exists|already waiting/i.test(message)) throw error;
    }
  }

  private async toView(video: Video): Promise<VideoView> {
    const channel = video.channel;
    let thumbnailUrl: string | null = null;
    if (video.thumbnail_key) {
      const signed = await this.storage.presignGetObject(video.thumbnail_key);
      thumbnailUrl = signed.url;
    }
    return {
      id: video.id,
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      contentType: video.content_type,
      sizeBytes: video.size_bytes,
      durationSeconds: video.duration_seconds,
      processingError: video.processing_error,
      thumbnailUrl,
      createdAt: video.created_at.toISOString(),
      channel: {
        id: channel.id,
        nickname: channel.nickname,
        name: channel.name,
      },
    };
  }

  private isPublicIdConflict(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const driverError = error as QueryFailedError & {
      code?: string;
      detail?: string;
    };
    return (
      driverError.code === PG_UNIQUE_VIOLATION &&
      typeof driverError.detail === 'string' &&
      driverError.detail.includes('public_id')
    );
  }
}
