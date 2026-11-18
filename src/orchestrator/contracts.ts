// Output contracts: the shape a task's result must have before the platform accepts it.
// An agent definition names its contract; the assurance and report stages use fixed ones.
// A result that fails its contract, or cites evidence that does not exist in the run,
// is sent back once with the reasons and otherwise fails the task.
import { z } from 'zod';
import type { Json } from '../harness/port.ts';

const text = z.string().trim().min(1);
const evidenceIds = z.array(z.string().regex(/^ev-\d+$/, 'evidence ids look like ev-12'));

const claim = z.looseObject({ statement: text, evidence: evidenceIds });
const blankToUndefined = (v: unknown) => (typeof v === 'string' && !v.trim() ? undefined : v);
const noRecommendation = (v: unknown) =>
  v === null || (typeof v === 'object' && !Array.isArray(v) && ((v as { kind?: unknown }).kind === 'none' || !(v as { kind?: unknown }).kind)) ? undefined : v;

const contracts = {
  /** Research: every finding must cite at least one evidence record. */
  'evidence-pack': z.looseObject({
    summary: text,
    claims: z.array(claim.extend({ evidence: evidenceIds.min(1, 'a research finding must cite at least one evidence id') })).min(1),
    gaps: z.array(text).optional(),
  }),
  /** Analysis: claims with the evidence behind each. A claim with no evidence is allowed but must say so by an empty list. */
  analysis: z.looseObject({
    summary: text,
    claims: z.array(claim).min(1),
    assumptions: z.array(text).optional(),
    openQuestions: z.array(text).optional(),
  }),
  assurance: z.looseObject({
    verdict: z.enum(['pass', 'conditional', 'fail']),
    summary: text,
    findings: z.array(z.looseObject({
      task: text, severity: z.enum(['critical', 'major', 'minor']), issue: text, resolution: text,
    })),
  }),
  /**
   * A decision brief. Lengths are capped so the brief stays short; the full task results go in the
   * appendix the platform writes beside it. Fields beyond these are accepted but not shown.
   */
  report: z.looseObject({
    title: text.max(100, 'title: at most 100 characters'),
    answer: text.max(600, 'answer: at most 600 characters (three short sentences)'),
    findings: z.array(z.looseObject({
      heading: text.max(80, 'heading: at most 80 characters'),
      point: text.max(300, 'point: at most 300 characters (one or two sentences)'),
      evidence: evidenceIds,
    })).min(1).max(4, 'findings: at most 4'),
    recommendations: z.array(text.max(200, 'recommendation: at most 200 characters, one sentence')).min(1).max(4, 'recommendations: at most 4'),
    decisionsNeeded: z.array(text.max(200, 'decision: at most 200 characters, one sentence')).max(4, 'decisionsNeeded: at most 4'),
  }),
  /**
   * Capability assessment: what a body of work needs, set against the approved agents and skills. The registry
   * checks (real agents, eligible skills, new ids that are actually new) are in `checkAssessment`.
   */
  'capability-assessment': z.looseObject({
    summary: text,
    needs: z.array(z.looseObject({
      need: text,
      evidence: evidenceIds.min(1, 'each need must cite the evidence that shows the work requires it'),
      coverage: z.enum(['covered', 'partial', 'gap']),
      coveredBy: z.array(z.looseObject({ agent: text, skills: z.array(text) })).default([]),
      priority: z.enum(['high', 'medium', 'low']),
      // Models fill every field of a covered need's recommendation with "" or kind "none"; that means no recommendation.
      recommendation: z.preprocess(noRecommendation, z.looseObject({
        kind: z.enum(['new-skill', 'extend-agent', 'new-agent']),
        /** The skill or agent to create, or the skill to add to an existing agent. */
        id: text,
        /** The agent the skill is for, or the agent to extend. */
        agent: z.preprocess(blankToUndefined, text.optional()),
        detail: text,
      }).optional()),
    })).min(1).max(40),
    classification: z.array(text).optional(),
  }),
  /** Evaluation: one verdict per answer-key criterion the platform gave the evaluator. Which ids must appear is checked in code. */
  evaluation: z.looseObject({
    summary: text,
    checks: z.array(z.looseObject({
      id: text,
      verdict: z.enum(['pass', 'fail', 'unclear']),
      reason: text.max(600, 'reason: at most 600 characters'),
    })).min(1).max(40),
  }),
  /** Improvement proposals: drafted changes to agents and skills, each tied to the run signals behind it. Targets and signal ids are checked in code. */
  'improvement-proposals': z.looseObject({
    summary: text,
    proposals: z.array(z.looseObject({
      target: z.looseObject({ kind: z.enum(['agent', 'skill']), id: text }),
      problem: text,
      signals: z.array(z.string().regex(/^S\d+$/, 'signal ids look like S3')).min(1, 'each proposal must cite the signals behind it'),
      where: text,
      change: text.max(2000, 'change: at most 2000 characters'),
      expectedEffect: text,
      priority: z.enum(['high', 'medium', 'low']),
    })).max(8, 'proposals: at most 8'),
  }),
} as const;

/** Contracts whose results are about the platform, not about an objective. Agents producing them are never given planned tasks. */
export const PLATFORM_ONLY_CONTRACTS: ReadonlySet<string> = new Set(['capability-assessment', 'evaluation', 'improvement-proposals']);

export type ContractName = keyof typeof contracts;
export const CONTRACT_NAMES = Object.keys(contracts) as ContractName[];
export const isContract = (name: string): name is ContractName => name in contracts;

export interface AssuranceResult {
  verdict: 'pass' | 'conditional' | 'fail';
  summary: string;
  findings: { task: string; severity: 'critical' | 'major' | 'minor'; issue: string; resolution: string }[];
}

export interface CapabilityNeed {
  need: string;
  evidence: string[];
  coverage: 'covered' | 'partial' | 'gap';
  coveredBy: { agent: string; skills: string[] }[];
  priority: 'high' | 'medium' | 'low';
  /** Absent, null or kind "none" all mean no change is recommended. */
  recommendation?: { kind: 'none' | 'new-skill' | 'extend-agent' | 'new-agent'; id?: string; agent?: string; detail?: string } | null;
}

export interface CapabilityAssessment {
  summary: string;
  needs: CapabilityNeed[];
  classification?: string[];
}

export interface EvaluationResult {
  summary: string;
  checks: { id: string; verdict: 'pass' | 'fail' | 'unclear'; reason: string }[];
}

export interface ImprovementProposal {
  target: { kind: 'agent' | 'skill'; id: string };
  problem: string;
  signals: string[];
  where: string;
  change: string;
  expectedEffect: string;
  priority: 'high' | 'medium' | 'low';
}

export interface ImprovementResult {
  summary: string;
  proposals: ImprovementProposal[];
}

export interface ReportResult {
  title: string;
  answer: string;
  findings: { heading: string; point: string; evidence: string[] }[];
  recommendations: string[];
  decisionsNeeded: string[];
}

/** What a result must look like, in words the agent can act on. */
export const CONTRACT_SHAPES: Record<ContractName, string> = {
  'evidence-pack': '{"summary": string, "claims": [{"statement": string, "evidence": [evidence id, at least one]}], "gaps": [string]}',
  analysis: '{"summary": string, "claims": [{"statement": string, "evidence": [evidence ids; empty if you have none]}], "assumptions": [string], "openQuestions": [string]} — you may add further fields for your subject, such as options, threats, controls, entities or costs',
  assurance: '{"verdict": "pass" | "conditional" | "fail", "summary": string, "findings": [{"task": id of the task the finding is about, "severity": "critical" | "major" | "minor", "issue": string, "resolution": string}]}',
  report: '{"title": string (at most 100 characters), "answer": string (the bottom line, at most 600 characters), "findings": [{"heading": string (at most 80), "point": string (at most 300), "evidence": [evidence ids]}] (1 to 4), "recommendations": [string, one sentence each, at most 200 characters] (1 to 4), "decisionsNeeded": [string, one sentence each, at most 200 characters] (at most 4)}',
  'capability-assessment': '{"summary": string, "needs": [{"need": string, "evidence": [evidence ids, at least one], "coverage": "covered" | "partial" | "gap", "coveredBy": [{"agent": approved agent id, "skills": [ids from that agent\'s eligible skills]}], "priority": "high" | "medium" | "low", "recommendation": omit when covered; otherwise {"kind": "new-skill" | "extend-agent" | "new-agent", "id": new skill or agent id, or the existing skill to add, "agent": agent the skill is for or the agent to extend, "detail": string}}], "classification": [data classification concerns, as strings]}',
  evaluation: '{"summary": string, "checks": [{"id": criterion id as given, "verdict": "pass" | "fail" | "unclear", "reason": string, at most 600 characters, quoting or pointing to the part of the report that decides it}]} — one entry for every criterion, none for anything else',
  'improvement-proposals': '{"summary": string, "proposals": [{"target": {"kind": "agent" | "skill", "id": id of an agent or skill in the definitions given}, "problem": string, "signals": [signal ids such as "S3", at least one], "where": the instruction, method step, rule or quality criterion to change, "change": string, the exact text to add or the replacement text (at most 2000 characters), "expectedEffect": string, "priority": "high" | "medium" | "low"}] (at most 8; none if nothing recurs)}',
};

/** An assessment as the contract reads it: blank or "none" recommendations removed, missing lists defaulted. Call after `checkResult` passes. */
export function parseAssessment(result: Json): CapabilityAssessment {
  return contracts['capability-assessment'].parse(result) as unknown as CapabilityAssessment;
}

/** Every evidence id cited anywhere in a result: any `evidence` list, at any depth. */
export function citedEvidence(value: Json | undefined): string[] {
  const found = new Set<string>();
  const walk = (v: Json | undefined): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [key, inner] of Object.entries(v)) {
        if (key === 'evidence' && Array.isArray(inner)) inner.forEach((id) => typeof id === 'string' && found.add(id));
        else walk(inner);
      }
    }
  };
  walk(value);
  return [...found];
}

/** Reasons the result may not be accepted. An empty list means it may. */
export function checkResult(
  contract: ContractName | undefined, result: Json, context: { evidenceIds: Set<string>; taskIds: Set<string> },
): string[] {
  const problems: string[] = [];
  if (contract) {
    const parsed = contracts[contract].safeParse(result);
    if (!parsed.success) problems.push(...parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'result'}: ${i.message}`));
  }
  // Checked in code, whatever the contract: a citation must point at something an agent actually retrieved in this run.
  const unknown = citedEvidence(result).filter((id) => !context.evidenceIds.has(id));
  if (unknown.length) problems.push(`cites evidence that does not exist in this run: ${unknown.slice(0, 8).join(', ')}`);
  if (contract === 'assurance' && !problems.length) {
    const strangers = (result as unknown as AssuranceResult).findings.map((f) => f.task).filter((t) => !context.taskIds.has(t));
    if (strangers.length) problems.push(`findings name tasks that are not under review: ${[...new Set(strangers)].join(', ')}`);
  }
  return problems;
}
