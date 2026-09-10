/**
 * The Appendix A contract. One schema, one serializer — everything that emits a kit
 * (API, batch CLI, tests) goes through here so there is exactly one thing to get wrong.
 *
 * NOTE: field names below are taken from the implementation plan, which quotes Appendix A
 * second-hand. Reconcile against the assessment brief's Appendix A verbatim before shipping;
 * this file is the only place that needs editing when you do.
 */
import { z } from "zod";

export const CATEGORIES = ["technical", "behavioural", "system-design", "company-fit"] as const;
export const KINDS = ["technical", "behavioural", "domain"] as const;
export const ORIGINS = ["generated", "manual", "fallback"] as const;

/** Edge case 18: models return difficulty 5 or 2.7. Coerce, round, clamp to 1..3. */
export const difficulty = z.coerce
  .number()
  .transform((n) => Math.min(3, Math.max(1, Math.round(n))));

/** Every minutes field is a positive integer, by construction, everywhere. */
export const positiveInt = z.coerce.number().transform(Math.round).pipe(z.int().positive());

export const provenance = z.object({
  origin: z.enum(ORIGINS).default("generated"),
  edited: z.boolean().default(false),
  pinned: z.boolean().default(false),
  gen: z
    .object({ pass: z.int().nonnegative(), batch: z.string(), at: z.iso.datetime() })
    .nullable()
    .default(null),
});

export const requirementSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(KINDS),
  priority: z.enum(["must", "nice"]),
});

export const questionSchema = z
  .object({
    id: z.string().min(1),
    category: z.enum(CATEGORIES),
    prompt: z.string().min(1),
    difficulty,
    requirement_ids: z.array(z.string()).default([]),
    rationale: z.string().default(""),
    round: z.string().nullable().default(null), // §10 Round Map; null when research found no stages
  })
  .extend(provenance.shape);

export const flashcardSchema = z
  .object({
    id: z.string().min(1),
    front: z.string().min(1),
    back: z.string().min(1),
    requirement_ids: z.array(z.string()).default([]),
  })
  .extend(provenance.shape);

export const roleSchema = z.object({
  title: z.string(),
  seniority: z.enum(["junior", "mid", "senior", "staff", "unknown"]),
  responsibilities: z.array(z.string()).default([]),
  requirements: z.array(requirementSchema).default([]),
});

export const sourceSchema = z.object({
  company_url: z.string().nullable(),
  company_name: z.string(),
  jd_quality: z.enum(["ok", "thin", "unusable"]),
  days_available: z.int().min(1).max(365),
  pages_used: z.array(z.string()).default([]),
});

export const scheduleDaySchema = z.object({
  day: z.int().positive(),
  focus: z.string(),
  question_ids: z.array(z.string()),
  minutes: positiveInt,
});

export const scheduleSchema = z.object({
  days: z.array(scheduleDaySchema),
  stale: z.boolean().default(false),
});

export const coverageSchema = z.object({
  passes: z.int().nonnegative(),
  covered_requirement_ids: z.array(z.string()).default([]),
  uncovered_requirement_ids: z.array(z.string()).default([]),
  fallback_question_ids: z.array(z.string()).default([]),
});

/** The kit as emitted. Cross-field invariants live here, not scattered across callers. */
export const kitSchema = z
  .object({
    source: sourceSchema,
    company_brief: z.string(),
    role: roleSchema,
    questions: z.array(questionSchema),
    flashcards: z.array(flashcardSchema),
    schedule: scheduleSchema,
    coverage: coverageSchema,
  })
  .check(
    z.refine((k) => k.schedule.days.length === k.source.days_available, {
      error: "schedule.days.length must equal source.days_available",
      path: ["schedule", "days"],
    }),
    z.refine(
      (k) => {
        const ids = new Set(k.questions.map((q) => q.id));
        return k.schedule.days.every((d) => d.question_ids.every((id) => ids.has(id)));
      },
      { error: "schedule references a question id that does not exist", path: ["schedule", "days"] },
    ),
    z.refine(
      (k) => {
        const ids = new Set(k.role.requirements.map((r) => r.id));
        return k.questions.every((q) => q.requirement_ids.every((id) => ids.has(id)));
      },
      { error: "a question references a requirement id that does not exist", path: ["questions"] },
    ),
    z.refine(
      (k) => k.questions.length === 0 || k.schedule.days.every((d) => d.question_ids.length > 0),
      { error: "every day must carry at least one question", path: ["schedule", "days"] },
    ),
    z.refine(
      (k) => k.schedule.days.every((d, i) => d.day === i + 1),
      { error: "schedule days must be numbered 1..N in order", path: ["schedule", "days"] },
    ),
    z.refine(
      (k) => {
        const must = k.role.requirements.filter((r) => r.priority === "must").map((r) => r.id);
        const covered = new Set(k.questions.flatMap((q) => q.requirement_ids));
        return must.every((id) => covered.has(id));
      },
      { error: "a must-have requirement has no question covering it", path: ["coverage"] },
    ),
  );

export type Requirement = z.infer<typeof requirementSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Flashcard = z.infer<typeof flashcardSchema>;
export type ScheduleDay = z.infer<typeof scheduleDaySchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type Kit = z.infer<typeof kitSchema>;

const CONTRACT_FIELDS = [
  "source",
  "company_brief",
  "role",
  "questions",
  "flashcards",
  "schedule",
  "coverage",
] as const;

/** Throws on anything that is not a valid kit. The only gate before emit. */
export function validateKit(draft: unknown): Kit {
  const r = kitSchema.safeParse(draft);
  if (!r.success) throw new Error(`Invalid kit:\n${z.prettifyError(r.error)}`);
  return r.data;
}

/**
 * The one serializer. Drops internal fields (_id, version, id_seq, research, practice,
 * heartbeat, status) and validates on the way out, so a bad kit cannot be emitted.
 */
export function toAppendixA(doc: Record<string, unknown>): Kit {
  return validateKit(Object.fromEntries(CONTRACT_FIELDS.map((f) => [f, doc[f]])));
}
