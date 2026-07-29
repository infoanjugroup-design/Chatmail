import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function MfaChallenge({ factorId, onVerified }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeErr) throw challengeErr;
      const { error: verifyErr } = await supabase.auth.mfa.verify({
        factorId, challengeId: challenge.id, code: code.trim(),
      });
      if (verifyErr) throw verifyErr;
      onVerified();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-dusk flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-dusk2 rounded-2xl p-8 space-y-4 shadow-xl">
        <h1 className="font-display text-2xl text-paper mb-1">Two-factor check</h1>
        <p className="text-paper/60 text-sm mb-4">Enter the 6-digit code from your authenticator app.</p>
        <input
          className="w-full rounded-xl bg-dusk px-4 py-3 text-paper placeholder-paper/40 outline-none focus:ring-2 focus:ring-coral text-center tracking-[0.5em] text-lg"
          placeholder="000000" value={code} onChange={(e) => setCode(e.target.value)}
          inputMode="numeric" maxLength={6} autoFocus required
        />
        {error && <p className="text-coral text-sm">{error}</p>}
        <button disabled={busy} className="w-full rounded-xl bg-coral text-ink font-semibold py-3 hover:brightness-110 transition">
          {busy ? 'Verifying…' : 'Verify'}
        </button>
        <button type="button" className="text-paper/60 text-sm underline w-full text-center"
          onClick={() => supabase.auth.signOut()}>
          Use a different account
        </button>
      </form>
    </div>
  );
}
