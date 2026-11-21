import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { importX509, jwtVerify, decodeProtectedHeader, type JWTPayload } from 'jose';
import { z } from 'zod';
import { SYSTEM_PROMPT, BRIEF_INSTRUCTION } from './prompt';

export interface Env {
  ANTHROPIC_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ALLOWED_ORIGIN: string;
  // Valgfri: kommasepareret liste af Firebase-UID'er der må bruge Majoren.
  // Tom = alle brugere med gyldigt login i Firebase-projektet.
  ALLOWED_UIDS?: string;
}

const MODEL = 'claude-haiku-5-5';
const MAX_TOKENS = 400;
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY = 10;
const MAX_CONTEXT_CHARS = 30_000;

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const CERTS_TTL_MS = 60 * 60 * 1000; // 1 time

// ---------- CORS ----------

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] ?? '',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors },
  });
}

// ---------- Firebase ID-token ----------

let certCache: { certs: Record<string, string>; fetchedAt: number } | null = null;

async function getCerts(force = false): Promise<Record<string, string>> {
  if (!force && certCache && Date.now() - certCache.fetchedAt < CERTS_TTL_MS) {
    return certCache.certs;
  }
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error(`Kunne ikke hente Google-certifikater: ${res.status}`);
  const certs = (await res.json()) as Record<string, string>;
  certCache = { certs, fetchedAt: Date.now() };
  return certs;
}

async function verifyFirebaseToken(idToken: string, env: Env): Promise<JWTPayload> {
  const { kid, alg } = decodeProtectedHeader(idToken);
  if (alg !== 'RS256' || !kid) throw new Error('Forkert token-header');

  let certs = await getCerts();
  if (!certs[kid]) certs = await getCerts(true); // Google kan have roteret nøglerne
  const pem = certs[kid];
  if (!pem) throw new Error('Ukendt nøgle-id');

  const key = await importX509(pem, 'RS256');
  const { payload } = await jwtVerify(idToken, key, {
    algorithms: ['RS256'],
    audience: env.FIREBASE_PROJECT_ID,
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
  }); // jwtVerify tjekker også exp/iat

  if (!payload.sub) throw new Error('Token mangler sub');
  const authTime = (payload as { auth_time?: number }).auth_time;
  if (typeof authTime === 'number' && authTime * 1000 > Date.now() + 60_000) {
    throw new Error('auth_time ligger i fremtiden');
  }

  const allowedUids = (env.ALLOWED_UIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowedUids.length > 0 && !allowedUids.includes(payload.sub)) {
    throw new Error('UID ikke på listen');
  }
  return payload;
}

// ---------- Anthropic ----------

type HistoryItem = { role: string; content: string };

function buildSystem(context: unknown): string {
  let ctx = JSON.stringify(context ?? {}, null, 1);
  if (ctx.length > MAX_CONTEXT_CHARS) ctx = ctx.slice(0, MAX_CONTEXT_CHARS) + '…';
  return SYSTEM_PROMPT.replace('{context}', ctx);
}

// Gør historikken gyldig for Messages API: kun user/assistant, starter med user,
// ingen to ens roller i træk, og den nye besked til sidst.
function buildMessages(history: HistoryItem[], message: string): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  const recent = Array.isArray(history) ? history.slice(-MAX_HISTORY) : [];
  for (const h of recent) {
    if (!h || typeof h.content !== 'string' || !h.content.trim()) continue;
    const role = h.role === 'user' ? 'user' : h.role === 'assistant' || h.role === 'majoren' ? 'assistant' : null;
    if (!role) continue;
    const content = h.content.slice(0, MAX_MESSAGE_CHARS);
    if (out.length === 0 && role === 'assistant') continue;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content = `${last.content as string}\n\n${content}`;
    } else {
      out.push({ role, content });
    }
  }
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    if ((last.content as string).trim() !== message.trim()) {
      last.content = `${last.content as string}\n\n${message}`;
    }
  } else {
    out.push({ role: 'user', content: message });
  }
  return out;
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

const REFUSAL_REPLY = 'Det ligger uden for min post. Spørg om noget andet.';

async function handleChat(body: any, env: Env): Promise<{ reply: string }> {
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, MAX_MESSAGE_CHARS) : '';
  if (!message) throw new HttpError(400, 'message mangler');

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    system: buildSystem(body.context),
    messages: buildMessages(body.history ?? [], message),
  });
  if (res.stop_reason === 'refusal') return { reply: REFUSAL_REPLY };
  return { reply: textOf(res) || 'Modtaget.' };
}

const BriefSchema = z.object({
  body: z.string(),
  workoutTitle: z.string(),
  workoutDetail: z.string(),
});

async function handleBrief(body: any, env: Env) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'disabled' },
    system: buildSystem(body.context),
    messages: [{ role: 'user', content: BRIEF_INSTRUCTION }],
    output_config: { format: zodOutputFormat(BriefSchema) },
  });
  if (res.stop_reason === 'refusal' || !res.parsed_output) {
    throw new HttpError(502, 'Ingen brief fra modellen');
  }
  const out = res.parsed_output;
  return {
    body: out.body.trim(),
    workout: { title: out.workoutTitle.trim(), detail: out.workoutDetail.trim() },
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ---------- Router ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(env, request);
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST' || (pathname !== '/chat' && pathname !== '/brief')) {
      return json({ error: 'not_found' }, 404, cors);
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'bad_request' }, 400, cors);
    }

    if (typeof body?.idToken !== 'string' || !body.idToken) {
      return json({ error: 'unauthorized' }, 401, cors);
    }
    try {
      await verifyFirebaseToken(body.idToken, env);
    } catch (e) {
      console.log('auth fejl:', (e as Error).message);
      return json({ error: 'unauthorized' }, 401, cors);
    }

    try {
      const result = pathname === '/chat' ? await handleChat(body, env) : await handleBrief(body, env);
      return json(result, 200, cors);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, cors);
      if (e instanceof Anthropic.RateLimitError) {
        console.log('Anthropic rate limit');
        return json({ error: 'rate_limited' }, 429, cors);
      }
      if (e instanceof Anthropic.APIError) {
        console.log('Anthropic fejl:', e.status, e.message);
        return json({ error: 'upstream_error' }, 502, cors);
      }
      console.log('Uventet fejl:', (e as Error).message);
      return json({ error: 'internal_error' }, 500, cors);
    }
  },
};
