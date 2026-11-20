# AGENTS.md

Cursor instruction file for StreamTube. It mirrors the repository `CLAUDE.md` (the Claude Code instructions that shipped with the base project) and adds the Phase 03 video module. The workflow skills, sub-agents, and rules stay in `.claude/` and are the source of the phase artifacts. This session ran that workflow directly: research → plan-context → plan-validate → plan-resolve → plan-build → implement.

## Project

StreamTube is a video sharing platform. Backend is `nestjs-project/` (NestJS 11, TypeORM, PostgreSQL 17). Frontend is `next-frontend/` and is out of scope for Phase 03.

## Rules that always apply

- Run `npm`, `npx`, `node`, `tsc`, and tests inside `docker compose exec nestjs-api`. Never on the host.
- Compose service names are the hosts (`db`, `redis`, `minio`). Do not use `localhost` inside containers.
- Do not commit to `main`. Feature branches start from `dev`.
- Tests: `*.spec.ts` (unit, no I/O), `*.integration-spec.ts` (real DB and services), `*.e2e-spec.ts` (supertest). Integration and e2e run with `--runInBand`.
- Definition of done: relevant tests, full suite, `npx tsc --noEmit` exit 0, `npm run lint`.
- Global JWT guard. Public routes need `@Public()`.
- Domain errors extend `DomainException`. Envelope is `{ statusCode, error, message }`.
- Do not send video bytes through the API. Uploads are presigned multipart PUTs to object storage.

## Phase 03 — Videos

See `CLAUDE.md` section "Phase 03 — Videos" and `nestjs-project/CLAUDE.md` section "Videos". Those sections match the code: `src/videos/`, `src/storage/`, `src/queue/`, `src/worker.ts`, Compose services `redis`, `minio`, `minio-init`, `video-worker`.

Planning artifacts:

- `docs/decisions/technical-decisions-phase-03-videos.md`
- `docs/phases/phase-03-videos/context.md`
- `docs/phases/phase-03-videos/validation.md` (`status: clean`)
- `docs/phases/phase-03-videos/library-refs.md`
- `docs/phases/phase-03-videos/phase-03-videos.md`
- `docs/phases/phase-03-videos/progress.md`

## MCP

`.cursor/mcp.json` registers the Postgres server from `.mcp.json`. Context7 was not available in the session that implemented Phase 03; library notes in `library-refs.md` cite the official NestJS, BullMQ, and AWS SDK pages that were read instead.
