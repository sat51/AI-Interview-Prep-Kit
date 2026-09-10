/**
 * Stage 12. Pure arithmetic — no model, no floats, no randomness.
 * Invariants asserted by the tests: days.length === daysAvailable; every question_ids entry
 * exists; every minutes is a positive integer; every must-have requirement is reachable.
 */
import type { Question, Requirement, Schedule } from "../contract.ts";

/** 10 / 15 / 20 by construction, because difficulty is already clamped to 1..3. */
export const questionMinutes = (q: Pick<Question, "difficulty">) => 10 + 5 * (q.difficulty - 1);

/** Flat allowance per day for flashcard review, on top of the day's questions. */
const FLASHCARD_MINUTES = 10;

const CATEGORY_LABEL: Record<Question["category"], string> = {
  technical: "Technical depth",
  behavioural: "Behavioural",
  "system-design": "System design",
  "company-fit": "Company fit",
};

const truncate = (s: string, n = 40) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export function allocateSchedule(
  questions: Question[],
  requirements: Requirement[],
  daysAvailable: number,
): Schedule {
  if (!Number.isInteger(daysAvailable) || daysAvailable < 1 || daysAvailable > 365) {
    throw new Error(`days_available must be an integer 1..365, got ${daysAvailable}`);
  }

  const reqIndex = new Map(requirements.map((r, i) => [r.id, i] as const));
  const reqText = new Map(requirements.map((r) => [r.id, r.text] as const));
  const mustIds = new Set(requirements.filter((r) => r.priority === "must").map((r) => r.id));

  const coversMust = (q: Question) => q.requirement_ids.some((id) => mustIds.has(id));
  const firstReq = (q: Question) =>
    Math.min(Infinity, ...q.requirement_ids.map((id) => reqIndex.get(id) ?? Infinity));

  // Must-have and hard first. Greedy fill over this order front-loads without a second pass.
  const ordered = [...questions].sort(
    (a, b) =>
      Number(coversMust(b)) - Number(coversMust(a)) ||
      b.difficulty - a.difficulty ||
      firstReq(a) - firstReq(b) ||
      a.id.localeCompare(b.id),
  );

  const total = ordered.reduce((s, q) => s + questionMinutes(q), 0);
  const budget = Math.max(1, Math.ceil(total / daysAvailable));

  const buckets: Question[][] = [];
  let i = 0;
  for (let d = 0; d < daysAvailable; d++) {
    const isLast = d === daysAvailable - 1;
    const bucket: Question[] = [];
    let mins = 0;
    // The item that crosses the cap is placed anyway, so no question is orphaned by the cap.
    // The last day takes whatever remains, so nothing is left unplaced either.
    while (i < ordered.length && (isLast || mins < budget)) {
      const q = ordered[i++]!;
      bucket.push(q);
      mins += questionMinutes(q);
    }
    buckets.push(bucket);
  }

  // Days past the first pass are review days: highest-difficulty must-haves, rotating.
  const mustFirst = ordered.filter(coversMust);
  const reviewPool = [...(mustFirst.length ? mustFirst : ordered)].sort(
    (a, b) => b.difficulty - a.difficulty || a.id.localeCompare(b.id),
  );
  let cursor = 0;

  const days = buckets.map((bucket, idx) => {
    const isReview = bucket.length === 0 && reviewPool.length > 0;
    const items = isReview ? [reviewPool[cursor++ % reviewPool.length]!] : bucket;
    return {
      day: idx + 1,
      focus: focusFor(items, reqText, isReview),
      question_ids: items.map((q) => q.id),
      minutes: items.reduce((s, q) => s + questionMinutes(q), 0) + FLASHCARD_MINUTES,
    };
  });

  return { days, stale: false };
}

function focusFor(items: Question[], reqText: Map<string, string>, isReview: boolean): string {
  if (items.length === 0) return "Flashcard review";

  const counts = new Map<Question["category"], number>();
  for (const q of items) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);
  const dominant = [...counts].sort((a, b) => b[1] - a[1])[0]![0];

  const texts: string[] = [];
  for (const q of items) {
    for (const id of q.requirement_ids) {
      const t = reqText.get(id);
      if (t && !texts.includes(t)) texts.push(t);
      if (texts.length === 2) break;
    }
    if (texts.length === 2) break;
  }

  const head = isReview ? `Review — ${CATEGORY_LABEL[dominant]}` : CATEGORY_LABEL[dominant];
  return texts.length ? `${head}: ${texts.map((t) => truncate(t)).join(", ")}` : head;
}
