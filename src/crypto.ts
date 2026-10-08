const enc = new TextEncoder();

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** hex(HMAC_SHA256(body, secret)) — identical to hkjc-data-worker src/push/pusher.ts */
export async function hmacSha256Hex(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, body));
}

/** Constant-time compare of two hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export type SignatureStatus = "valid" | "invalid" | "missing" | "not_configured";

export async function verifySignature(
  secret: string | undefined,
  rawBody: Uint8Array,
  header: string | null,
): Promise<SignatureStatus> {
  if (!secret) return "not_configured";
  if (!header) return "missing";
  // tolerate an optional "sha256=" prefix
  const provided = header.replace(/^sha256=/i, "");
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(expected, provided) ? "valid" : "invalid";
}

/** Stable JSON with sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}
