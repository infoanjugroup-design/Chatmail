import { useEffect, useState } from 'react';
import { supabase } from './lib/supabaseClient';
import Auth from './pages/Auth.jsx';
import MfaChallenge from './pages/MfaChallenge.jsx';
import Settings from './pages/Settings.jsx';
import ChatsTab from './pages/ChatsTab.jsx';
import FeedTab from './pages/FeedTab.jsx';

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading, null = logged out
  const [tab, setTab] = useState('chats'); // 'chats' | 'feed' | 'settings'
  // undefined = checking, null = no challenge needed, string = factorId awaiting verification
  const [pendingMfaFactorId, setPendingMfaFactorId] = useState(undefined);
  // undefined = checking, true/false = whether profiles.public_key is set for this user
  const [hasEncryptionKey, setHasEncryptionKey] = useState(undefined);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  // Whenever we get a session, check whether the account has a verified
  // TOTP factor that hasn't been satisfied yet this session (aal1 ->
  // needs aal2). This is what actually enforces MFA at login, on top of
  // the Settings-page enrollment flow.
  useEffect(() => {
    if (!session) { setPendingMfaFactorId(null); return; }
    (async () => {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (data && data.nextLevel === 'aal2' && data.currentLevel !== data.nextLevel) {
        const { data: factors } = await supabase.auth.mfa.listFactors();
        const verified = factors?.totp?.find((f) => f.status === 'verified');
        setPendingMfaFactorId(verified?.id ?? null);
      } else {
        setPendingMfaFactorId(null);
      }
    })();
  }, [session]);

  // New accounts have no encryption keypair until they visit Settings, and
  // without one, sending/reading any message silently fails (ChatWindow
  // just alerts). Surface that up front instead of letting people discover
  // it mid-conversation.
  useEffect(() => {
    if (!session) { setHasEncryptionKey(undefined); return; }
    (async () => {
      const { data } = await supabase.from('profiles').select('public_key').eq('id', session.user.id).single();
      setHasEncryptionKey(!!data?.public_key);
    })();
  }, [session, tab]); // re-check when returning from Settings so the banner clears right away

  if (session === undefined) return <div className="min-h-screen bg-dusk" />;
  if (!session) return <Auth />;
  if (pendingMfaFactorId === undefined) return <div className="min-h-screen bg-dusk" />;
  if (pendingMfaFactorId) {
    return <MfaChallenge factorId={pendingMfaFactorId} onVerified={() => setPendingMfaFactorId(null)} />;
  }

  const showEncryptionBanner = hasEncryptionKey === false && tab !== 'settings' && !bannerDismissed;

  return (
    <div className="min-h-screen bg-dusk flex flex-col">
      {showEncryptionBanner && (
        <div className="flex items-center gap-3 bg-gold/90 text-ink text-sm px-4 py-2">
          <span className="flex-1">🔒 Set up encryption to send and read messages on this device.</span>
          <button onClick={() => setTab('settings')} className="font-semibold underline shrink-0">Set up now</button>
          <button onClick={() => setBannerDismissed(true)} className="shrink-0 text-ink/60">✕</button>
        </div>
      )}

      <main className="flex-1 overflow-hidden">
        {tab === 'chats' && <ChatsTab userId={session.user.id} />}
        {tab === 'feed' && <FeedTab userId={session.user.id} />}
        {tab === 'settings' && <Settings userId={session.user.id} onBack={() => setTab('chats')} />}
      </main>

      <nav className="flex border-t border-dusk2 bg-dusk2/60 backdrop-blur">
        <button
          onClick={() => setTab('chats')}
          className={`flex-1 py-3 text-sm font-medium ${tab === 'chats' ? 'text-coral' : 'text-paper/50'}`}
        >
          💬 Chats
        </button>
        <button
          onClick={() => setTab('feed')}
          className={`flex-1 py-3 text-sm font-medium ${tab === 'feed' ? 'text-coral' : 'text-paper/50'}`}
        >
          ✨ Stories &amp; Feed
        </button>
        <button
          onClick={() => setTab('settings')}
          className={`flex-1 py-3 text-sm font-medium ${tab === 'settings' ? 'text-coral' : 'text-paper/50'}`}
        >
          ⚙️ Settings
        </button>
      </nav>
    </div>
  );
}
