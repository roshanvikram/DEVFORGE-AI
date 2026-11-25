# Testing

## Automated suites

```bash
npm test                                  # server + web
npm run test:live --workspace server      # optional: real Claude API (needs ANTHROPIC_API_KEY)
```

**Latest run: server 55 / 55 passed, web 13 / 13 passed.** Both packages also pass `npm run typecheck`, and both build for production.

### Server — `server/test/`

All server tests use the real stack. Nothing inside DevForge is mocked:

- Express runs over HTTP with supertest.
- Each run gets a throwaway SQLite database in `data/test-<pid>`.
- The real job queue analyses repositories generated in the OS temp directory.
- The WebSocket server is real.

Secret-like values in the fixtures are built at runtime, so the source never contains a literal credential pattern.

| File | Tests | What is proven |
| --- | --- | --- |
| `platform.test.ts` | 39 | Auth (CSRF, origin, password policy, login success and failure, hashed sessions); tenancy (forged `X-Workspace-Id` rejected) and RBAC; SSRF guards and local-import roots; real detection of SQL injection, eval, unsafe deserialization and secrets (masked); a clean repo has no security findings; search, path traversal, architecture graph; findings triage; health history; quality gates (fail, pass, notify, validation); auto-sync refusal for local repos; HMAC webhooks (signed, forged, ignored branch, encrypted secret, 404); presence over WebSocket; unauthenticated sockets rejected; Live Ops metrics; AES-GCM and log redaction; dashboard counts match the database |
| `sandbox.test.ts` | 7 | macOS `sandbox-exec` mode. The repo's own tests run and parse (pass and fail counted). Network is blocked, writes outside the workdir are blocked, reads of DevForge's data directory are blocked, and server env vars do not leak. A full `npm test` suite runs through the API and records 2 passed / 1 failed |
| `ai.test.ts` | 9 | DevForge's real provider code (Anthropic SDK, streaming, tool loop, structured output) runs against a local Messages-API stand-in. Covers: the no-key fallback, a rejected key not stored, a valid key stored encrypted and never echoed, Q&A with bounded context, citations and usage/cost accounting, and an agent tool loop calling a real tool and reporting its real output, with only that agent's tools sent. Also: AI hypotheses labelled, an invented file flagged, the patch never applied, a revoked key mapped to `ai_auth` without leaking, an account with no credit mapped to `ai_billing`, and the monthly budget enforced before any provider call |
| `live-claude.test.ts` | 1 (skipped without a key) | A structured-output request against the real Claude API through DevForge's provider. Last run (2026-11-25): the key was accepted and the request reached the API, which refused it for insufficient account credit; it has not yet passed end to end |

### Web — `web/src/__tests__/`

| File | Tests | What is proven |
| --- | --- | --- |
| `format.test.ts` | 4 | Relative times, durations, money and percentages; missing values render "—" |
| `grade.test.ts` | 2 | Grade thresholds; the UI's dimension weights match the server's health-score formula (read from `metrics.ts`) |
| `events.test.ts` | 4 | Live Ops event descriptions |
| `api.test.ts` | 3 | CSRF and workspace headers on every request; structured errors; an unreachable server reported as status 0, so the UI retries instead of logging out |

### Layout

All 27 app routes and 7 public routes were checked at 375 px for horizontal overflow; all fit. This pass found and fixed overflowing tab strips and a landing-page code sample.

## Recorded walkthrough

[`docs/media/devforge-testing-walkthrough.mp4`](media/devforge-testing-walkthrough.mp4) is a 55 s, 1280×800 H.264 video of a manual test pass in the browser. Every frame is a screenshot of the running local build:

1. Sign in.
2. Command Center: health score with grade, weighted dimensions and live presence.
3. Quality gate: a strict policy is saved and evaluated. It fails on a score of 99 against a limit of 100, and a notification arrives.
4. Live Ops: a refresh is triggered, and the job, scan, health, gate and notification events stream in as they happen.
5. Auto-sync: `git ls-remote` runs against github.com and finds the remote head equal to the analysed commit.
6. Signed webhooks: a ping returns 200 and a forged signature 401. A push to a feature branch is ignored; a push to master queues an analysis.
7. Health history and gate status on the Command Center.
8. Automated test results.

The machine did not allow screen recording (macOS permission), so the video is a sequence of captioned screenshots, not a continuous capture.

## Limits

- The live Claude test needs a real key. Model answer quality is outside what these tests can prove.
- The Docker sandbox is implemented but was verified only through macOS `sandbox-exec` on this machine.
- The UI end-to-end pass is manual, recorded in the walkthrough. A Playwright suite is the next step (see IMPLEMENTATION_PLAN).
