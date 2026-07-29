# Chatmail — Phase 1

A WhatsApp + Instagram hybrid: realtime chat (`Chats` tab) and a
stories/feed (`Stories & Feed` tab), on React (Vite) + Tailwind +
Supabase, deployable to Netlify.

## What's fully working in this pass

- Auth (Supabase email/password), profile auto-creation on signup
- Realtime 1:1 + group chat: messages, typing indicator, pinned "memory
  capsule" messages (double-click a bubble to pin)
- Client-side envelope encryption for 1:1 DMs, group chats, and voice
  notes alike (Web Crypto API — AES-GCM body, RSA-OAEP key wrapped per
  chat member; see `src/lib/crypto.js` and the "Also now implemented"
  section below)
- 24h stories bar with a VibeSync mood-ring accent
- Feed with likes, nested comments, and a `quality_weight`-based
  "Truth & Morals First" ranking (`posts_ranked` view / `feed_rank_score()`)
- Voice notes: record via the mic button (MediaRecorder API), encrypted
  client-side before upload to Supabase Storage, plays back inline as an
  `<audio>` bubble
- Moderation Edge Function (`moderate-content`), wired into the comment
  box: keyword pre-filter + AI context-aware pass; blocks or
  flags-for-review
- Full RLS policy set — every table locked to the right owner/members
- `netlify.toml` with SPA redirects + CSP/HSTS/security headers

## Also now implemented (this pass)

- **Full MFA UI** — Settings tab wires up Supabase Auth's TOTP
  enrollment end to end: QR/secret display, verify-to-enable, and an
  `MfaChallenge` screen that gates login behind a 6-digit code for any
  account with a verified factor (aal1 → aal2). Flips
  `profiles.mfa_enabled` on enroll/unenroll. **Honest scope**: this is a
  UI-level gate — `schema.sql`'s RLS policies don't check
  `auth.jwt()->>'aal'`, so it stops a user from reaching the app screen
  without the code, but doesn't (yet) block direct API calls made with a
  still-valid aal1 token. Add an `and auth.jwt()->>'aal' = 'aal2'` check
  to sensitive policies if you need that enforced server-side too.
- **E2E encryption key setup** — the "generate keypair on first login"
  step flagged below as unwired now lives in Settings → "Set up
  encryption" (calls `generateKeypair()` → `savePrivateKey()` → writes
  `profiles.public_key`). Required before a user can send/receive
  anything encrypted. `App.jsx` checks this on every session and shows a
  dismissible banner nudging the user to Settings if it's missing, so
  it's not a silent first-message failure anymore.
- **Group-chat and voice-note encryption** — DMs and groups now share
  one code path (`encryptForRecipients` / `encryptBlobForRecipients` in
  `src/lib/crypto.js`): the AES data key is wrapped once per chat
  member via `message_keys`, same as before but N-wide instead of 1.
  Voice notes are AES-GCM-encrypted client-side *before* upload, so
  Supabase Storage only ever holds ciphertext bytes; playback decrypts
  in-browser via `decryptBlobForRecipient`. Members who haven't run
  "Set up encryption" yet are skipped when wrapping and shown a
  🔒 placeholder instead of content.
- **AI-assisted moderation** — `moderate-content` now layers a Claude
  classification pass on top of the keyword pre-filter for
  context-aware harassment/hate/threat detection, not just exact-term
  matching. Fails open (keyword stage still applies) if the AI call
  errors or `ANTHROPIC_API_KEY` isn't set. New secret required:
  ```bash
  supabase secrets set ANTHROPIC_API_KEY=<your anthropic api key>
  ```

## What's intentionally stubbed / next-phase

- **Live translation** — not built yet, no schema support either.
- **"Zero vulnerabilities" / legal certification** — no one can honestly
  promise either. What's here is solid baseline practice: RLS on every
  table, envelope encryption end-to-end (DMs, groups, and voice notes),
  sanitized inputs, strict CSP, service-role key kept server-side only.
  Get a real security review before handling sensitive user data at scale.

## 1. Supabase setup

1. Create a project at https://supabase.com.
2. SQL Editor → paste all of `supabase/schema.sql` → Run.
3. Deploy the moderation function:
   ```bash
   supabase functions deploy moderate-content
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your service role key>
   supabase secrets set ANTHROPIC_API_KEY=<your anthropic api key>   # optional — AI pass is skipped (keyword-only) if unset
   ```
4. Project Settings → API → copy the **Project URL** and **anon/publishable
   key** (safe for the client — RLS protects the data).

## 2. Environment variables

```bash
cp .env.example .env
```
Fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

## 3. Run locally

```bash
npm install
npm run dev        # http://localhost:5173
```

## 4. Deploy to Netlify

1. Push to a GitHub repo, Netlify → Add new site → Import from Git.
2. Site configuration → Environment variables → add `VITE_SUPABASE_URL`
   and `VITE_SUPABASE_ANON_KEY`.
3. Deploy — `netlify.toml` already has the build command, SPA redirect,
   and security headers configured.

## 5. First-time encryption key setup (per user, client-side)

Each user needs to generate their device keypair before they can send or
read encrypted messages. In the app: **Settings → Encryption keys → Set
up encryption**. Under the hood this calls `generateKeypair()` from
`src/lib/crypto.js`, saves the private key locally with
`savePrivateKey(userId, privateKeyJwk)`, and writes the public key to
`profiles.public_key`. Chat members who haven't done this yet are shown
as 🔒 placeholders instead of content until they do.

## 6. Enabling two-factor authentication (optional, per user)

**Settings → Two-factor authentication → Enable**, scan the QR code with
an authenticator app, enter the 6-digit code to verify. From then on,
login requires that code (`src/pages/MfaChallenge.jsx` gates the app
behind it via Supabase Auth's aal1→aal2 flow).
