// Structured output. Engines return free text, so an agent hands its result back
// by calling `result.submit`; the platform validates it in code afterwards.
// The latest submission of an instance wins. Nothing outside the task is changed.
import type { Json } from '../harness/port.ts';
import type { ToolImplementation } from '../runtime/workforce.ts';

export class ResultInbox {
  private readonly submitted = new Map<string, Json>();

  readonly tools: Record<string, ToolImplementation> = {
    'result.submit': async (args, instance): Promise<Json> => {
      const result = args.result;
      if (result === null || typeof result !== 'object' || Array.isArray(result))
        return { error: 'result must be a JSON object. Submit again with an object.' };
      this.submitted.set(instance.id, result);
      return { accepted: true, note: 'Recorded. The platform will validate it. Finish your turn with a one-line confirmation.' };
    },
  };

  /** Removes and returns what the instance submitted, if anything. */
  take(instanceId: string): Json | undefined {
    const result = this.submitted.get(instanceId);
    this.submitted.delete(instanceId);
    return result;
  }
}
