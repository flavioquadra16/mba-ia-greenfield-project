---
kind: phase
name: phase-03-videos
test_specs_aware: false
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-19T01:07:30-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-11-19T01:08:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-19T01:08:00-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T01:06:39-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Store videos of up to 10GB in MinIO without proxying the bytes through the API, create the video as a draft when the upload starts, process it on a BullMQ worker (duration, metadata, thumbnail), and expose a unique public id plus presigned playback and download URLs that stream with HTTP Range.

---

## Step Implementations

### SI-03.1 — Dependencies, configuration, and Compose services

**Description:** Add the queue and S3 libraries, register config namespaces, install FFmpeg in the dev image, and add Redis, MinIO, bucket init, and the video worker to Compose.

**Technical actions:**

- Install, inside `nestjs-api`: `@nestjs/bullmq`, `bullmq`, `ioredis`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`
- Add `src/config/storage.config.ts`, `src/config/queue.config.ts`, and `src/config/video.config.ts` (`registerAs`)
- Extend `env.validation.ts` and `.env.example` with the keys in Technical Specifications → Configuration
- Install `ffmpeg` in `Dockerfile.dev` (provides `ffmpeg` and `ffprobe`)
- Extend `compose.yaml` with `redis`, `minio`, `minio-init` (create bucket `streamtube`, CORS exposing `ETag`), and `video-worker` (same image, command `npm run start:worker`, waits until `node_modules` is present)
- `nestjs-api` depends on `redis` healthy and `minio-init` completed
- Add `package.json` script `start:worker` running `src/worker.ts` via `ts-node`

**Dependencies:** None

**Acceptance criteria:**

- `docker compose ps` shows `redis`, `minio`, and `video-worker` running, and `minio-init` exited successfully
- The API process fails Joi validation when `S3_BUCKET` is an empty string, and starts when the documented defaults are present
- `ffmpeg -version` and `ffprobe -version` succeed inside the API image

---

### SI-03.2 — Video entity and migration

**Description:** Add the `videos` table linked to `channels`, plus the inverse relation on `Channel`. Status is the lifecycle from TD-06. `public_id` is unique.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` with the columns in Data Model
- Add `@OneToMany` `videos` on `Channel`
- Generate the migration with the TypeORM CLI (`migration:generate`) after the entity exists and previous migrations have run. Review the SQL
- Update `cleanAllTables` to `DELETE FROM "videos"` before `channels`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id`, FK to channel, nullable thumbnail and duration, default status `draft` |
| `src/videos/videos.module.spec.ts` | Unit | `VideosModule` compiles |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates `videos` with the unique `public_id` and the FK to `channels`
- Two rows with the same `public_id` fail the unique constraint
- A video row cannot reference a missing channel

---

### SI-03.3 — Object storage module

**Description:** Wrap the AWS SDK v3 client for MinIO: multipart lifecycle, presigned part URLs, presigned GET, download to disk, and thumbnail put.

**Technical actions:**

- `src/storage/storage.module.ts` and `src/storage/storage.service.ts`
- Two `S3Client`s: operations use `S3_ENDPOINT`, presign uses `S3_PUBLIC_ENDPOINT`. Both use path style and checksum mode `WHEN_REQUIRED`
- Methods: `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload`, `presignGetObject`, `downloadToFile`, `putFile`
- Presign `UploadPart` with only bucket, key, upload id, and part number

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Multipart of a small object against MinIO, complete, presigned GET, `Range` returns 206, abort of a second upload |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- A single small part uploads through a presigned URL and a subsequent GET sees the bytes
- `Range: bytes=0-15` on the presigned GET returns HTTP 206
- The test PUTs to the presigned host, not to the Nest process

---

### SI-03.4 — Upload API and draft pre-registration

**Description:** Authenticated endpoints that create a draft, sign parts, complete the multipart upload, and abort. Completing enqueues processing. No file bytes are accepted by these routes.

**Technical actions:**

- `VideosModule`, `VideosController`, `VideosService`, DTOs under `src/videos/dto/`
- `POST /videos` resolves the caller's channel, inserts `draft` with a new `public_id`, starts multipart, returns part URLs
- `POST /videos/:id/upload/parts` re-signs the requested part numbers while status is `draft`
- `POST /videos/:id/upload/complete` checks the part list matches `ceil(size / partSize)`, completes multipart, sets `processing`, enqueues the job
- `POST /videos/:id/upload/abort` aborts multipart and sets `error`
- Domain exceptions listed in the Error Catalog, thrown from the service, never caught in the controller
- Owner mismatch is `404 VIDEO_NOT_FOUND`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/public-id.util.spec.ts` | Unit | Length 11, alphabet |
| `src/videos/upload-plan.util.spec.ts` | Unit | Part count for 1 byte, 64MiB, and 10GiB |
| `src/videos/videos.service.spec.ts` | Unit | Draft is persisted before presign returns; complete enqueues once; wrong owner is not found |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real MinIO + Postgres: initiate leaves `draft`, PUT part, complete leaves `processing` and a BullMQ job whose id is the video id |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- Initiate returns 201 with `status: draft` and at least one part URL, and the row exists before any PUT
- `sizeBytes` greater than 10GiB returns 400 `VALIDATION_ERROR` and creates no row
- Complete returns 202 with `status: processing`
- Abort from `draft` returns 204 and the row is `error`
- Complete when the row is not `draft` returns 409 `VIDEO_UPLOAD_NOT_PENDING`

---

### SI-03.5 — Video worker

**Description:** A second Nest entrypoint consumes `video-processing`, probes the file, writes the thumbnail, and moves the row to `ready` or, after the last retry, to `error`.

**Technical actions:**

- `src/videos/video-processing.service.ts` downloads `original_key`, runs ffprobe and ffmpeg, uploads `videos/{id}/thumbnail.jpg`, saves duration, metadata, thumbnail key, `ready`
- `src/videos/video.processor.ts` is provided only by `src/worker.module.ts`
- `src/worker.ts` boots `createApplicationContext`
- `failed` handler calls `markFailed` when `attemptsMade >= attempts`
- Missing video or a row already `ready` or `error` is a no-op
- Temp directory removed in `finally`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/processing-attempt.util.spec.ts` | Unit | Final-attempt predicate is true only on the last attempt |
| `src/videos/video-processing.service.integration-spec.ts` | Integration | Real FFmpeg + MinIO + Postgres: a generated 1s mp4 becomes `ready` with duration at least 1 and a JPEG thumbnail object |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- After a successful job the row is `ready`, `duration_seconds` is set, `metadata` contains width and height, and `thumbnail_key` points at an object
- A non-video payload ends as `error` with `processing_error` set when attempts is 1
- `AppModule` does not register `VideoProcessor`

---

### SI-03.6 — Public id, playback, and download

**Description:** Read models for the owner (any status, by UUID) and for anonymous callers (`ready` videos, by `public_id`), plus presigned playback and download.

**Technical actions:**

- `GET /videos/:id` authenticated, owner only, any status. Includes `thumbnailUrl` when the thumbnail key exists
- `GET /videos/public/:publicId` public, only `ready`
- `GET /videos/public/:publicId/playback` public, `{ url, expiresAt }`, no attachment disposition
- `GET /videos/public/:publicId/download` public, `{ url, expiresAt, filename }` with attachment disposition
- Not ready on playback or download → `409 VIDEO_NOT_READY`. Unknown public id → `404 VIDEO_NOT_FOUND`
- OpenAPI on every handler, bearer security on the authenticated ones

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | Register, initiate, PUT to MinIO, complete, worker reaches `ready`, playback URL returns 206 on `Range`, download URL is an attachment presign, 10GiB+1 is rejected, unauthenticated initiate is 401, draft is hidden from the public route |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- Two initiates produce two different `publicId` values
- Playback URL responds 206 to `Range: bytes=0-15`
- Download URL includes an attachment content-disposition
- A draft is not returned by the public route (404)
- The owner can read `processing` and `ready` via `GET /videos/:id`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK | Assigned by the service before insert so the object key can use it |
| public_id | varchar(11) | unique, not null | TD-04 |
| channel_id | uuid | FK → channels.id, not null | Indexed |
| title | varchar(120) | not null | From the initiate body |
| status | enum `video_status_enum` | not null, default `draft` | `draft`, `processing`, `ready`, `error` |
| original_key | varchar(512) | not null | `videos/{id}/original.{ext}` |
| thumbnail_key | varchar(512) | nullable | Set by the worker |
| upload_id | varchar(255) | nullable | Multipart id while `draft`; cleared after complete or abort |
| content_type | varchar(128) | not null | Allow-list value |
| size_bytes | bigint | not null | Declared size. Transformer exposes a number |
| duration_seconds | int | nullable | Rounded seconds from ffprobe |
| metadata | jsonb | nullable | Probe document. Shape below |
| processing_error | text | nullable | Last failure message or abort reason |
| created_at | timestamp | not null | `@CreateDateColumn` |
| updated_at | timestamp | not null | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one). Channel → Video (one-to-many).

**Indexes:** unique `(public_id)`, index `(channel_id)`.

**metadata JSON:**

```json
{
  "duration": 1.0,
  "width": 160,
  "height": 120,
  "videoCodec": "h264",
  "audioCodec": null,
  "formatName": "mov,mp4,m4a,3gp,3g2,mj2"
}
```

`duration` keeps the probe's fractional seconds. `duration_seconds` is `Math.round(duration)`.

#### Configuration

| Variable | Default | Used by |
|----------|---------|---------|
| `S3_ENDPOINT` | `http://minio:9000` | API and worker operations |
| `S3_PUBLIC_ENDPOINT` | `http://minio:9000` | Presign only |
| `S3_REGION` | `us-east-1` | SDK region |
| `S3_BUCKET` | `streamtube` | TD-07 |
| `S3_ACCESS_KEY` | `streamtube` | MinIO root user |
| `S3_SECRET_KEY` | `streamtube-secret` | MinIO root password |
| `REDIS_HOST` | `redis` | BullMQ |
| `REDIS_PORT` | `6379` | BullMQ |
| `VIDEO_PART_SIZE_BYTES` | `67108864` | 64MiB. Joi minimum `5242880` |
| `VIDEO_MAX_BYTES` | `10737418240` | 10GiB |
| `VIDEO_UPLOAD_URL_EXPIRES_SECONDS` | `3600` | Part URLs |
| `VIDEO_PLAYBACK_URL_EXPIRES_SECONDS` | `900` | Playback and download |
| `VIDEO_PROCESSING_ATTEMPTS` | `3` | BullMQ `attempts` |

Empty string is invalid for `S3_BUCKET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`.

Allowed `contentType`: `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`. Extensions: `mp4`, `webm`, `mov`, `mkv`.

### API Contracts

Authenticated routes require `Authorization: Bearer <access_token>`. Public routes use `@Public()`.

#### POST /videos (SI-03.4)

**Request body:**

- `title`: string, required, 1–120
- `filename`: string, required, 1–255 (not used in the object key)
- `contentType`: string, required, one of the allow-list
- `sizeBytes`: integer, required, 1–10737418240

**Response 201:**

- `id`: uuid
- `publicId`: string (11)
- `status`: `draft`
- `title`: string
- `partSize`: number
- `partCount`: number
- `parts`: `{ partNumber: number, url: string }[]` for every part from 1 to `partCount`

**Errors:** 400 `VALIDATION_ERROR`; 401 missing or invalid token; 404 `CHANNEL_NOT_FOUND` if the user has no channel.

#### POST /videos/:id/upload/parts (SI-03.4)

**Request body:** `partNumbers`: int[], 1–50 items, each between 1 and `partCount`.

**Response 200:** `{ parts: { partNumber, url }[] }`.

**Errors:** 400 `VALIDATION_ERROR` or `INVALID_UPLOAD_PARTS`; 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_UPLOAD_NOT_PENDING` when status is not `draft`.

#### POST /videos/:id/upload/complete (SI-03.4)

**Request body:** `parts`: `{ partNumber: number, etag: string }[]`. The set of part numbers must be exactly `1..partCount`.

**Response 202:** `{ id, publicId, status: "processing" }`.

**Errors:** 400 `INVALID_UPLOAD_PARTS`; 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_UPLOAD_NOT_PENDING`.

#### POST /videos/:id/upload/abort (SI-03.4)

**Response 204.** Row becomes `error`, `processing_error = "Upload aborted"`.

**Errors:** 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_UPLOAD_NOT_PENDING`.

#### GET /videos/:id (SI-03.6)

Owner only. `:id` is a UUID.

**Response 200:** `id`, `publicId`, `title`, `status`, `contentType`, `sizeBytes`, `durationSeconds`, `processingError`, `thumbnailUrl` (presigned, or null), `createdAt`, `channel: { id, nickname, name }`.

**Errors:** 404 `VIDEO_NOT_FOUND` for an unknown id or another user's video; 401.

#### GET /videos/public/:publicId (SI-03.6)

**Response 200:** same shape as the owner read, only when `status = ready`.

**Errors:** 404 `VIDEO_NOT_FOUND` when the id is unknown or the video is not `ready`.

#### GET /videos/public/:publicId/playback (SI-03.6)

**Response 200:** `{ url: string, expiresAt: string }` ISO-8601. The URL is a presigned GET without attachment disposition. The client sends `Range` to object storage.

**Errors:** 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_NOT_READY`.

#### GET /videos/public/:publicId/download (SI-03.6)

**Response 200:** `{ url, expiresAt, filename }`. The URL signs `ResponseContentDisposition: attachment; filename="<sanitized>.<ext>"`.

**Errors:** 404 `VIDEO_NOT_FOUND`; 409 `VIDEO_NOT_READY`.

### Authorization Matrix

| Endpoint | Public | Authenticated owner | Notes |
|----------|--------|---------------------|-------|
| POST /videos | | ✓ | Channel of the JWT `sub` |
| POST /videos/:id/upload/parts | | ✓ | 404 if the video is not on the caller's channel |
| POST /videos/:id/upload/complete | | ✓ | |
| POST /videos/:id/upload/abort | | ✓ | |
| GET /videos/:id | | ✓ | Any status |
| GET /videos/public/:publicId | ✓ | | `ready` only, otherwise 404 |
| GET /videos/public/:publicId/playback | ✓ | | `ready`, otherwise 409 if the row exists |
| GET /videos/public/:publicId/download | ✓ | | `ready`, otherwise 409 if the row exists |

### Error Catalog

Envelope remains `{ statusCode, error, message }`. Validation errors use `error: "VALIDATION_ERROR"` and `message` as an array, unchanged from Fase 02.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for the authenticated user | Initiate when the JWT user has no channel |
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown id, unknown public id, or video owned by someone else |
| VIDEO_UPLOAD_NOT_PENDING | 409 | Upload is not awaiting completion | Parts, complete, or abort when status is not `draft` |
| INVALID_UPLOAD_PARTS | 400 | Upload parts do not match the declared file size | Part numbers missing, duplicated, or out of range |
| VIDEO_NOT_READY | 409 | Video is not ready for playback | Playback or download while status is not `ready` |

Oversize `sizeBytes` is rejected by the DTO (`@Max`) as `VALIDATION_ERROR`, before a row is inserted. There is no separate `VIDEO_TOO_LARGE` code.

### Events / Messages

Queue name: `video-processing`. Redis on `REDIS_HOST`.

| Name | Producer | Consumer | Payload | Options |
|------|----------|----------|---------|---------|
| `process-video` | `VideosService.completeUpload` | `VideoProcessor` in `video-worker` only | `{ videoId: string }` | `jobId = videoId`, `attempts = VIDEO_PROCESSING_ATTEMPTS` (3), `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: 100`, `removeOnFail: 500` |

The producer does not run FFmpeg. The consumer does not expose HTTP.

Failure event: `@OnWorkerEvent('failed')`. When `job.attemptsMade >= job.opts.attempts`, set `status = error` and `processing_error` to the error message truncated to 2000 characters. Earlier failures leave the row in `processing`.

Idempotency: a second complete is rejected by the status check before `queue.add`. A duplicate `jobId` while that job already exists is treated as the row already being in `processing`.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
│   └── SI-03.4
│       ├── SI-03.5
│       │   └── SI-03.6
│       └── SI-03.6
└── SI-03.3
    ├── SI-03.4
    └── SI-03.5
```

SI-03.6 waits on both the upload API and the worker.

---

## Deliverables

- `docs/decisions/technical-decisions-phase-03-videos.md`
- `docs/phases/phase-03-videos/` with context, validation (`clean`), library-refs, this plan, and progress
- `videos` module, storage module, worker entry, and the `videos` migration
- Compose services `minio`, `minio-init`, `redis`, `video-worker`
- Upload up to 10GB by presigned multipart, draft row at initiate, automatic processing, unique `public_id`, Range streaming via presigned GET, download via presigned attachment URL
- `CLAUDE.md` and `nestjs-project/CLAUDE.md` describe the module, endpoints, queue, and storage as implemented
- Cursor equivalent of the AI foundation: root `AGENTS.md` and `.cursor/mcp.json`, because this phase was executed in Cursor rather than Claude Code
