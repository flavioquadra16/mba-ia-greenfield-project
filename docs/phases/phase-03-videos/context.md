---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-19T00:55:06-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T01:06:39-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-19T00:55:06-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-11-19T00:55:06-03:00"
  docs/diagrams/software-arch.mermaid: "2026-11-19T00:55:06-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Video editing, categories, public/unlisted visibility, publish flow, channel admin panel, view page player, view counts, comments, likes, search. Those are Fases 04–07. `next-frontend/` is not modified.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — no video UI in this phase. The API returns presigned URLs the later player will open against object storage, matching the C4 edge Frontend → Object Storage.

**Sequencing notes:** Depends on Fase 01 (Compose, TypeORM, migrations, config namespaces) and Fase 02 (JWT guard global, domain exception filter, user + channel 1:1). Every video belongs to the authenticated user's channel.

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next; will add title/description edits, custom thumbnail, visibility, and publish on top of the `ready` state).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background queue technology | decided | A (BullMQ + Redis) | @nestjs/bullmq, bullmq, ioredis |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload of files up to 10GB | decided | A (S3 multipart presigned part URLs) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Worker process and media tooling | decided | A (separate video-worker, FFmpeg/ffprobe CLI) | Debian ffmpeg |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Unique video URL | decided | A (11-character public_id) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Streaming and download | decided | A (presigned GET + attachment GET) | @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Status lifecycle and failure | decided | A (draft → processing → ready \| error) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Bucket and object key layout | decided | A (single bucket, videos/{id}/ keys) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-07, phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-07 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-04 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis via `@nestjs/bullmq`. NestJS 11 documents BullMQ as the current queue integration (Bull is maintenance-only). The API enqueues; only `video-worker` registers the processor. Redis is the diagram's separate queue container.

**Libraries:** `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`

### phase-03-videos/TD-02

**Recommendation:** Multipart upload with presigned `UploadPart` URLs. The API never receives the file. A single PUT cannot hold 10GB (S3 limit 5GB). Part size defaults to 64MiB. Internal calls use `S3_ENDPOINT`; presigned URLs are signed with `S3_PUBLIC_ENDPOINT`. `forcePathStyle: true`. Checksums `WHEN_REQUIRED` so MinIO presigns are not bound to a checksum header.

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

### phase-03-videos/TD-03

**Recommendation:** `video-worker` Compose service, same image with Debian `ffmpeg`, entry `src/worker.ts` as an application context. `ffprobe` writes duration and stream metadata; `ffmpeg` writes one JPEG thumbnail. The API process does not run FFmpeg.

**Libraries:** Debian package `ffmpeg` (binaries `ffmpeg` and `ffprobe`).

### phase-03-videos/TD-04

**Recommendation:** `public_id` varchar(11), alphabet `[0-9A-Za-z]`, unique index, retry on unique violation. Generated in Node `crypto` (nanoid v5 is ESM-only). Owner upload commands use the UUID.

### phase-03-videos/TD-05

**Recommendation:** Playback and download are presigned `GetObject` URLs returned as JSON. Playback has no content disposition so the client can send `Range` and receive `206` from storage. Download sets `ResponseContentDisposition` to attachment. Only `ready` videos. Anonymous access to `ready` videos is in scope; public/unlisted is Fase 04.

**Libraries:** `@aws-sdk/s3-request-presigner@^3`

### phase-03-videos/TD-06

**Recommendation:** Status values `draft`, `processing`, `ready`, `error`. Draft is inserted on initiate, before any part is uploaded. Complete moves to `processing` and enqueues `process-video` with `jobId = video.id`. Three attempts, exponential backoff. `error` is written on abort, or on the last failed attempt. Clients do not PATCH status.

### phase-03-videos/TD-07

**Recommendation:** One private bucket (`S3_BUCKET`, default `streamtube`). Keys `videos/{uuid}/original.{ext}` and `videos/{uuid}/thumbnail.jpg`. Extension comes from an allow-list of content types, not from the filename. `minio-init` creates the bucket and sets CORS that exposes `ETag`.

## Inherited Conventions

- NestJS module per feature; controllers HTTP-only; services own rules; repositories via TypeORM. Reference shape: `src/auth/`.
- Global JWT guard. Public routes opt out with `@Public()`.
- Domain errors extend `DomainException` and the existing filter returns `{ statusCode, error, message }`.
- ValidationPipe global: whitelist, forbidNonWhitelisted, transform.
- Config via `registerAs` + Joi in `env.validation.ts`. Compose service names as hosts (`db`, never `localhost` inside containers).
- Migrations are versioned. `synchronize: false` at runtime.
- Tests: `*.spec.ts` unit, `*.integration-spec.ts` real infra, `*.e2e-spec.ts` supertest. Run inside `nestjs-api`. Integration and e2e use `--runInBand`.
- OpenAPI decorators on every endpoint. Bearer scheme name `access-token`.
- Phase plan prose in English, identifiers in English, matching `docs/phases/phase-02-auth/`.
- Do not mock MinIO, Redis, Postgres, or FFmpeg where the Compose service can answer.

## Inherited Constraints

- Channel is 1:1 with user, created at registration (`phase-02-auth`). Videos reference `channels.id`.
- Error envelope and validation error code `VALIDATION_ERROR` stay as defined in Fase 02.
- `cleanAllTables` must delete `videos` before `channels` once the table exists.
- Frontend is out of this phase. Do not add Next.js screens.

## Non-UI / Deferred Capabilities

| Capability | Status | Reason |
|------------|--------|--------|
| Edição de título, descrição, categoria e thumbnail customizada | deferred | Fase 04 |
| Visibilidade público / unlisted e fluxo de publicação | deferred | Fase 04. `ready` means processed, not published |
| Player, contagem de views, download button na página | deferred | Fase 05 consumes the presigned URLs from this phase |
