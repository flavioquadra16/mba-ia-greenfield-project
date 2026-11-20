---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-19
scope_description: "Backend video upload and processing: object storage usage, queue, direct-to-storage upload of up to 10GB, worker with FFmpeg, unique public URL, streaming, download, and status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — API, migration, object storage client, BullMQ producer, and the video worker process. New Compose services: MinIO, Redis, and `video-worker`.
- `next-frontend/` — no open decision. Playback and upload UI belong to later phases (Fase 04/05). The API contract below is what that UI will call. The C4 diagram already shows the frontend streaming from object storage, not through the API.

Sources checked before choosing: NestJS Queues guide (`@nestjs/bullmq`, Bull vs BullMQ), BullMQ NestJS guide, AWS SDK for JavaScript v3 (`CreateMultipartUpload`, `UploadPart` presign, `GetObject` presign, `forcePathStyle`). Installed backend stack at research time: NestJS 11, TypeORM 0.3, PostgreSQL 17, no queue and no S3 client yet. Object storage product is not open: the architecture already fixes S3-compatible storage, run locally as MinIO.

---

## TD-01: Background queue technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram labels the message queue as TBD. After upload, duration/metadata extraction and thumbnail generation must run off the request path. The worker and the API are separate containers and need a shared broker. Phase 01–02 did not add Redis or a queue library.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- NestJS's maintained queue integration. API enqueues a job; a separate Nest application context runs a `@Processor` that extends `WorkerHost`. Redis is the broker. Retries, backoff, and job id idempotency are built in.
- **Pros:** Official NestJS 11 path (`Bull` is maintenance-only; docs point new work at BullMQ). Processor is a normal injectable provider, so it can use the same TypeORM and storage services as the API. Docker is one small Redis service. Job id can be the video id, so a duplicate complete does not enqueue a second job.
- **Cons:** New infrastructure (Redis) besides PostgreSQL. Two processes must share the queue name and the Redis host.

### Option B: pg-boss (PostgreSQL as the queue)
- Jobs live in the existing `streamtube` database. No new broker container. A worker polls `SKIP LOCKED` rows.
- **Pros:** One less service. Transactional enqueue in the same database as the video row is natural.
- **Cons:** No first-class NestJS module. Polling and locking are our code. Heavier DB load sits on the same Postgres that serves auth. The architecture diagram draws the queue as its own container, separate from the database.

### Option C: RabbitMQ (`amqplib` or `@golevelup/nestjs-rabbitmq`)
- A dedicated broker with exchanges and acks. The worker consumes deliveries and acks after FFmpeg finishes.
- **Pros:** Strong delivery semantics and a clear broker boundary. Familiar ops model for larger systems.
- **Cons:** Heavier than this workload needs (one job type, one consumer). NestJS has no official Rabbit module; the community package is another dependency to pin. Retries and delayed backoff are more manual than BullMQ.

**Recommendation:** **Option A (BullMQ + Redis)** — the workload is one job type with retries, the NestJS 11 docs treat BullMQ as the current queue integration, and a Redis container matches the diagram's separate queue container without taking a second opinionated broker.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`

---

## TD-02: Upload of files up to 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB body proxied by the API would hold a Node request, memory or disk on the API container, and a reverse proxy timeout. The project note also requires resume after a dropped connection. Amazon S3 (and MinIO) reject a single PUT above 5GB, so a 10GB object must be a multipart upload. The API already has a global JWT guard and a domain error filter; the upload protocol has to fit that contract without streaming bytes through the controller.

**Options:**

### Option A: S3 multipart upload with presigned part URLs
- `POST /videos` creates the video row as `draft` and calls `CreateMultipartUpload`. The response includes `uploadId`, part size, and presigned `UploadPart` URLs. The client PUTs each part straight to MinIO. `POST /videos/:id/upload/complete` sends the part ETags; the API calls `CompleteMultipartUpload` and only then enqueues processing. Expired URLs are re-signed per part number without sending bytes. Server-side S3 calls use `S3_ENDPOINT` (Compose DNS, `http://minio:9000`). Presigned URLs are signed with `S3_PUBLIC_ENDPOINT` so the Host header matches the caller (default `http://minio:9000` for in-network tests; `http://localhost:9000` when the caller is on the host). `forcePathStyle: true` is required for MinIO. SDK checksums are `WHEN_REQUIRED` so presigned PUTs are not tied to a checksum header the client will not send.
- **Pros:** The API never holds the file. Parts at or above 5MB (last part may be smaller) satisfy S3 rules, so 10GB is legal. A failed part is retried by asking for a new URL. MinIO speaks the same API we would point at S3 in production.
- **Cons:** The client must store ETags and call complete. Presigned host and path-style must be configured or MinIO returns `SignatureDoesNotMatch`. Two endpoints (internal vs public) are part of the contract.

### Option B: tus (resumable protocol) in front of the API or MinIO
- The client speaks tus (PATCH chunks, `Upload-Offset`). A tus server or MinIO extension stores the object.
- **Pros:** Resume is a protocol feature, including offset queries. Good for unstable clients.
- **Cons:** Adds a protocol and a server the stack does not have. NestJS would still need a tus endpoint or an extra container, and the bytes (or a proxy of them) sit closer to the API than a presigned PUT. S3 multipart already covers resume for this phase.

### Option C: Single presigned PUT
- One `PutObject` URL. The client uploads the whole file in one request, then notifies the API.
- **Pros:** Smallest API. Fine for short clips.
- **Cons:** S3 and MinIO cap a single PUT at 5GB, so 10GB is impossible. A dropped connection restarts the entire object. This fails the phase limit.

**Recommendation:** **Option A** — it is the only option here that both stays off the API process and can store 10GB. Part size default is 64MiB (must stay between 5MiB and 5GiB), which is 160 parts for 10GiB, under the 10,000-part cap.

**Decision:** A (S3 multipart upload with presigned part URLs)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

---

## TD-03: Worker process and media tooling

**Scope:** Backend

**Capability:** Transversal — covers: Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** FFmpeg work is CPU and disk heavy and must not run inside the HTTP process. The diagram shows a Video Worker container that reads the object, writes the thumbnail, and updates PostgreSQL. The dev image today is `node:25.6.0-slim` plus `procps` and `curl`, with no FFmpeg, and Compose only runs the API, Postgres, and Mailpit.

**Options:**

### Option A: Second Compose service, same image, FFmpeg/ffprobe CLI
- `video-worker` uses the API image with `ffmpeg` installed and runs `src/worker.ts` (`NestFactory.createApplicationContext`). Only that process registers the BullMQ processor. The API process only enqueues. The processor downloads the original to a temp file, runs `ffprobe -print_format json` for duration and streams, runs `ffmpeg` (`thumbnail` filter, scaled to 640px) for one JPEG frame, uploads the JPEG, and sets the row to `ready`.
- **Pros:** One codebase and one image. The HTTP server never links FFmpeg. CLI flags are stable and avoid an unmaintained Node wrapper. The worker container is visible in `docker compose ps`, which is what this phase requires.
- **Cons:** The image grows by the Debian `ffmpeg` package. The worker command must wait until `node_modules` exists because the dev Compose file bind-mounts the project.

### Option B: `fluent-ffmpeg` inside the API process
- A library wraps the FFmpeg CLI and the API starts the work in-process after complete, or on a Bull consumer hosted by the API.
- **Pros:** Nicer Node API for arguments. No second entrypoint.
- **Cons:** The wrapper lags the FFmpeg CLI and adds a dependency for something `execFile` already does. Running the consumer in the API container couples a long FFmpeg job to the HTTP process lifecycle. A crash or deploy would take uploads and transcoding down together.

### Option C: External transcoding service (managed or a third container with its own queue API)
- **Pros:** Scales independently later.
- **Cons:** Out of proportion for one thumbnail and a duration probe. The phase asks for a worker we run, not a new vendor.

**Recommendation:** **Option A** — it matches the diagram (queue delivers to a worker; worker talks to storage and the database) and keeps FFmpeg out of the request process. Retries stay in BullMQ (TD-06), not in a custom loop around `fluent-ffmpeg`.

**Decision:** A (separate `video-worker` service, FFmpeg and ffprobe CLI)

**Libraries:** Debian package `ffmpeg` in `Dockerfile.dev` (provides `ffmpeg` and `ffprobe`). No Node media library.

---

## TD-04: Unique video URL

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, stable identifier that never collides and that later phases can put in a public path. The internal primary key is already a UUID. Titles change in Fase 04, so a title slug would move or collide. The identifier is assigned when the draft row is created, before the file exists.

**Options:**

### Option A: 11-character `public_id` (base62), unique column
- Generated with `crypto.randomBytes` and a `[0-9A-Za-z]` alphabet (rejection sampling to avoid modulo bias). Column `videos.public_id` is `varchar(11)` unique. On the rare unique violation, generate another id and retry. Public routes use this id (`/videos/public/:publicId`). The UUID stays the owner-facing key for upload completion.
- **Pros:** Short, URL-safe, not enumerable in practice (62^11). Independent of the title. Unique constraint is the real guarantee; generation retries are only the happy path. No new package (`nanoid` v5 is ESM-only and this package is CommonJS).
- **Cons:** Not memorable. A second id exists beside the UUID, which callers must not mix up.

### Option B: UUID in the public path
- Reuse `videos.id` as the URL.
- **Pros:** No extra column. Zero collision logic.
- **Cons:** Long, and the project note asks for a short unique URL. The same value would authorize owner actions and public playback, which makes logs and future unlisted links coarser than they need to be.

### Option C: Slug derived from the title
- `my-video` plus a numeric suffix on conflict.
- **Pros:** Readable links.
- **Cons:** Titles are edited in Fase 04, so the URL would change or we would freeze a slug the user did not choose yet. Empty and duplicate titles need the same suffix dance as nicknames, for little gain at upload time.

**Recommendation:** **Option A** — the phase asks for a short unique URL at upload time, before a title is stable, and the unique index is the conflict rule. Owner commands keep using the UUID so a public id cannot be used to complete someone else's upload.

**Decision:** A (11-character `public_id`, unique)

---

## TD-05: Streaming and download

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The C4 diagram draws streaming as Frontend → Object Storage, not Frontend → API → Storage. Proxying a 10GB object through Nest would pin an API socket for the whole watch session and contradict that diagram. MinIO/S3 already honor the `Range` header with `206 Partial Content` on a GET of the object. Fase 05 adds the player and anonymous watch page; this phase has to make the bytes reachable without a full download. Fase 04 adds public vs unlisted visibility; until then a video that finished processing is watchable.

**Options:**

### Option A: Presigned GET for playback and a second presigned GET for download
- `GET /videos/public/:publicId/playback` (public, video must be `ready`) returns `{ url, expiresAt }`. The URL is a presigned `GetObject`. The client (or a test) sends `Range` to MinIO and receives 206. `GET /videos/public/:publicId/download` returns a presigned GET with `ResponseContentDisposition=attachment` and a sanitized filename. Non-ready videos return `409 VIDEO_NOT_READY`. Missing ids return `404 VIDEO_NOT_FOUND`. Expiry default is 15 minutes.
- **Pros:** Matches the diagram. The API does not copy bytes. Range/206 is MinIO's behavior, asserted by a test that requests the first bytes of the presigned URL. Download and playback stay different URLs so a player is not forced to save a file.
- **Cons:** URLs expire and the client must ask again. The presign host must be reachable by the caller (TD-02). Anyone who knows a `ready` video's `public_id` can watch until Fase 04 adds visibility.

### Option B: API proxies the object and implements Range itself
- `GET /videos/public/:publicId/stream` reads `Range`, calls `GetObject` with that range, and writes `206` to the client.
- **Pros:** One host, no presign expiry, easier cookies later.
- **Cons:** The API holds the stream for the whole playback, which is the failure mode this phase is not allowed to ship. It also disagrees with the container diagram.

### Option C: Public bucket, stable unsigned URL
- **Pros:** Simplest player URL.
- **Cons:** Every object key becomes world-readable, including drafts if a key leaks. No expiry. Wrong default for a private bucket.

**Recommendation:** **Option A** — streaming is a Range request to storage, and the API only mints the URL after the row is `ready`. Download is the same object with an attachment disposition. Anonymous read of `ready` videos is intentional in this phase; visibility rules are Fase 04.

**Decision:** A (presigned GET playback + presigned attachment download)

---

## TD-06: Video status lifecycle and processing failure

**Scope:** Backend

**Capability:** Transversal — covers: Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The phase requires a draft row as soon as the upload starts, then automatic processing, and a visible outcome when processing fails. Callers (and later the channel panel) need a single column for that, not an implied state from null keys.

**Options:**

### Option A: `draft` → `processing` → `ready` | `error`
- `POST /videos` inserts `draft` before any byte is stored (the multipart upload id is saved on that row). `complete` moves the row to `processing` and enqueues `process-video` with `jobId = video.id`. The worker writes duration, a metadata JSON document, and the thumbnail key, then sets `ready`. BullMQ retries 3 times with exponential backoff. The processor's `failed` handler sets `error` and `processing_error` only when `attemptsMade` has reached the configured attempts. `abort` is allowed only from `draft` and sets `error` with a fixed message. A second `complete` on a non-draft row returns `409 VIDEO_UPLOAD_NOT_PENDING`.
- **Pros:** Matches the required cycle (rascunho → processando → pronto/erro). The draft exists even if the client never uploads a part. Retries do not flip the row to `error` on the first FFmpeg failure. Job id prevents two workers from being queued for one video.
- **Cons:** There is no separate `uploading` value; a draft might have zero parts uploaded. That is acceptable: the draft means "upload started", which is what the capability asks for. `ready` means "processed", not "published" — publication is Fase 04.

### Option B: `uploading` and `processing` as two extra states, plus `published`
- **Pros:** Distinguishes "no parts yet" from "parts in flight", and would preview Fase 04.
- **Cons:** Publication and visibility are a later phase. An extra uploading state is not required to meet the cycle the phase describes and would force the client to send another transition the capabilities do not name.

### Option C: No error status; leave the row in `processing` and rely on the queue UI
- **Pros:** Less write logic.
- **Cons:** The product cannot tell a stuck video from one that is still running. The phase explicitly includes an error outcome.

**Recommendation:** **Option A** — four values, transition only in the service (not by the client PATCHing status), retries inside `processing`, and `error` only after the last attempt or an explicit abort.

**Decision:** A (`draft` → `processing` → `ready` | `error`)

---

## TD-07: Bucket and object key layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** MinIO is the local S3. The API, the worker, Compose, and env vars all have to agree on the bucket name and the keys. A video and its thumbnail must be findable from the row alone after a restart.

**Options:**

### Option A: One private bucket, keys under `videos/{id}/`
- Bucket name from `S3_BUCKET` (default `streamtube`), created by a `minio-init` one-shot (`mc mb`, CORS exposing `ETag` so a browser can complete multipart later). Original key `videos/{uuid}/original.{ext}` where `ext` comes from an allow-list of content types (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`), never from the raw filename. Thumbnail key `videos/{uuid}/thumbnail.jpg`. The row stores both keys.
- **Pros:** One bucket to create and to point at S3 later. Keys do not depend on channel nickname renames. Extension is server-chosen. CORS is ready for the future client without making the bucket public.
- **Cons:** A single bucket mixes originals and thumbnails (prefixes separate them). Channel-scoped prefixes would group billing later, but channel id is already on the row.

### Option B: Two buckets (`videos` and `thumbnails`)
- **Pros:** Different lifecycle rules later.
- **Cons:** Two buckets and two env vars for no requirement in this phase. Thumbnails are small JPEGs beside the original.

### Option C: Key built from the client filename
- **Pros:** Object lists look familiar.
- **Cons:** Path traversal and collisions. Filenames are not unique.

**Recommendation:** **Option A** — one private bucket, server-chosen keys, filename ignored except as a label the client sent. CORS is configured so `ETag` is visible, which multipart completion needs once a browser exists.

**Decision:** A (single bucket, `videos/{id}/original.{ext}` and `videos/{id}/thumbnail.jpg`)

**Revisions:**
- 2026-11-19 — Local image is `pgsty/silo:RELEASE.2026-10-26T00-00-00Z` (MinIO-compatible fork) for both the server and `mc`. Rationale: `minio/minio` and `quay.io/minio/minio` no longer pull anonymously. The S3 API, path-style presigns, and bucket layout are unchanged.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Background queue technology | BullMQ + Redis | A |
| TD-02 | Backend | Upload of files up to 10GB | S3 multipart presigned part URLs | A |
| TD-03 | Backend | Worker process and media tooling | Separate worker, FFmpeg/ffprobe CLI | A |
| TD-04 | Backend | Unique video URL | 11-character `public_id` | A |
| TD-05 | Backend | Streaming and download | Presigned GET + attachment GET | A |
| TD-06 | Backend | Status lifecycle and failure | `draft` → `processing` → `ready` \| `error` | A |
| TD-07 | Backend | Bucket and object key layout | One bucket, keys under `videos/{id}/` | A |
