// The task graph a planner proposes, and the checks it must pass before anything runs.
// A plan is data. It can only name approved agents and skills those agents are eligible
// for; anything else is rejected here, in code, whatever the planner model wrote.
import type { Json } from '../harness/port.ts';
import { RegistryError, type Registry } from '../registry/registry.ts';

export interface PlannedTask {
  id: string;
  /** Id of an approved agent definition. */
  agent: string;
  objective: string;
  skills: string[];
  /** Ids of tasks whose results this task receives. */
  dependsOn: string[];
}

/** Part of the objective that no approved agent or skill fits, as the planner judged it. */
export interface UncoveredNeed {
  need: string;
  reason: string;
}

export interface Plan {
  tasks: PlannedTask[];
  /** What the plan leaves undone because nothing in the catalogue covers it. Shown to the approver and carried into the report. */
  uncovered?: UncoveredNeed[];
}

export class PlanError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Plan rejected: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export const PLAN_LIMITS = { maxTasks: 12, maxObjectiveChars: 4000, maxUncovered: 10, maxUncoveredChars: 500 };
const TASK_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Ids the platform uses for the stages it adds after the planned work. */
export const STAGE = { assurance: 'assurance', reassurance: 'assurance-2', report: 'report', rework: (id: string) => `${id}-rework` };
export const isStageTask = (id: string): boolean => id === STAGE.assurance || id === STAGE.reassurance || id === STAGE.report || id.endsWith('-rework');
export const isAssuranceStage = (id: string): boolean => id === STAGE.assurance || id === STAGE.reassurance;
/** Tasks an assurance finding may name: planned work and its rework, never the review or the report. Exact ids, not prefixes. */
export const isReviewable = (id: string): boolean => !isAssuranceStage(id) && id !== STAGE.report;

const strings = (value: unknown): string[] | undefined =>
  value === undefined || value === null ? [] : Array.isArray(value) && value.every((x) => typeof x === 'string') ? value : undefined;

/** Reads a plan from untyped data. Returns the plan and every shape problem found; unknown fields are ignored. */
export function parsePlan(raw: Json | undefined): { plan: Plan; problems: string[] } {
  const problems: string[] = [];
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.tasks : undefined;
  if (!Array.isArray(list)) return { plan: { tasks: [] }, problems: ['plan must be an object with a `tasks` list'] };
  const uncovered = parseUncovered((raw as Record<string, Json>).uncovered, problems);
  const tasks: PlannedTask[] = [];
  list.forEach((item, i) => {
    const t = (item && typeof item === 'object' && !Array.isArray(item) ? item : {}) as Record<string, unknown>;
    const where = `task ${typeof t.id === 'string' ? t.id : `#${i + 1}`}`;
    const skills = strings(t.skills);
    const dependsOn = strings(t.dependsOn);
    if (typeof t.id !== 'string' || !TASK_ID.test(t.id)) problems.push(`${where}: id must be lower-case letters, digits and hyphens, at most 32 characters`);
    if (typeof t.agent !== 'string' || !t.agent) problems.push(`${where}: agent is required`);
    if (typeof t.objective !== 'string' || !t.objective.trim()) problems.push(`${where}: objective is required`);
    if (!skills) problems.push(`${where}: skills must be a list of skill ids`);
    if (!dependsOn) problems.push(`${where}: dependsOn must be a list of task ids`);
    tasks.push({
      id: String(t.id ?? `#${i + 1}`), agent: String(t.agent ?? ''), objective: String(t.objective ?? '').trim(),
      skills: skills ?? [], dependsOn: [...new Set(dependsOn ?? [])],
    });
  });
  return { plan: uncovered.length ? { tasks, uncovered } : { tasks }, problems };
}

/** `uncovered` is optional: a list of {need, reason}, or of plain strings, which are taken as the need. */
function parseUncovered(raw: Json | undefined, problems: string[]): UncoveredNeed[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push('uncovered must be a list of {"need", "reason"}');
    return [];
  }
  return raw.flatMap((item, i): UncoveredNeed[] => {
    const entry = typeof item === 'string' ? { need: item, reason: '' } : item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const need = typeof entry.need === 'string' ? entry.need.trim() : '';
    if (!need) {
      problems.push(`uncovered #${i + 1}: need is required`);
      return [];
    }
    return [{ need, reason: typeof entry.reason === 'string' ? entry.reason.trim() : '' }];
  });
}

/** Every reason the plan may not run. An empty list means it may. */
export function validatePlan(plan: Plan, registry: Registry, options: { exclude?: string[] } = {}): string[] {
  const problems: string[] = [];
  if (!plan.tasks.length) problems.push('plan has no tasks');
  if (plan.tasks.length > PLAN_LIMITS.maxTasks) problems.push(`plan has ${plan.tasks.length} tasks; the limit is ${PLAN_LIMITS.maxTasks}`);
  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) problems.push(`task ${task.id}: duplicate id`);
    ids.add(task.id);
  }
  for (const task of plan.tasks) {
    const where = `task ${task.id}`;
    if (isStageTask(task.id)) problems.push(`${where}: this id is reserved for the platform's assurance, rework and report stages`);
    if (task.objective.length > PLAN_LIMITS.maxObjectiveChars) problems.push(`${where}: objective is longer than ${PLAN_LIMITS.maxObjectiveChars} characters`);
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) problems.push(`${where}: depends on itself`);
      else if (!ids.has(dependency)) problems.push(`${where}: depends on unknown task ${dependency}`);
    }
    if (options.exclude?.includes(task.agent)) {
      problems.push(`${where}: agent ${task.agent} cannot be assigned work by a plan`);
      continue;
    }
    try {
      registry.resolveSkills(registry.agent(task.agent), task.skills);
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      problems.push(`${where}: ${e.message}`);
    }
  }
  const uncovered = plan.uncovered ?? [];
  if (uncovered.length > PLAN_LIMITS.maxUncovered) problems.push(`plan lists ${uncovered.length} uncovered needs; the limit is ${PLAN_LIMITS.maxUncovered}`);
  uncovered.forEach((u, i) => {
    if (u.need.length + u.reason.length > PLAN_LIMITS.maxUncoveredChars) problems.push(`uncovered #${i + 1}: need and reason together are longer than ${PLAN_LIMITS.maxUncoveredChars} characters`);
  });
  const cycle = findCycle(plan);
  if (cycle) problems.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return problems;
}

function findCycle(plan: Plan): string[] | undefined {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (done.has(id)) return undefined;
    const at = path.indexOf(id);
    if (at >= 0) return [...path.slice(at), id];
    path.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const found = visit(dependency);
      if (found) return found;
    }
    path.pop();
    done.add(id);
    return undefined;
  };
  for (const task of plan.tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return undefined;
}
