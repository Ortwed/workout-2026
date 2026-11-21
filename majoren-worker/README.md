# majoren-worker

Cloudflare Worker der skjuler Anthropic API-nøglen bag et login-tjek. Træningsappen sender brugerens Firebase ID-token med hvert kald; Worker'en verificerer det og kalder Claude (`claude-haiku-5-5`) med Majorens system prompt.

## Endpoints

| Metode | Sti | Body | Svar |
|---|---|---|---|
| `POST` | `/chat` | `{ idToken, message, history, context }` | `{ reply }` |
| `POST` | `/brief` | `{ idToken, context }` | `{ body, workout: { title, detail } }` |
| `OPTIONS` | `*` | — | `204` + CORS-headers |

Ugyldigt eller manglende token giver `401 { "error": "unauthorized" }`.

`/brief` returnerer udover selve morgenbeskeden (`body`) også dagens træning (`workout`), som appen viser i kortet "På programmet".

## Prerequisites

- Node 18+
- En Cloudflare-konto (gratis plan er nok)
- En Anthropic API-nøgle fra [console.anthropic.com](https://console.anthropic.com)
- Wrangler CLI (installeres lokalt via `npm install`, kør den med `npx wrangler …`)

## Opsætning

```bash
cd majoren-worker
```

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Indsæt nøglen når den spørger. Den gemmes krypteret hos Cloudflare og ligger aldrig i repoet.

### Begræns adgangen til din egen bruger (anbefalet)

Alle med et gyldigt login i Firebase-projektet `coach-ortwed` kan som udgangspunkt kalde Worker'en. Er email/password-oprettelse slået til i Firebase, kan en fremmed i princippet oprette en konto og bruge din API-nøgle. Lås den derfor til din egen UID:

1. Firebase Console → Authentication → Users → kopiér din **User UID**
2. Sæt den i `wrangler.toml`: `ALLOWED_UIDS = "din-uid"` (flere adskilles med komma)
3. Deploy igen

## Lokal test

Opret `.dev.vars` (er i `.gitignore`):

```
ANTHROPIC_API_KEY=sk-ant-...
ALLOWED_ORIGIN=http://localhost:8000,https://ortwed.github.io
```

```bash
npx wrangler dev
```

Worker'en kører nu på `http://localhost:8787`. Hurtigt tjek af at login-kravet virker:

```bash
curl -i -X POST http://localhost:8787/chat -H 'Content-Type: application/json' -d '{"idToken":"forkert","message":"hej"}'
```

Forventet: `401 {"error":"unauthorized"}`.

Vil du teste appen mod den lokale Worker, så sæt `MAJOREN_URL` øverst i appens `<script>` til `http://localhost:8787` og server `index.html` fra `http://localhost:8000` (fx `python3 -m http.server 8000` i repo-roden).

## Deploy

```bash
npx wrangler deploy
```

Wrangler skriver URL'en ud, fx `https://majoren.<dit-subdomæne>.workers.dev`. Sæt den i `MAJOREN_URL` øverst i `<script>` i `index.html`, commit og push.

## Logs

```bash
npx wrangler tail
```

Viser live-logs, også login-fejl (`auth fejl: …`) og fejl fra Anthropic.

## Rotér API-nøglen

1. Opret en ny nøgle i Anthropic Console.
2. Overskriv den gamle secret. Den nye er aktiv med det samme, ingen redeploy nødvendig:
   ```bash
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
3. Tjek at chatten i appen stadig svarer.
4. Slet den gamle nøgle i Anthropic Console.

## Konfiguration

| Navn | Type | Hvor | Betydning |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | secret | `wrangler secret put` | Anthropic API-nøgle |
| `FIREBASE_PROJECT_ID` | var | `wrangler.toml` | `coach-ortwed`: bruges til `aud`/`iss`-tjek |
| `ALLOWED_ORIGIN` | var | `wrangler.toml` | Hvilke origins der får CORS-adgang (komma-separeret) |
| `ALLOWED_UIDS` | var | `wrangler.toml` | Valgfri liste af Firebase-UID'er der må bruge Majoren |

Model, `max_tokens` (400) og grænser for beskedlængde står som konstanter øverst i `src/index.ts`. Majorens system prompt ligger i `src/prompt.ts`.
