import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// Strip anything that isn't a safe username character before it ever
// reaches Postgres — defense-in-depth alongside RLS + parameterized queries
// (supabase-js always parameterizes, so this is belt-and-suspenders, not
// the only thing standing between us and SQL injection).
function sanitizeUsername(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 24);
}

export default function Auth() {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'signup') {
        const cleanUsername = sanitizeUsername(username);
        if (cleanUsername.length < 3) throw new Error('Username must be at least 3 characters (letters, numbers, _ .)');
        const { error } = await supabase.auth.signUp({
          email, password,
          options: { data: { username: cleanUsername } },
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-dusk flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-dusk2 rounded-2xl p-8 space-y-4 shadow-xl">
        <h1 className="font-display text-3xl text-paper mb-1">Chatmail</h1>
        <p className="text-paper/60 text-sm mb-4">Chats, stories, and feed — one place.</p>

        {mode === 'signup' && (
          <input
            className="w-full rounded-xl bg-dusk px-4 py-3 text-paper placeholder-paper/40 outline-none focus:ring-2 focus:ring-coral"
            placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required
          />
        )}
        <input
          type="email" required className="w-full rounded-xl bg-dusk px-4 py-3 text-paper placeholder-paper/40 outline-none focus:ring-2 focus:ring-coral"
          placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" required minLength={8} className="w-full rounded-xl bg-dusk px-4 py-3 text-paper placeholder-paper/40 outline-none focus:ring-2 focus:ring-coral"
          placeholder="Password (min 8 characters)" value={password} onChange={(e) => setPassword(e.target.value)}
        />

        {error && <p className="text-coral text-sm">{error}</p>}

        <button disabled={busy} className="w-full rounded-xl bg-coral text-ink font-semibold py-3 hover:brightness-110 transition">
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
        </button>

        <button type="button" className="text-paper/60 text-sm underline w-full text-center"
          onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
          {mode === 'signup' ? 'Already have an account? Log in' : "New here? Create an account"}
        </button>
      </form>
    </div>
  );
}
