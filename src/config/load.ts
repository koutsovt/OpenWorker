// Loads provider and model configuration. Model ids and keys come from the
// environment, so no id or secret is hardcoded in code or committed config.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ProviderSpec } from '../harness/port.ts';

export interface ModelEntry {
  alias: string;
  provider: string;
  /** Environment variable that holds the provider's exact model id. */
  modelEnv: string;
  capabilities: string[];
  /** USD per million tokens. Absent means cost is unknown, not zero. */
  price?: { input: number; output: number };
}

export interface ModelPolicy {
  id: string;
  default: string;
  allowed: string[];
  /** Ordered. Tried only after the default fails with a retryable provider error. */
  fallbacks: string[];
}

export interface PlatformConfig {
  providers: ProviderSpec[];
  models: ModelEntry[];
  policies: ModelPolicy[];
}

export class ConfigError extends Error {}

const APIS = ['responses', 'chat-completions', 'anthropic', 'claude-code'];

export function validateConfig(raw: unknown): PlatformConfig {
  const doc = (raw ?? {}) as Record<string, unknown>;
  const list = (key: string): Record<string, unknown>[] => {
    const v = doc[key];
    if (!Array.isArray(v)) throw new ConfigError(`${key} must be a list`);
    return v as Record<string, unknown>[];
  };
  const str = (o: Record<string, unknown>, key: string, where: string): string => {
    if (typeof o[key] !== 'string' || !o[key]) throw new ConfigError(`${where}: ${key} is required`);
    return o[key] as string;
  };
  const strs = (o: Record<string, unknown>, key: string): string[] =>
    Array.isArray(o[key]) ? (o[key] as unknown[]).map(String) : [];

  const providers = list('providers').map((p): ProviderSpec => {
    const name = str(p, 'name', 'provider');
    const api = str(p, 'api', `provider ${name}`);
    if (!APIS.includes(api)) throw new ConfigError(`provider ${name}: api must be one of ${APIS.join(', ')}`);
    if ('apiKey' in p) throw new ConfigError(`provider ${name}: put the key in an environment variable and name it in apiKeyEnv`);
    return {
      name, api: api as ProviderSpec['api'],
      ...(typeof p.baseUrl === 'string' ? { baseUrl: p.baseUrl } : {}),
      ...(typeof p.apiKeyEnv === 'string' ? { apiKeyEnv: p.apiKeyEnv } : {}),
    };
  });
  const providerNames = new Set(providers.map((p) => p.name));

  const models = list('models').map((m): ModelEntry => {
    const alias = str(m, 'alias', 'model');
    const provider = str(m, 'provider', `model ${alias}`);
    if (!providerNames.has(provider)) throw new ConfigError(`model ${alias}: unknown provider ${provider}`);
    const price = m.price as { input?: unknown; output?: unknown } | undefined;
    if (price && (typeof price.input !== 'number' || typeof price.output !== 'number'))
      throw new ConfigError(`model ${alias}: price needs numeric input and output`);
    return {
      alias, provider, modelEnv: str(m, 'modelEnv', `model ${alias}`), capabilities: strs(m, 'capabilities'),
      ...(price ? { price: { input: price.input as number, output: price.output as number } } : {}),
    };
  });
  const aliases = new Set(models.map((m) => m.alias));
  if (aliases.size !== models.length) throw new ConfigError('model aliases must be unique');

  const policies = list('policies').map((p): ModelPolicy => {
    const id = str(p, 'id', 'policy');
    const policy = { id, default: str(p, 'default', `policy ${id}`), allowed: strs(p, 'allowed'), fallbacks: strs(p, 'fallbacks') };
    for (const alias of [policy.default, ...policy.allowed, ...policy.fallbacks])
      if (!aliases.has(alias)) throw new ConfigError(`policy ${id}: unknown model alias ${alias}`);
    if (!policy.allowed.includes(policy.default)) throw new ConfigError(`policy ${id}: default must be in allowed`);
    return policy;
  });
  return { providers, models, policies };
}

export function loadConfig(dir: string): PlatformConfig {
  const read = (file: string) => parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
  return validateConfig({ ...read('providers.yaml'), ...read('models.yaml') });
}
