---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-19T01:07:30-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-19T01:06:39-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Who may stream or download a video before Fase 04 visibility exists"
    resolved_by: phase-03-videos/TD-05
  - id: AMB-2
    status: resolved
    summary: "Presigned URL host is minio inside Compose and localhost on the host"
    resolved_by: phase-03-videos/TD-02
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ No screen inventory for this phase. `next-frontend/` is out of scope.

## Resolved Issues

### AMB-1 — Playback audience before visibility exists

**Summary:** "Download do vídeo pelo usuário" and "reprodução via streaming" do not say whether a processed video is public. Fase 04 is the phase that adds public vs unlisted, and Fase 05 is the anonymous watch page.

**Resolution:** `phase-03-videos/TD-05`. Playback and download are public once `status = ready`. Owner-only routes cover draft, processing, and error. `ready` means processed, not published. Visibility stays deferred.

### AMB-2 — Which host is baked into presigned URLs

**Summary:** The API container must call MinIO at `http://minio:9000`, but a signature covers the Host header. Tests run inside `nestjs-api`; a future browser runs on the host at `localhost:9000`.

**Resolution:** `phase-03-videos/TD-02`. `S3_ENDPOINT` is the in-network client. `S3_PUBLIC_ENDPOINT` is the host used only for presigning. Default both to `http://minio:9000` so container tests and the worker agree. Host-side clients override the public endpoint.

## Checks performed

- Every Fase 03 bullet in `docs/project-plan.md` maps to at least one decided TD (see context.md Capability Coverage).
- Queue is no longer TBD: TD-01 chooses BullMQ + Redis and the diagram's separate queue container is Redis.
- Upload path does not proxy the body through Nest (TD-02). Single PUT was rejected because of the 5GB S3 cap.
- Worker is a different process from the API (TD-03).
- Status set is exactly draft, processing, ready, error (TD-06), which matches the required cycle.
- Fase 02 constraints (global JWT, domain error envelope, channel 1:1, Compose hostnames) are reused, not replaced.
- One phase-scope decisions doc for phase 3, so there is no cross-slice gap.
- No UI inventory file, so UI coverage checks do not apply.
