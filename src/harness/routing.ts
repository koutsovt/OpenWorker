// Presents several engines as one harness, routing by model provider.
// This is how Claude (Claude Code, local subscription) and API-key providers
// (OpenWorker) serve the same platform at once.
import {
  HarnessError,
  type AgentHarness, type AgentSession, type AgentSpec, type HarnessSetup, type ModelRef, type ProviderSpec,
} from './port.ts';

export interface Route {
  harness: AgentHarness;
  /** Which providers this engine serves. */
  serves(provider: ProviderSpec): boolean;
}

export class RoutingHarness implements AgentHarness {
  private readonly routes: Route[];
  private readonly byProvider = new Map<string, AgentHarness>();
  private readonly byAgent = new Map<string, AgentHarness>();

  constructor(routes: Route[]) {
    this.routes = routes;
  }

  async start(setup: HarnessSetup): Promise<void> {
    for (const route of this.routes) {
      const providers = setup.providers.filter((p) => route.serves(p));
      for (const p of providers) {
        if (this.byProvider.has(p.name)) throw new HarnessError('unknown_provider', `Provider ${p.name} matches more than one engine`);
        this.byProvider.set(p.name, route.harness);
      }
      await route.harness.start({ ...setup, providers });
    }
    const orphan = setup.providers.find((p) => !this.byProvider.has(p.name));
    if (orphan) throw new HarnessError('unknown_provider', `No engine serves provider ${orphan.name}`);
  }

  async defineAgent(spec: AgentSpec): Promise<void> {
    const harness = this.engineFor(spec.model.provider);
    await harness.defineAgent(spec);
    this.byAgent.set(spec.name, harness);
  }

  async startSession(agent: string, options: { model?: ModelRef } = {}): Promise<AgentSession> {
    const harness = this.agentEngine(agent);
    // An agent is bound to its engine; switching engines means a different definition.
    if (options.model && this.engineFor(options.model.provider) !== harness)
      throw new HarnessError('unknown_provider', `Provider ${options.model.provider} is served by a different engine than agent ${agent}`);
    return harness.startSession(agent, options);
  }

  resumeSession(agent: string, reference: string): Promise<AgentSession> {
    return this.agentEngine(agent).resumeSession(agent, reference);
  }

  async shutdown(): Promise<void> {
    for (const route of this.routes) await route.harness.shutdown();
  }

  private engineFor(provider: string): AgentHarness {
    const harness = this.byProvider.get(provider);
    if (!harness) throw new HarnessError('unknown_provider', `Provider ${provider} is not registered`);
    return harness;
  }

  private agentEngine(agent: string): AgentHarness {
    const harness = this.byAgent.get(agent);
    if (!harness) throw new HarnessError('unknown_agent', `Unknown agent ${agent}`);
    return harness;
  }
}
