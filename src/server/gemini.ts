/** Minimal Gemini REST client for schema-constrained JSON output. No tools are ever given to the model. */

export class GeminiError extends Error {
  constructor(message: string, readonly status: number, readonly kind: 'quota' | 'unavailable' | 'config' | 'bad_output') {
    super(message);
  }
}

export interface GeminiJson<T> {
  data: T;
  modelVersion: string;
}

/** Models tried in order; the next one is used when a model is overloaded, rate limited, or times out. */
const DEFAULT_MODELS = 'gemini-3.6-flash,gemini-3.5-flash-lite';

interface JsonRequest {
  system: string;
  user: string;
  schema: object;
  timeoutMs?: number;
}

export async function generateJson<T>(opts: JsonRequest): Promise<GeminiJson<T>> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError('GEMINI_API_KEY is not set', 0, 'config');
  const models = (process.env.GEMINI_MODEL ?? DEFAULT_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
  let last: GeminiError | null = null;
  for (const model of models) {
    try {
      return await callModel<T>(key, model, opts);
    } catch (err) {
      if (!(err instanceof GeminiError) || (err.kind !== 'unavailable' && err.kind !== 'quota')) throw err;
      last = err;
    }
  }
  throw last ?? new GeminiError('No Gemini model configured', 0, 'config');
}

async function callModel<T>(key: string, model: string, opts: JsonRequest): Promise<GeminiJson<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: 'user', parts: [{ text: opts.user }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseJsonSchema: opts.schema,
        },
      }),
    });
  } catch (err) {
    throw new GeminiError(ctrl.signal.aborted ? 'Gemini timed out' : 'Gemini could not be reached', 0, 'unavailable');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) throw new GeminiError('Gemini quota exhausted', 429, 'quota');
  if (!res.ok) throw new GeminiError(`Gemini returned HTTP ${res.status}`, res.status, res.status >= 500 ? 'unavailable' : 'config');
  const body = (await res.json()) as {
    modelVersion?: string;
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  };
  const text = body.candidates?.[0]?.content?.parts?.filter((p) => !p.thought && p.text).map((p) => p.text).join('') ?? '';
  try {
    return { data: JSON.parse(text) as T, modelVersion: body.modelVersion ?? model };
  } catch {
    throw new GeminiError(`Gemini returned no usable JSON (${body.candidates?.[0]?.finishReason ?? 'no candidate'})`, 200, 'bad_output');
  }
}
