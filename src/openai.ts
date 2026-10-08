import type { Env } from "./env";

/**
 * OpenAI Responses API, checked against the official OpenAPI
 * (github.com/openai/openai-openapi, operationId createResponse) on 2026-10-08.
 * Only fields present in that schema are sent:
 *   model, instructions, input (string), store (boolean),
 *   text.format = { type:"json_schema", name, strict, schema }.
 * Nothing else (temperature, max_output_tokens, reasoning, ...) is hardcoded.
 */
export interface ModelRequest {
  instructions: string;
  input: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface ModelClient {
  complete(req: ModelRequest): Promise<unknown>;
}

export class ModelConfigError extends Error {}
export class ModelCallError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

const DEFAULT_BASE = "https://api.openai.com/v1";

export function createOpenAIClient(env: Env, fetchImpl: typeof fetch = fetch): ModelClient {
  return {
    async complete(req) {
      if (!env.OPENAI_API_KEY) throw new ModelConfigError("OPENAI_API_KEY is not set");
      if (!env.OPENAI_MODEL) throw new ModelConfigError("OPENAI_MODEL is not set");
      const base = (env.OPENAI_BASE_URL?.trim() || DEFAULT_BASE).replace(/\/$/, "");
      const res = await fetchImpl(`${base}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL,
          instructions: req.instructions,
          input: req.input,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: req.schemaName,
              strict: true,
              schema: req.schema,
            },
          },
        }),
      });
      const bodyText = await res.text();
      if (!res.ok) {
        throw new ModelCallError(`OpenAI HTTP ${res.status}: ${bodyText.slice(0, 300)}`, res.status);
      }
      let parsed: { output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new ModelCallError("OpenAI response was not JSON", res.status);
      }
      const text = (parsed.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (!text) throw new ModelCallError("OpenAI response had no output_text", res.status);
      try {
        return JSON.parse(text);
      } catch {
        throw new ModelCallError("model output_text was not JSON", res.status);
      }
    },
  };
}

export const ROLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["stance", "picks", "uncertainties", "disagreements", "record_labels"],
  properties: {
    stance: { type: "string" },
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["horse_no", "p_win", "p_place", "note"],
        properties: {
          horse_no: { type: "integer" },
          p_win: { type: "number" },
          p_place: { type: "number" },
          note: { type: "string" },
        },
      },
    },
    uncertainties: { type: "array", items: { type: "string" } },
    disagreements: { type: "array", items: { type: "string" } },
    record_labels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "kind", "basis"],
        properties: {
          item: { type: "string" },
          kind: { type: "string", enum: ["historical_record", "new_notice", "unknown"] },
          basis: { type: "string" },
        },
      },
    },
  },
};

export const MODERATOR_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "consensus", "disagreements", "invalid_outputs"],
  properties: {
    summary: { type: "string" },
    consensus: { type: "array", items: { type: "string" } },
    disagreements: { type: "array", items: { type: "string" } },
    invalid_outputs: { type: "array", items: { type: "string" } },
  },
};
