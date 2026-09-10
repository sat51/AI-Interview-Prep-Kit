/**
 * Stage 10. Pure set operation, two jobs:
 *   1. Strip requirement_ids that reference ids which do not exist. Models hallucinate ids,
 *      and an unstripped bad ref makes a requirement look covered when it is not.
 *   2. Report must-have requirements with zero referencing questions.
 */
import type { Question, Requirement } from "../contract.ts";

export type CoverageResult = {
  /** Input questions with hallucinated and duplicate requirement_ids removed. */
  questions: Question[];
  covered_requirement_ids: string[];
  uncovered_must_ids: string[];
  uncovered_nice_ids: string[];
};

export function checkCoverage(requirements: Requirement[], questions: Question[]): CoverageResult {
  const known = new Set(requirements.map((r) => r.id));

  const cleaned = questions.map((q) => {
    const ids = [...new Set(q.requirement_ids)].filter((id) => known.has(id));
    return ids.length === q.requirement_ids.length ? q : { ...q, requirement_ids: ids };
  });

  const referenced = new Set(cleaned.flatMap((q) => q.requirement_ids));
  const uncovered = requirements.filter((r) => !referenced.has(r.id));

  return {
    questions: cleaned,
    covered_requirement_ids: requirements.filter((r) => referenced.has(r.id)).map((r) => r.id),
    uncovered_must_ids: uncovered.filter((r) => r.priority === "must").map((r) => r.id),
    uncovered_nice_ids: uncovered.filter((r) => r.priority === "nice").map((r) => r.id),
  };
}
