// Supabase Edge Function: moderate-content
// Deploy: supabase functions deploy moderate-content
// Call this from the client BEFORE inserting a post/comment, or wire it as
// a Postgres webhook trigger on insert for defense-in-depth.
//
// What it does:
//  - Normalizes text, checks against `blocked_terms` table.
//  - severity='block'  -> rejects the content outright (never stored as-is).
//  - severity='flag'   -> allows it through but writes a moderation_queue
//                          row for human review, and is_flagged=true.
//  - If the keyword pass doesn't already reject it, and ANTHROPIC_API_KEY
//    is set, a Claude classification pass runs for context-aware detection
//    (coded language, harassment/threats phrased without any "bad word")
//    and can itself escalate to block/flag. This is the AI step that was
//    previously a marked TODO — see classifyWithAI() below.
//  - If the AI call errors or the key isn't set, moderation falls back to
//    keyword-only (fails open on the AI step, not on moderation overall).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, // server-side only, set as an Edge Function secret
);

const MODERATION_CATEGORIES = ['harassment', 'hate', 'violence', 'sexual', 'self_harm', 'spam'];

function normalize(text: string) {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, '');
}

Deno.serve(async (req) => {
  try {
    const { contentType, contentId, text } = await req.json();
    if (!text || !contentType || !contentId) {
      return new Response(JSON.stringify({ error: 'contentType, contentId, and text are required' }), { status: 400 });
    }

    const { data: terms } = await supabaseAdmin.from('blocked_terms').select('term, severity');
    const normalized = normalize(text);
    const matched = (terms ?? []).filter((t) => normalized.includes(normalize(t.term)));

    const hasBlock = matched.some((m) => m.severity === 'block');
    const hasFlag = matched.length > 0;

    // AI context-aware pass — skipped if the keyword filter already
    // rejected the content (no need to spend an API call), skipped
    // entirely if ANTHROPIC_API_KEY isn't configured, and fails open
    // (falls back to the keyword-only verdict) on any error.
    let aiResult: { decision: 'allow' | 'flag' | 'block'; categories: string[]; reason: string } | null = null;
    if (!hasBlock) {
      aiResult = await classifyWithAI(text).catch((err) => {
        console.error('AI moderation call failed, falling back to keyword-only result:', err);
        return null;
      });
    }

    const allowed = !hasBlock && aiResult?.decision !== 'block';
    const flagged = hasFlag || aiResult?.decision === 'flag' || aiResult?.decision === 'block';

    if (flagged) {
      const reason = hasBlock
        ? 'blocked_term_match'
        : aiResult?.decision === 'block'
        ? `ai_block:${aiResult.reason}`
        : aiResult?.decision === 'flag'
        ? `ai_flag:${aiResult.reason}`
        : 'flagged_term_match';

      await supabaseAdmin.from('moderation_queue').insert({
        content_type: contentType,
        content_id: contentId,
        reason,
        matched_terms: matched.map((m) => m.term),
        status: allowed ? 'pending' : 'rejected',
      });
    }

    return new Response(JSON.stringify({
      allowed,
      flagged,
      matchedTerms: matched.map((m) => m.term),
      // Additive fields — existing callers that only read allowed/flagged/
      // matchedTerms (see src/components/PostCard.jsx) are unaffected.
      categories: aiResult?.categories ?? [],
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

async function classifyWithAI(text: string) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return null; // AI step optional — keyword filter still runs without it

  const prompt = `You are a content moderation classifier for a social app. Classify the message below.
Respond with ONLY a JSON object, no other text, in this exact shape:
{"decision":"allow"|"flag"|"block","categories":string[],"reason":string}

Categories to consider: ${MODERATION_CATEGORIES.join(', ')}.
- "block": clear harassment, hate speech, threats, sexual content involving minors, or explicit calls to violence.
- "flag": borderline or context-dependent content that a human moderator should review.
- "allow": normal content, including strong opinions, criticism, or mild profanity that isn't targeted harassment.

Message:
"""${text.slice(0, 2000)}"""`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
  const data = await res.json();
  const raw = (data.content ?? []).map((b: { text?: string }) => b.text ?? '').join('').trim();
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!['allow', 'flag', 'block'].includes(parsed.decision)) throw new Error('bad AI response shape');
  return parsed;
}
