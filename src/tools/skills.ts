// Built-in tools for skills. Loading is limited to the skills assigned to the calling
// instance. Proposals are recorded for a human to review and change nothing by themselves.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditLedger } from '../audit/ledger.ts';
import type { Json } from '../harness/port.ts';
import type { ToolImplementation } from '../runtime/workforce.ts';

export function skillTools(ledger: AuditLedger, proposalsDir: string): Record<string, ToolImplementation> {
  return {
    'skills.load': async (args, instance): Promise<Json> => {
      const skill = instance.skills.find((s) => s.id === args.id);
      if (!skill) {
        ledger.append('skill.load_denied', `agent:${instance.id}`, { skill: String(args.id) });
        return { error: `Skill ${String(args.id)} is not assigned to you for this task.` };
      }
      ledger.append('skill.loaded', `agent:${instance.id}`, { skill: skill.id, version: skill.version, digest: skill.digest });
      return {
        id: skill.id, version: skill.version, method: skill.body, expectedOutputs: skill.outputs,
        qualityCriteria: skill.qualityCriteria, evidenceRequirements: skill.evidenceRequirements,
      };
    },
    'skills.propose': async (args, instance): Promise<Json> => {
      const record = ledger.append('skill.proposed', `agent:${instance.id}`, {
        skill: String(args.skill_id), title: String(args.title), rationale: String(args.rationale),
      });
      // Written outside the registry. Nothing reads this folder at runtime.
      mkdirSync(proposalsDir, { recursive: true });
      writeFileSync(join(proposalsDir, `proposal-${record.seq}.json`), JSON.stringify({
        ledgerSeq: record.seq, proposedBy: instance.id, onBehalfOf: instance.user, skill: args.skill_id ?? null, title: args.title ?? null,
        rationale: args.rationale, proposedText: args.proposed_text,
      }, null, 2));
      return { recorded: true, note: 'Recorded for review by a registry administrator. It has no effect until a person approves it.' };
    },
  };
}
