import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { VideoProcessingJob } from '../queue/video-processing.constants';
import {
  ChannelNotFoundException,
  VideoNotFoundException,
  VideoUploadNotPendingException,
} from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video.constants';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  const videoConfig = {
    partSizeBytes: 64 * 1024 * 1024,
    maxBytes: 10 * 1024 * 1024 * 1024,
    uploadUrlExpiresSeconds: 3600,
    playbackUrlExpiresSeconds: 900,
    processingAttempts: 3,
  };

  let videos: {
    save: jest.Mock;
    create: jest.Mock;
    findOne: jest.Mock;
  };
  let channels: { findOne: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    abortMultipartUpload: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };
  let queue: { add: jest.Mock };
  let service: VideosService;

  const channel = {
    id: 'channel-1',
    user_id: 'user-1',
    nickname: 'ada',
    name: 'Ada',
  } as Channel;

  beforeEach(() => {
    videos = {
      create: jest.fn((value) => value as Video),
      save: jest.fn((value) => Promise.resolve(value as Video)),
      findOne: jest.fn(),
    };
    channels = { findOne: jest.fn() };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest.fn().mockResolvedValue('http://minio/part'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new VideosService(
      videos as unknown as Repository<Video>,
      channels as unknown as Repository<Channel>,
      storage as unknown as StorageService,
      queue as unknown as Queue<VideoProcessingJob>,
      videoConfig,
    );
  });

  it('persists a draft before returning part URLs', async () => {
    channels.findOne.mockResolvedValue(channel);

    const result = await service.initiate('user-1', {
      title: 'Demo',
      filename: 'demo.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });

    expect(storage.createMultipartUpload).toHaveBeenCalled();
    expect(videos.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: VideoStatus.Draft, title: 'Demo' }),
    );
    const savedAt = videos.save.mock.invocationCallOrder[0];
    const signedAt = storage.presignUploadPart.mock.invocationCallOrder[0];
    expect(savedAt).toBeLessThan(signedAt);
    expect(result.status).toBe(VideoStatus.Draft);
    expect(result.partCount).toBe(1);
    expect(result.publicId).toHaveLength(11);
  });

  it('throws when the user has no channel and does not open an upload', async () => {
    channels.findOne.mockResolvedValue(null);

    await expect(
      service.initiate('user-1', {
        title: 'Demo',
        filename: 'demo.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(ChannelNotFoundException);
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('enqueues processing once when the upload completes', async () => {
    channels.findOne.mockResolvedValue(channel);
    const draft = {
      id: 'video-1',
      public_id: 'abc123def45',
      channel_id: channel.id,
      status: VideoStatus.Draft,
      original_key: 'videos/video-1/original.mp4',
      upload_id: 'upload-1',
      size_bytes: 1024,
    } as Video;
    videos.findOne.mockResolvedValue(draft);

    const result = await service.completeUpload('user-1', 'video-1', {
      parts: [{ partNumber: 1, etag: '"etag"' }],
    });

    expect(storage.completeMultipartUpload).toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      'process-video',
      { videoId: 'video-1' },
      expect.objectContaining({ jobId: 'video-1', attempts: 3 }),
    );
    expect(result.status).toBe(VideoStatus.Processing);
  });

  it('rejects complete when the video is not a draft', async () => {
    channels.findOne.mockResolvedValue(channel);
    videos.findOne.mockResolvedValue({
      id: 'video-1',
      channel_id: channel.id,
      status: VideoStatus.Ready,
      size_bytes: 1024,
    } as Video);

    await expect(
      service.completeUpload('user-1', 'video-1', {
        parts: [{ partNumber: 1, etag: '"etag"' }],
      }),
    ).rejects.toBeInstanceOf(VideoUploadNotPendingException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('hides a video that belongs to another channel', async () => {
    channels.findOne.mockResolvedValue(channel);
    videos.findOne.mockResolvedValue(null);

    await expect(
      service.getForOwner('user-1', 'video-2'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });
});
