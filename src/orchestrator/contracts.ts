// Output contracts: the shape a task's result must have before the platform accepts it.
// An agent definition names its contract; the assurance and report stages use fixed ones.
// A result that fails its contract, or cites evidence that does not exist in the run,
// is sent back once with the reasons and otherwise fails the task.
import { z } from 'zod';
import type { Json } from '../harness/port.ts';

const text = z.string().trim().min(1);
const evidenceIds = z.array(z.string().regex(/^ev-\d+$/, 'evidence ids look like ev-12'));

const claim = z.looseObject({ statement: text, evidence: evidenceIds });

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
  report: z.looseObject({
    title: text,
    summary: text,
    sections: z.array(z.looseObject({ heading: text, body: text, evidence: evidenceIds })).min(1),
    recommendations: z.array(text),
    openQuestions: z.array(text).optional(),
  }),
} as const;

export type ContractName = keyof typeof contracts;
export const CONTRACT_NAMES = Object.keys(contracts) as ContractName[];
export const isContract = (name: string): name is ContractName => name in contracts;

export interface AssuranceResult {
  verdict: 'pass' | 'conditional' | 'fail';
  summary: string;
  findings: { task: string; severity: 'critical' | 'major' | 'minor'; issue: string; resolution: string }[];
}

export interface ReportResult {
  title: string;
  summary: string;
  sections: { heading: string; body: string; evidence: string[] }[];
  recommendations: string[];
  openQuestions?: string[];
}

/** What a result must look like, in words the agent can act on. */
export const CONTRACT_SHAPES: Record<ContractName, string> = {
  'evidence-pack': '{"summary": string, "claims": [{"statement": string, "evidence": [evidence id, at least one]}], "gaps": [string]}',
  analysis: '{"summary": string, "claims": [{"statement": string, "evidence": [evidence ids; empty if you have none]}], "assumptions": [string], "openQuestions": [string]} — you may add further fields for your subject, such as options, threats, controls, entities or costs',
  assurance: '{"verdict": "pass" | "conditional" | "fail", "summary": string, "findings": [{"task": id of the task the finding is about, "severity": "critical" | "major" | "minor", "issue": string, "resolution": string}]}',
  report: '{"title": string, "summary": string, "sections": [{"heading": string, "body": string, "evidence": [evidence ids]}], "recommendations": [string], "openQuestions": [string]}',
};

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
