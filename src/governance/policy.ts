// Identity, the policy decision function and approver checks.
// Decisions are pure functions of files in version control: no agent can alter them at runtime.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { CLASSIFICATIONS, type Action, type AgentDefinition, type ToolDefinition } from '../registry/registry.ts';

export interface User {
  id: string;
  roles: string[];
}

export interface RolePermissions {
  /** May start agent runs. */
  run?: boolean;
  /** May answer approval requests. */
  approve?: boolean;
  /** Tool action classes that may be performed on this role's behalf. */
  actions?: Action[];
}

export interface PolicyConfig {
  roles: Record<string, RolePermissions>;
}

export type Decision = { allow: true } | { allow: false; code: DenyCode; reason: string };
export type DenyCode =
  | 'UNKNOWN_USER' | 'USER_MAY_NOT_RUN' | 'UNKNOWN_TOOL' | 'TOOL_NOT_IN_DEFINITION' | 'ACTION_NOT_PERMITTED'
  | 'DATA_CLASSIFICATION' | 'UNKNOWN_INSTANCE' | 'NOT_AN_APPROVER';

const deny = (code: DenyCode, reason: string): Decision => ({ allow: false, code, reason });
const rank = (c: string) => CLASSIFICATIONS.indexOf(c as (typeof CLASSIFICATIONS)[number]);

export class Governance {
  private readonly users: Map<string, User>;
  private readonly policy: PolicyConfig;

  constructor(users: User[], policy: PolicyConfig) {
    this.users = new Map(users.map((u) => [u.id, u]));
    this.policy = policy;
  }

  static load(usersPath: string, policyPath: string): Governance {
    const users = (parse(readFileSync(usersPath, 'utf8')) as { users?: User[] }).users ?? [];
    const policy = parse(readFileSync(policyPath, 'utf8')) as PolicyConfig;
    return new Governance(users, { roles: policy.roles ?? {} });
  }

  private permissions(userId: string): RolePermissions[] | undefined {
    return this.users.get(userId)?.roles.map((role) => this.policy.roles[role] ?? {});
  }

  /** May this user start an agent run at all? */
  mayRun(userId: string): Decision {
    const permissions = this.permissions(userId);
    if (!permissions) return deny('UNKNOWN_USER', `Unknown user ${userId}`);
    return permissions.some((p) => p.run) ? { allow: true } : deny('USER_MAY_NOT_RUN', `User ${userId} has no role that may run agents`);
  }

  /** May this person answer an approval request? Agents are never users, so they can never approve. */
  mayApprove(userId: string): Decision {
    const permissions = this.permissions(userId);
    if (!permissions) return deny('UNKNOWN_USER', `Unknown user ${userId}`);
    return permissions.some((p) => p.approve) ? { allow: true } : deny('NOT_AN_APPROVER', `User ${userId} has no approver role`);
  }

  /** May this agent, acting for this user, call this tool? Whether a human must also approve is the tool's risk class. */
  mayCallTool(userId: string, agent: AgentDefinition, tool: ToolDefinition | undefined, toolName: string): Decision {
    const permissions = this.permissions(userId);
    if (!permissions) return deny('UNKNOWN_USER', `Unknown user ${userId}`);
    if (!tool) return deny('UNKNOWN_TOOL', `Tool ${toolName} is not in the tool registry`);
    if (!agent.allowedTools.includes(tool.name)) return deny('TOOL_NOT_IN_DEFINITION', `Agent ${agent.id} is not permitted to use ${tool.name}`);
    if (!permissions.some((p) => p.actions?.includes(tool.action)))
      return deny('ACTION_NOT_PERMITTED', `User ${userId} has no role permitting ${tool.action} actions`);
    if (rank(tool.dataClassification) > rank(agent.dataClassificationCeiling))
      return deny('DATA_CLASSIFICATION', `${tool.name} handles ${tool.dataClassification} data, above agent ${agent.id}'s ceiling of ${agent.dataClassificationCeiling}`);
    return { allow: true };
  }
}
