import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateSchedule, questionMinutes } from "./allocateSchedule.ts";
import { checkCoverage } from "./checkCoverage.ts";
import { toAppendixA, validateKit, type Question, type Requirement } from "../contract.ts";

const req = (i: number, priority: "must" | "nice" = "must"): Requirement => ({
  id: `r${i}`,
  text: `Requirement number ${i}`,
  kind: "technical",
  priority,
});

const q = (i: number, difficulty: 1 | 2 | 3, requirement_ids: string[] = []): Question => ({
  id: `q${i}`,
  category: "technical",
  prompt: `Question ${i}`,
  difficulty,
  requirement_ids,
  rationale: "",
  round: null,
  origin: "generated",
  edited: false,
  pinned: false,
  gen: null,
});

/** The four invariants from §5, asserted on every schedule the tests build. */
function assertInvariants(schedule: ReturnType<typeof allocateSchedule>, qs: Question[], n: number) {
  assert.equal(schedule.days.length, n, "days.length === days_available");
  const ids = new Set(qs.map((x) => x.id));
  for (const [i, d] of schedule.days.entries()) {
    assert.equal(d.day, i + 1);
    assert.ok(Number.isInteger(d.minutes) && d.minutes > 0, `day ${d.day} minutes`);
    assert.ok(qs.length === 0 || d.question_ids.length > 0, `day ${d.day} is empty`);
    for (const id of d.question_ids) assert.ok(ids.has(id), `unknown question id ${id}`);
  }
}

test("N = 1 puts everything on one day and says the honest minute count", () => {
  const rs = [req(1), req(2)];
  const qs = [q(1, 3, ["r1"]), q(2, 2, ["r2"]), q(3, 1)];
  const s = allocateSchedule(qs, rs, 1);
  assertInvariants(s, qs, 1);
  const total = qs.reduce((a, x) => a + questionMinutes(x), 0);
  assert.equal(s.days[0]!.question_ids.length, 3);
  assert.equal(s.days[0]!.minutes, total + 10);
});

test("N = 60 with 15 questions produces 60 real days, none empty", () => {
  const rs = Array.from({ length: 5 }, (_, i) => req(i + 1));
  const qs = Array.from({ length: 15 }, (_, i) => q(i + 1, ((i % 3) + 1) as 1 | 2 | 3, [`r${(i % 5) + 1}`]));
  const s = allocateSchedule(qs, rs, 60);
  assertInvariants(s, qs, 60);
  const placed = new Set(s.days.flatMap((d) => d.question_ids));
  assert.equal(placed.size, 15, "every question appears somewhere");
  assert.ok(s.days.slice(15).every((d) => d.focus.startsWith("Review — ")), "later days are review");
});

test("N = 3 with 40 questions places all of them and front-loads must-haves", () => {
  const rs = [req(1, "must"), req(2, "nice")];
  const qs = Array.from({ length: 40 }, (_, i) =>
    q(i + 1, ((i % 3) + 1) as 1 | 2 | 3, [i < 20 ? "r1" : "r2"]),
  );
  const s = allocateSchedule(qs, rs, 3);
  assertInvariants(s, qs, 3);
  const placed = s.days.flatMap((d) => d.question_ids);
  assert.equal(new Set(placed).size, 40, "no question placed twice or dropped");
  const day1 = new Set(s.days[0]!.question_ids);
  const mustOnDay1 = qs.filter((x) => day1.has(x.id) && x.requirement_ids.includes("r1")).length;
  assert.equal(mustOnDay1, day1.size, "day 1 is entirely must-have questions");
});

test("no questions at all still yields the requested number of days", () => {
  const s = allocateSchedule([], [], 4);
  assertInvariants(s, [], 4);
  assert.ok(s.days.every((d) => d.minutes === 10));
});

test("days_available is rejected outside 1..365 and for non-integers", () => {
  for (const bad of [0, -1, 2.5, 366]) {
    assert.throws(() => allocateSchedule([q(1, 1)], [], bad), /days_available/);
  }
  assert.equal(allocateSchedule([q(1, 1)], [], 365).days.length, 365);
});

test("checkCoverage strips hallucinated ids instead of trusting them", () => {
  const rs = [req(1), req(2, "nice")];
  const qs = [q(1, 2, ["r1", "r99", "r1"]), q(2, 1, ["r404"])];
  const c = checkCoverage(rs, qs);
  assert.deepEqual(c.questions[0]!.requirement_ids, ["r1"]);
  assert.deepEqual(c.questions[1]!.requirement_ids, []);
  assert.deepEqual(c.covered_requirement_ids, ["r1"]);
  assert.deepEqual(c.uncovered_must_ids, []);
  assert.deepEqual(c.uncovered_nice_ids, ["r2"], "uncovered nice requirements are reported, not chased");
});

test("checkCoverage reports an uncovered must-have", () => {
  const c = checkCoverage([req(1), req(2)], [q(1, 1, ["r1"])]);
  assert.deepEqual(c.uncovered_must_ids, ["r2"]);
});

const kitDraft = () => {
  const rs = [req(1)];
  const qs = [q(1, 2, ["r1"]), q(2, 1, ["r1"])];
  return {
    source: {
      company_url: "https://acme.com",
      company_name: "Acme",
      jd_quality: "ok",
      days_available: 2,
      pages_used: [],
    },
    company_brief: "Acme builds things.",
    role: { title: "Engineer", seniority: "mid", responsibilities: [], requirements: rs },
    questions: qs,
    flashcards: [],
    schedule: allocateSchedule(qs, rs, 2),
    coverage: { passes: 1, covered_requirement_ids: ["r1"], uncovered_requirement_ids: [], fallback_question_ids: [] },
  };
};

test("validateKit accepts a well-formed kit and clamps a difficulty of 5", () => {
  const draft = kitDraft();
  draft.questions[0]!.difficulty = 5 as 3;
  const kit = validateKit(draft);
  assert.equal(kit.questions[0]!.difficulty, 3);
});

test("validateKit rejects a schedule pointing at a question that does not exist", () => {
  const draft = kitDraft();
  draft.schedule.days[0]!.question_ids = ["q404"];
  assert.throws(() => validateKit(draft), /does not exist/);
});

test("validateKit rejects a day count that does not match days_available", () => {
  const draft = kitDraft();
  draft.schedule.days.pop();
  assert.throws(() => validateKit(draft), /days_available/);
});

test("validateKit rejects a must-have requirement with no question", () => {
  const draft = kitDraft();
  for (const x of draft.questions) x.requirement_ids = [];
  assert.throws(() => validateKit(draft), /must-have/);
});

test("toAppendixA drops internal fields", () => {
  const emitted = toAppendixA({ ...kitDraft(), _id: "x", version: 3, id_seq: 9, research: {}, practice: {} });
  assert.deepEqual(Object.keys(emitted).sort(), [
    "company_brief",
    "coverage",
    "flashcards",
    "questions",
    "role",
    "schedule",
    "source",
  ]);
});
