import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  VideoProcessingJob,
} from '../queue/video-processing.constants';
import { isFinalAttempt } from './processing-attempt.util';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  constructor(private readonly processing: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJob>): Promise<void> {
    if (job.name !== PROCESS_VIDEO_JOB) return;
    await this.processing.process(job.data.videoId);
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJob> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (!isFinalAttempt(job.attemptsMade, maxAttempts)) return;
    await this.processing.markFailed(job.data.videoId, error.message);
  }
}
