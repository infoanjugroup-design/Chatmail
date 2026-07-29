import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { generateKeypair, savePrivateKey, loadPrivateKey } from '../lib/crypto';

// Wires up Supabase Auth's built-in TOTP MFA enrollment flow against the
// schema-ready profiles.mfa_enabled flag (see README §"next-phase" and
// schema.sql). Flow: enroll -> show QR + secret -> user scans with an
// authenticator app -> challenge -> verify 6-digit code -> factor becomes
// 'verified' and the session is elevated to aal2.
export default function Settings({ userId, onBack }) {
  const [factors, setFactors] = useState([]);
  const [enrolling, setEnrolling] = useState(null); // { factorId, qrCode, secret }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hasEncryptionKey, setHasEncryptionKey] = useState(null); // null = checking

  useEffect(() => { refreshFactors(); checkEncryptionKey(); }, []);

  async function refreshFactors() {
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors(data?.totp ?? []);
  }

  async function checkEncryptionKey() {
    const key = await loadPrivateKey(userId);
    setHasEncryptionKey(!!key);
  }

  // --- MFA enrollment ---
  async function startEnroll() {
    setError(''); setBusy(true);
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw error;
      setEnrolling({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyEnroll(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: enrolling.factorId });
      if (challengeErr) throw challengeErr;
      const { error: verifyErr } = await supabase.auth.mfa.verify({
        factorId: enrolling.factorId, challengeId: challenge.id, code: code.trim(),
      });
      if (verifyErr) throw verifyErr;

      await supabase.from('profiles').update({ mfa_enabled: true }).eq('id', userId);
      setEnrolling(null);
      setCode('');
      setNotice('Two-factor authentication is now enabled.');
      refreshFactors();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelEnroll() {
    if (enrolling) await supabase.auth.mfa.unenroll({ factorId: enrolling.factorId }).catch(() => {});
    setEnrolling(null);
    setCode('');
  }

  async function removeFactor(factorId) {
    setError(''); setBusy(true);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId });
      if (error) throw error;
      const remaining = factors.filter((f) => f.id !== factorId);
      if (remaining.length === 0) await supabase.from('profiles').update({ mfa_enabled: false }).eq('id', userId);
      setNotice('Two-factor authentication disabled.');
      refreshFactors();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // --- E2E encryption keypair setup (README §5 — not wired into Auth yet) ---
  async function setUpEncryption() {
    setError(''); setBusy(true);
    try {
      const { publicKeyJwk, privateKeyJwk } = await generateKeypair();
      await savePrivateKey(userId, privateKeyJwk);
      const { error } = await supabase.from('profiles').update({ public_key: JSON.stringify(publicKeyJwk) }).eq('id', userId);
      if (error) throw error;
      setHasEncryptionKey(true);
      setNotice('Encryption keys generated — your chats can now be end-to-end encrypted on this device.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-4 max-w-lg mx-auto w-full">
      <div className="flex items-center gap-3 mb-6">
        <button className="text-paper" onClick={onBack}>←</button>
        <h2 className="font-display text-xl text-paper">Settings</h2>
      </div>

      {notice && <p className="text-mint text-sm mb-4">{notice}</p>}
      {error && <p className="text-coral text-sm mb-4">{error}</p>}

      {/* Encryption keys */}
      <section className="bg-dusk2 rounded-2xl p-5 mb-4">
        <h3 className="text-paper font-semibold mb-1">Encryption keys</h3>
        <p className="text-paper/60 text-sm mb-3">
          Generates the device keypair used to end-to-end encrypt your chats and voice notes. Your private key stays on this device.
        </p>
        {hasEncryptionKey === null ? (
          <p className="text-paper/40 text-sm">Checking…</p>
        ) : hasEncryptionKey ? (
          <p className="text-mint text-sm">🔒 Encryption is set up on this device.</p>
        ) : (
          <button disabled={busy} onClick={setUpEncryption} className="rounded-xl bg-coral text-ink font-semibold px-4 py-2">
            {busy ? 'Generating…' : 'Set up encryption'}
          </button>
        )}
      </section>

      {/* MFA */}
      <section className="bg-dusk2 rounded-2xl p-5">
        <h3 className="text-paper font-semibold mb-1">Two-factor authentication</h3>
        <p className="text-paper/60 text-sm mb-3">Require a code from an authenticator app when signing in.</p>

        {factors.length > 0 && !enrolling && (
          <ul className="space-y-2 mb-3">
            {factors.map((f) => (
              <li key={f.id} className="flex items-center justify-between bg-dusk rounded-xl px-3 py-2">
                <span className="text-paper text-sm">Authenticator app · {f.status}</span>
                <button disabled={busy} onClick={() => removeFactor(f.id)} className="text-coral text-sm">Remove</button>
              </li>
            ))}
          </ul>
        )}

        {!enrolling ? (
          factors.length === 0 && (
            <button disabled={busy} onClick={startEnroll} className="rounded-xl bg-coral text-ink font-semibold px-4 py-2">
              {busy ? 'Starting…' : 'Enable two-factor authentication'}
            </button>
          )
        ) : (
          <form onSubmit={verifyEnroll} className="space-y-3">
            <p className="text-paper/70 text-sm">Scan this QR code with your authenticator app (Google Authenticator, 1Password, etc):</p>
            {/* Supabase returns a ready-to-render SVG data URI for the QR code */}
            <img src={enrolling.qrCode} alt="MFA QR code" className="w-40 h-40 bg-paper rounded-xl p-2" />
            <p className="text-paper/40 text-xs break-all">Or enter this secret manually: {enrolling.secret}</p>
            <input
              className="w-full rounded-xl bg-dusk px-4 py-2 text-paper placeholder-paper/40 outline-none focus:ring-2 focus:ring-coral"
              placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)}
              inputMode="numeric" maxLength={6} required
            />
            <div className="flex gap-2">
              <button disabled={busy} className="rounded-xl bg-coral text-ink font-semibold px-4 py-2">
                {busy ? 'Verifying…' : 'Verify & enable'}
              </button>
              <button type="button" onClick={cancelEnroll} className="text-paper/60 text-sm px-2">Cancel</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
