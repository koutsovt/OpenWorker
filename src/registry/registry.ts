// Agent, skill and tool registries, loaded from version-controlled files.
// Definitions are data. Only entries that are `approved` AND whose content
// digest matches the approval lock file can be used at runtime.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Json } from '../harness/port.ts';

export type Status = 'draft' | 'approved' | 'retired';
export const CLASSIFICATIONS = ['public', 'internal', 'confidential'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export type Action = 'read' | 'write' | 'execute';

export interface ToolDefinition {
  name: string;
  description: string;
  owner: string;
  action: Action;
  /** `sensitive` tools pause for a human approver on every call. */
  risk: 'low' | 'sensitive';
  dataClassification: Classification;
  limits: { maxCallsPerSession: number };
  inputSchema: Json;
}

export interface SkillDefinition {
  id: string;
  version: string;
  status: Status;
  owner: string;
  purpose: string;
  scope: string;
  inputs: string[];
  outputs: string[];
  qualityCriteria: string[];
  evidenceRequirements: string[];
  dependencies: string[];
  applicableRoles: string[];
  /** Documentation only. A skill never grants a tool. */
  suggestedTools: string[];
  body: string;
  digest: string;
}

export interface AgentDefinition {
  id: string;
  version: number;
  status: Status;
  owner: string;
  purpose: string;
  instructions: string;
  allowedTools: string[];
  modelPolicy: string;
  eligibleSkills: string[];
  dataClassificationCeiling: Classification;
  /** Name of the output contract a task result from this agent must satisfy. */
  outputContract?: string;
  limits?: { maxModelCalls: number; maxOutputTokens: number };
  digest: string;
}

export type RegistryErrorCode =
  | 'invalid' | 'unknown' | 'not_approved' | 'retired' | 'tampered' | 'not_eligible' | 'dependency_cycle';

export class RegistryError extends Error {
  readonly code: RegistryErrorCode;
  constructor(code: RegistryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
/** Digest of everything except `status`, so approving or retiring does not change it. */
const digestOf = (content: Record<string, unknown>, extra = ''): string => {
  const { status: _status, ...rest } = content;
  return createHash('sha256').update(canonical(rest)).update(extra).digest('hex');
};

class Reader {
  private readonly raw: Record<string, unknown>;
  private readonly where: string;
  constructor(raw: unknown, where: string) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RegistryError('invalid', `${where}: expected a mapping`);
    this.raw = raw as Record<string, unknown>;
    this.where = where;
  }
  str(key: string): string {
    const v = this.raw[key];
    if (typeof v !== 'string' || !v.trim()) throw new RegistryError('invalid', `${this.where}: ${key} is required`);
    return v.trim();
  }
  list(key: string): string[] {
    const v = this.raw[key] ?? [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new RegistryError('invalid', `${this.where}: ${key} must be a list of strings`);
    return v as string[];
  }
  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const v = this.str(key);
    if (!allowed.includes(v as T)) throw new RegistryError('invalid', `${this.where}: ${key} must be one of ${allowed.join(', ')}`);
    return v as T;
  }
  get(key: string): unknown {
    return this.raw[key];
  }
  content(): Record<string, unknown> {
    return this.raw;
  }
}

const STATUSES = ['draft', 'approved', 'retired'] as const;
const ID = /^[a-z][a-z0-9-]{0,23}$/;
const yaml = (path: string): unknown => parse(readFileSync(path, 'utf8'));
const dirs = (path: string) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
const files = (path: string, ext: string) => (existsSync(path) ? readdirSync(path).filter((f) => f.endsWith(ext)).sort() : []);

interface Lock {
  agents: Record<string, string>;
  skills: Record<string, string>;
}

export class Registry {
  readonly tools = new Map<string, ToolDefinition>();
  private readonly skills = new Map<string, SkillDefinition[]>();
  private readonly agents = new Map<string, AgentDefinition[]>();
  private readonly lock: Lock;

  constructor(dir: string) {
    const lockPath = join(dir, 'approved.lock.yaml');
    const rawLock = (existsSync(lockPath) ? yaml(lockPath) : {}) as Partial<Lock> | null;
    this.lock = { agents: rawLock?.agents ?? {}, skills: rawLock?.skills ?? {} };

    for (const file of files(join(dir, 'tools'), '.yaml')) {
      const r = new Reader(yaml(join(dir, 'tools', file)), `tool ${file}`);
      const name = r.str('name');
      if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(name)) throw new RegistryError('invalid', `tool ${file}: name must be namespace.tool`);
      const limits = (r.get('limits') ?? {}) as { maxCallsPerSession?: unknown };
      if (!Number.isInteger(limits.maxCallsPerSession) || (limits.maxCallsPerSession as number) < 1)
        throw new RegistryError('invalid', `tool ${name}: limits.maxCallsPerSession must be a positive integer`);
      const inputSchema = r.get('inputSchema') as Json;
      if (!inputSchema || typeof inputSchema !== 'object') throw new RegistryError('invalid', `tool ${name}: inputSchema is required`);
      this.tools.set(name, {
        name, description: r.str('description'), owner: r.str('owner'),
        action: r.oneOf('action', ['read', 'write', 'execute'] as const), risk: r.oneOf('risk', ['low', 'sensitive'] as const),
        dataClassification: r.oneOf('dataClassification', CLASSIFICATIONS),
        limits: { maxCallsPerSession: limits.maxCallsPerSession as number }, inputSchema,
      });
    }

    for (const id of dirs(join(dir, 'skills'))) {
      for (const version of dirs(join(dir, 'skills', id))) {
        const base = join(dir, 'skills', id, version);
        const r = new Reader(yaml(join(base, 'skill.yaml')), `skill ${id}@${version}`);
        if (r.str('id') !== id || r.str('version') !== version) throw new RegistryError('invalid', `skill ${id}@${version}: id and version must match its folder`);
        if (!existsSync(join(base, 'SKILL.md'))) throw new RegistryError('invalid', `skill ${id}@${version}: SKILL.md is missing`);
        const body = readFileSync(join(base, 'SKILL.md'), 'utf8');
        this.skills.set(id, [...(this.skills.get(id) ?? []), {
          id, version, status: r.oneOf('status', STATUSES), owner: r.str('owner'), purpose: r.str('purpose'), scope: r.str('scope'),
          inputs: r.list('inputs'), outputs: r.list('outputs'), qualityCriteria: r.list('qualityCriteria'),
          evidenceRequirements: r.list('evidenceRequirements'), dependencies: r.list('dependencies'),
          applicableRoles: r.list('applicableRoles'), suggestedTools: r.list('suggestedTools'), body,
          digest: digestOf(r.content(), body),
        }]);
      }
    }

    for (const id of dirs(join(dir, 'agents'))) {
      if (!ID.test(id)) throw new RegistryError('invalid', `agent ${id}: id must be lower-case letters, digits and hyphens, at most 24 characters`);
      for (const file of files(join(dir, 'agents', id), '.yaml')) {
        const r = new Reader(yaml(join(dir, 'agents', id, file)), `agent ${id}/${file}`);
        const version = r.get('version');
        if (r.str('id') !== id || !Number.isInteger(version) || `${version}.yaml` !== file)
          throw new RegistryError('invalid', `agent ${id}/${file}: id and integer version must match the path`);
        const allowedTools = r.list('allowedTools');
        for (const tool of allowedTools) if (!this.tools.has(tool)) throw new RegistryError('invalid', `agent ${id}@${version}: unknown tool ${tool}`);
        const limits = r.get('limits') as { maxModelCalls?: unknown; maxOutputTokens?: unknown } | undefined;
        if (limits && (!Number.isInteger(limits.maxModelCalls) || !Number.isInteger(limits.maxOutputTokens)))
          throw new RegistryError('invalid', `agent ${id}@${version}: limits need integer maxModelCalls and maxOutputTokens`);
        const outputContract = r.get('outputContract');
        if (outputContract !== undefined && typeof outputContract !== 'string')
          throw new RegistryError('invalid', `agent ${id}@${version}: outputContract must be a contract name`);
        this.agents.set(id, [...(this.agents.get(id) ?? []), {
          id, version: version as number, status: r.oneOf('status', STATUSES), owner: r.str('owner'), purpose: r.str('purpose'),
          instructions: r.str('instructions'), allowedTools, modelPolicy: r.str('modelPolicy'), eligibleSkills: r.list('eligibleSkills'),
          dataClassificationCeiling: r.oneOf('dataClassificationCeiling', CLASSIFICATIONS),
          ...(outputContract ? { outputContract } : {}),
          ...(limits ? { limits: { maxModelCalls: limits.maxModelCalls as number, maxOutputTokens: limits.maxOutputTokens as number } } : {}),
          digest: digestOf(r.content()),
        }]);
      }
    }
    for (const versions of this.agents.values()) versions.sort((a, b) => a.version - b.version);
    for (const versions of this.skills.values()) versions.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
    // Every skill dependency must exist; cycles are rejected at load time.
    for (const versions of this.skills.values()) for (const skill of versions) this.order([skill.id], false);
  }

  /** The newest approved version of an agent definition. Anything else is refused with a reason. */
  agent(id: string): AgentDefinition {
    return this.usable('agent', id, this.agents.get(id), (a) => `${a.id}@${a.version}`, this.lock.agents);
  }

  skill(id: string): SkillDefinition {
    return this.usable('skill', id, this.skills.get(id), (s) => `${s.id}@${s.version}`, this.lock.skills);
  }

  /** Every agent that can be instantiated right now: approved and matching the lock. */
  usableAgents(): AgentDefinition[] {
    return [...this.agents.keys()].sort().flatMap((id) => {
      try { return [this.agent(id)]; } catch { return []; }
    });
  }

  /** Skills an agent may be given, as a catalogue for planning. */
  eligibleSkills(agent: AgentDefinition): SkillDefinition[] {
    return agent.eligibleSkills.flatMap((id) => {
      try { return [this.skill(id)]; } catch { return []; }
    });
  }

  /** Validates the requested skills against the agent and returns them with dependencies first. */
  resolveSkills(agent: AgentDefinition, requested: string[]): SkillDefinition[] {
    for (const id of requested)
      if (!agent.eligibleSkills.includes(id)) throw new RegistryError('not_eligible', `Skill ${id} is not eligible for agent ${agent.id}`);
    return this.order(requested, true);
  }

  /** Digests of everything currently marked approved, for a registry administrator to write to the lock file. */
  approvedDigests(): Lock {
    const collect = <T extends { status: Status; digest: string }>(all: Map<string, T[]>, key: (x: T) => string) =>
      Object.fromEntries([...all.values()].flat().filter((x) => x.status === 'approved').map((x) => [key(x), x.digest]));
    return { agents: collect(this.agents, (a) => `${a.id}@${a.version}`), skills: collect(this.skills, (s) => `${s.id}@${s.version}`) };
  }

  /** Approved entries whose content no longer matches the lock file. */
  problems(): string[] {
    const { agents, skills } = this.approvedDigests();
    const check = (kind: string, current: Record<string, string>, locked: Record<string, string>) =>
      Object.entries(current).filter(([key, digest]) => locked[key] !== digest)
        .map(([key]) => `${kind} ${key}: ${locked[key] ? 'content differs from the approved digest' : 'marked approved but not in the lock file'}`);
    return [...check('agent', agents, this.lock.agents), ...check('skill', skills, this.lock.skills)];
  }

  private usable<T extends { status: Status; digest: string }>(
    kind: string, id: string, versions: T[] | undefined, key: (x: T) => string, locked: Record<string, string>,
  ): T {
    if (!versions?.length) throw new RegistryError('unknown', `Unknown ${kind} ${id}`);
    const approved = versions.filter((v) => v.status === 'approved').at(-1);
    if (!approved) {
      const retired = versions.every((v) => v.status === 'retired');
      throw new RegistryError(retired ? 'retired' : 'not_approved', `${kind} ${id} has no approved version`);
    }
    if (locked[key(approved)] !== approved.digest)
      throw new RegistryError('tampered', `${kind} ${key(approved)} does not match its approved digest`);
    return approved;
  }

  private order(requested: string[], usableOnly: boolean): SkillDefinition[] {
    const done = new Map<string, SkillDefinition>();
    const visiting = new Set<string>();
    const visit = (id: string, from: string) => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new RegistryError('dependency_cycle', `Skill dependency cycle through ${id}`);
      const versions = this.skills.get(id);
      if (!versions?.length) throw new RegistryError('unknown', `Unknown skill ${id}${from ? ` (required by ${from})` : ''}`);
      const skill = usableOnly ? this.skill(id) : versions.at(-1)!;
      visiting.add(id);
      for (const dependency of skill.dependencies) visit(dependency, id);
      visiting.delete(id);
      done.set(id, skill);
    };
    for (const id of requested) visit(id, '');
    return [...done.values()];
  }
}
