# AI Interview Prep Kit

Turns a job description plus a company URL into a study kit: requirements, questions, flashcards
and a day-by-day schedule. Implementation follows `prep-kit-plan.md`.

## Run

```
npm install
npm test        # node:test, no framework
npm run typecheck
npm run crawl   # H2 demo: gitlab.com, posthog.com, and a dead domain
```

Node 22.18+ is required — TypeScript runs directly via Node's native type stripping, so there is
no build step and no `tsx`.

## Environment

| Variable | Needed for | Default |
|---|---|---|
| `TAVILY_API_KEY` | Search. Free, no card, 1,000 credits a month, one per kit. | unset — falls back to a keyless DuckDuckGo scrape |
| `ALLOW_PRIVATE_HOSTS` | Batch cases served from localhost. Never set in production. | `false` |
| `RUN_SEARCH` | Makes `npm run crawl` also run the discussion search. | `false` |

## Layout

```
apps/api/src/contract.ts              Appendix A schema, validateKit, toAppendixA
apps/api/src/pipeline/                pure stages: allocateSchedule, checkCoverage
apps/api/src/retrieval/               fetchPage, crawlSite, rank, search
apps/api/src/dev/crawl.ts             H2 demo script
```

## Status

**H1 — contract and pure core: done.**

- `contract.ts` — the Appendix A zod schema, its cross-field invariants, and `toAppendixA`, the
  single serializer every emit path goes through.
- `allocateSchedule` — plan §5. Pure integer arithmetic, no model.
- `checkCoverage` — plan §6. Pure set operation.

**H2 — retrieval: done.**

- `fetchPage` — SSRF guard, 8s timeout, 2 MB streamed and aborted, content-type allowlist,
  3 redirects with the host re-validated at every hop.
- `crawlSite` — robots.txt, sitemap discovery, link ranking, and the plan §3 budget (12 fetches,
  45s wall clock, 3 concurrent, 250ms spacing).
- `rank` — the plan §3 scoring function, over a vocabulary rather than a list of guessed paths.
- `search` — Tavily when a key is present, keyless DuckDuckGo otherwise.

29 tests, all offline: the private-address table, the HTML parser, ranking, robots parsing, and
the fetch limits against a local server.

Verified live: `gitlab.com` → `about.gitlab.com/jobs/`, `posthog.com` → `posthog.com/careers`,
a nonexistent domain → `COMPANY_UNREACHABLE` with both the https and http attempts logged.

Not yet built: generation (H3), batch CLI (H4), API and UI (H5–H7). Mongo is deliberately absent —
nothing so far needs it, so it lands with the API in H5.

## Decisions and stated ceilings

**Appendix A field names are provisional.** The assessment brief was not available when this was
written, so `contract.ts` uses the field names quoted in the plan. Reconcile it against Appendix A
verbatim before submitting; `contract.ts` is the only file that needs changing.

**A day may hold more than its minute budget.** The schedule fills greedily to
`ceil(total / days)`, and the question that crosses the cap is placed anyway. A binding cap that
orphaned questions would be worse than a day that runs slightly long.

**No `order` field.** Array position is the order, and array position is what gets serialised.

**Days are not clamped at 60.** The graded invariant is that the number of days equals the number
requested. Only non-integers, values below 1, and values above 365 are rejected.

**Empty days are allowed only when the kit has no questions at all.** Otherwise every day carries
at least one question id — days past the first pass re-list the highest-difficulty must-have
questions on a rotating cycle rather than sitting empty.

**The SSRF guard has a TOCTOU window.** The host is resolved and checked, then fetched, and fetch
resolves again — DNS rebinding against a 0-TTL record could still get through. Closing it needs a
pinned-IP dispatcher (undici `Agent` with a custom `lookup`). Marked in `fetchPage.ts`; worth doing
only if this ever accepts URLs from untrusted submitters.

**The keyless search fallback is scraping, and it is unreliable.** DuckDuckGo answers a POST from a
bot user-agent with a 202 challenge page and no results, so the fallback issues a GET with a browser
user-agent instead. Even then it rate-limits and result quality varies with capitalisation. Tavily
is the real path; the fallback exists so a clean clone with no keys still produces something.

**No headless browser.** A JS-only homepage falls back to sitemap link discovery. **No PDF
parsing** — a non-HTML content type is skipped and recorded as `SKIPPED_CONTENT_TYPE`.
