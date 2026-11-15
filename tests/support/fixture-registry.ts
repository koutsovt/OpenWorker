// Builds a throwaway registry on disk for tests, and locks whatever is marked approved.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { Registry } from '../../src/registry/registry.ts';

type Fields = Record<string, unknown>;

export const toolFile = (name: string, extra: Fields = {}): Fields => ({
  name, description: `Test tool ${name}.`, owner: 'test', action: 'read', risk: 'low', dataClassification: 'internal',
  limits: { maxCallsPerSession: 5 }, inputSchema: { type: 'object', properties: {}, additionalProperties: true }, ...extra,
});
export const agentFile = (id: string, version: number, extra: Fields = {}): Fields => ({
  id, version, status: 'approved', owner: 'test', purpose: 'Test agent.', instructions: 'Do the task.', allowedTools: [],
  modelPolicy: 'std', eligibleSkills: [], dataClassificationCeiling: 'internal', ...extra,
});
export const skillFile = (id: string, version: string, extra: Fields = {}): Fields => ({
  id, version, status: 'approved', owner: 'test', purpose: `Purpose of ${id}.`, scope: 'Tests.', inputs: [], outputs: [],
  qualityCriteria: [], evidenceRequirements: [], dependencies: [], applicableRoles: [], suggestedTools: [], ...extra,
});

export interface Fixture {
  tools?: Fields[];
  agents?: Fields[];
  skills?: Fields[];
}

export function writeRegistry(fixture: Fixture, lock = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const t of fixture.tools ?? []) writeFileSync(join(dir, 'tools', `${t.name}.yaml`), stringify(t));
  for (const a of fixture.agents ?? []) {
    mkdirSync(join(dir, 'agents', String(a.id)), { recursive: true });
    writeFileSync(join(dir, 'agents', String(a.id), `${a.version}.yaml`), stringify(a));
  }
  for (const s of fixture.skills ?? []) {
    const base = join(dir, 'skills', String(s.id), String(s.version));
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'skill.yaml'), stringify(s));
    writeFileSync(join(base, 'SKILL.md'), `# ${s.id}\n\nMethod text for ${s.id}.\n`);
  }
  if (lock) writeFileSync(join(dir, 'approved.lock.yaml'), stringify(new Registry(dir).approvedDigests()));
  return dir;
}
