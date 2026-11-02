import type { Config } from './config.js';
import { errMsg, log } from './utils.js';

let warned = false;

/** Calls the local Ollama model and parses a JSON reply. Returns null if Ollama is off, down, or the reply is unusable. */
export async function askJson<T>(cfg: Config, system: string, user: string): Promise<T | null> {
  if (!cfg.ollama.enabled) return null;
  try {
    const res = await fetch(`${cfg.ollama.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return JSON.parse(data.message?.content ?? '') as T;
  } catch (e) {
    if (!warned) {
      log(`Ollama unavailable (${errMsg(e)}). Continuing with rules only; unclear questions go to the review queue.`);
      warned = true;
    }
    return null;
  }
}
