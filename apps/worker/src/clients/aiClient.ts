import axios, { AxiosError } from "axios";
import { env } from "../config/env";
import { scoped } from "../lib/logger";

const log = scoped("ai-client");

const http = axios.create({
  baseURL: env.AI_SERVICE_URL,
  timeout: 120_000,
});

function summarize(value: unknown, max = 240): string {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    return s.length > max ? s.slice(0, max) + `… (${s.length}ch)` : s;
  } catch {
    return String(value);
  }
}

// Retry transport errors + 5xx from the agent service. Do NOT retry 4xx —
// those are schema / input bugs and retrying just wastes tokens.
function isRetryable(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const ax = err as AxiosError;
  if (!ax.response) return true; // network / timeout
  const s = ax.response.status;
  return s >= 500 && s < 600;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type RunAgentCtx = {
  runId?: string;
  retries?: number; // total attempts = retries + 1
  backoffMs?: number; // base for exponential backoff
};

export async function runAgent<TInput extends object, TOutput>(
  agentName: string,
  input: TInput,
  ctx?: RunAgentCtx
): Promise<TOutput> {
  const runLog = ctx?.runId
    ? log.child({ runId: ctx.runId, agent: agentName })
    : log.child({ agent: agentName });
  const retries = ctx?.retries ?? 2;
  const backoffMs = ctx?.backoffMs ?? 750;

  const started = Date.now();
  runLog.info({ input: summarize(input), retries }, `calling agent ${agentName}`);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await http.post(`/agents/${agentName}/run`, input, {
        headers: ctx?.runId
          ? { "x-request-id": ctx.runId.slice(0, 12) }
          : undefined,
      });
      const durationMs = Date.now() - started;
      if (attempt > 0) {
        runLog.info(
          { attempt, durationMs },
          `agent ${agentName} ok after retry`
        );
      } else {
        runLog.info({ durationMs, output: summarize(data) }, `agent ${agentName} ok`);
      }
      return data as TOutput;
    } catch (err) {
      lastErr = err;
      const finalAttempt = attempt === retries;
      if (!isRetryable(err) || finalAttempt) {
        const durationMs = Date.now() - started;
        if (axios.isAxiosError(err)) {
          runLog.error(
            {
              durationMs,
              attempt,
              status: err.response?.status,
              data: err.response?.data,
            },
            `agent ${agentName} http error (giving up)`
          );
        } else {
          runLog.error({ durationMs, attempt, err }, `agent ${agentName} error (giving up)`);
        }
        throw err;
      }
      const delay = backoffMs * Math.pow(2, attempt);
      runLog.warn(
        {
          attempt,
          nextDelayMs: delay,
          status: axios.isAxiosError(err) ? err.response?.status : undefined,
        },
        `agent ${agentName} transient error — retrying`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}
