---
libs:
  "@nestjs/bullmq":
    version: "11.0.5"
    source: "https://docs.nestjs.com/application/queues"
    fetched_at: "2026-11-19T01:07:00-03:00"
  bullmq:
    version: "5.81.5"
    source: "https://docs.bullmq.io/guide/nestjs"
    fetched_at: "2026-11-19T01:07:00-03:00"
  ioredis:
    version: "5.11.1"
    source: "https://docs.nestjs.com/application/queues"
    fetched_at: "2026-11-19T01:07:00-03:00"
  "@aws-sdk/client-s3":
    version: "3.1172.0"
    source: "https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/"
    fetched_at: "2026-11-19T01:07:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1172.0"
    source: "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-example-creating-presigned-urls.html"
    fetched_at: "2026-11-19T01:07:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T01:06:39-03:00"
---

# phase-03-videos — Library References

Distilled from the official NestJS Queues page, the BullMQ NestJS guide, and the AWS SDK for JavaScript v3 S3 client and presigner docs. Context7 MCP is not connected in this Cursor session; the same pages were read directly. Versions below are the ones installed in `nestjs-project/package-lock.json`.

## @nestjs/bullmq and bullmq

**Maps to:** `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-06`.

NestJS 11 installs `@nestjs/bullmq` (not `@nestjs/bull`). Bull is documented as maintenance-only. Peer range of `@nestjs/bullmq` 11 accepts `bullmq` 5. `ioredis` is the Redis client BullMQ opens when `connection` is a host/port object; BullMQ itself sets `maxRetriesPerRequest: null`, which its workers require.

Root registration:

```typescript
BullModule.forRoot({
  connection: { host: 'redis', port: 6379 },
});
```

Queue registration and injection:

```typescript
BullModule.registerQueue({ name: 'video-processing' });

constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

await this.queue.add(
  'process-video',
  { videoId },
  {
    jobId: videoId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  },
);
```

The consumer is a provider, and only the worker process should provide it. BullMQ does not use `@Process(name)`; branch on `job.name` inside `process` if more names appear later. This phase has one name.

```typescript
@Processor('video-processing')
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> {
    // job.name === 'process-video'
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    // job.attemptsMade counts failures so far, including this one
  }
}
```

`jobId` equal to the video UUID makes a second `add` for the same video a duplicate instead of a second transcode. `attempts` plus exponential `backoff` cover TD-06. The `failed` handler writes `status = error` only when `attemptsMade >= attempts`.

## @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner

**Maps to:** `phase-03-videos/TD-02`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`.

Multipart (server-side, internal endpoint):

- `CreateMultipartUploadCommand` → `UploadId`
- `UploadPartCommand` is what gets presigned, not `PutObjectCommand`
- `CompleteMultipartUploadCommand` with `MultipartUpload.Parts = [{ PartNumber, ETag }]` sorted by part number
- `AbortMultipartUploadCommand` on abort
- `GetObjectCommand` for the worker download and for presigned playback
- `PutObjectCommand` for the thumbnail JPEG

Presign:

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(
  signerClient,
  new UploadPartCommand({
    Bucket,
    Key,
    UploadId,
    PartNumber,
  }),
  { expiresIn: 3600 },
);
```

Do not set `ContentType`, `ContentLength`, or a checksum on the presigned `UploadPart` command. The client must send the same headers that were signed; a bare PUT body is the contract.

MinIO:

- `endpoint` points at MinIO, `region: 'us-east-1'`, `forcePathStyle: true`.
- `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`. Newer AWS SDK v3 defaults add flexible checksums that MinIO presigns do not echo, which surfaces as `SignatureDoesNotMatch`.
- Sign with the endpoint the caller will actually use (`S3_PUBLIC_ENDPOINT`). Complete/abort/download-to-disk use `S3_ENDPOINT`.

S3 limits used by the plan: single PUT max 5GB (so multipart is mandatory for 10GB); part size minimum 5MB except the last part; maximum 10,000 parts. Default part size 64MiB keeps a 10GiB object at 160 parts.

`GetObject` `Body` in v3 is a stream. The worker must consume it (`pipeline` to a file) or the socket stays checked out. Playback does not stream through Node: the presigned URL is returned and the caller sends `Range`. MinIO answers `206` with `Content-Range` and `Accept-Ranges: bytes`.

Download disposition is a signed response override:

```typescript
new GetObjectCommand({
  Bucket,
  Key,
  ResponseContentDisposition: 'attachment; filename="video.mp4"',
});
```

## ffmpeg / ffprobe

**Maps to:** `phase-03-videos/TD-03`.

Not an npm package. `Dockerfile.dev` installs Debian `ffmpeg`, which provides both binaries. Invoked with `child_process.execFile` (no shell).

```text
ffprobe -v error -print_format json -show_format -show_streams <file>
ffmpeg -y -i <file> -vf thumbnail,scale=640:-2 -frames:v 1 <thumb.jpg>
```

`format.duration` is seconds as a string. `thumbnail` picks one representative frame so a sub-second fixture still yields a JPEG. Scale height `-2` keeps an even dimension.
