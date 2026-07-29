import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  encryptForRecipients, decryptMessage,
  encryptBlobForRecipients, decryptBlobForRecipient,
  loadPrivateKey,
} from '../lib/crypto';
import { uploadMediaBlob } from '../lib/uploadMedia';
import VoiceRecorder from './VoiceRecorder.jsx';

export default function ChatWindow({ chat, userId, onBack }) {
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState('');
  const [typingUsers, setTypingUsers] = useState([]);
  // Public keys for every member of this chat (DM = 2, group = N). Anyone
  // missing a public_key hasn't set up encryption yet in Settings — they're
  // skipped when wrapping, and get a "hasn't set up encryption" placeholder.
  const [memberKeys, setMemberKeys] = useState([]); // [{ id, username, publicKeyJwk|null }]
  const bottomRef = useRef(null);
  const typingTimeout = useRef(null);

  const otherMember = chat.chat_members?.find((m) => m.user_id !== userId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Pull public_key for every member of the chat (works for 1:1 and
      // group alike) — this is what makes group/voice-note encryption
      // possible; previously only the single DM recipient's key was fetched.
      const memberIds = (chat.chat_members ?? []).map((m) => m.user_id);
      const { data: profiles } = await supabase.from('profiles').select('id, username, public_key').in('id', memberIds);
      const keys = (profiles ?? []).map((p) => ({
        id: p.id,
        username: p.username,
        publicKeyJwk: p.public_key ? JSON.parse(p.public_key) : null,
      }));
      if (!cancelled) setMemberKeys(keys);

      const { data } = await supabase
        .from('messages')
        .select('*, message_keys(recipient_id, wrapped_key)')
        .eq('chat_id', chat.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });
      if (!cancelled) setMessages(await Promise.all((data ?? []).map((m) => decryptIfNeeded(m))));
    })();

    const channel = supabase.channel(`chat:${chat.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chat.id}` },
        async (payload) => {
          const decrypted = await decryptIfNeeded(payload.new, /* fetchKeys */ true);
          setMessages((prev) => (prev.some((m) => m.id === decrypted.id) ? prev : [...prev, decrypted]));
        })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'typing_status', filter: `chat_id=eq.${chat.id}` },
        async () => {
          const { data } = await supabase.from('typing_status').select('user_id, is_typing').eq('chat_id', chat.id).eq('is_typing', true);
          setTypingUsers((data ?? []).map((t) => t.user_id).filter((id) => id !== userId));
        })
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [chat.id]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Realtime INSERT payloads don't include the message_keys join, so fetch
  // this row's keys separately when needed.
  async function decryptIfNeeded(msg, fetchKeys = false) {
    let keyRows = msg.message_keys;
    if (fetchKeys) {
      const { data } = await supabase.from('message_keys').select('recipient_id, wrapped_key').eq('message_id', msg.id);
      keyRows = data ?? [];
    }
    const myKeyEntry = keyRows?.find((k) => k.recipient_id === userId);

    if (msg.media_type === 'voice_note' && msg.media_url) {
      return decryptVoiceNote(msg, myKeyEntry);
    }
    if (!msg.ciphertext) return msg; // legacy plaintext rows from before this pass
    if (!myKeyEntry) return { ...msg, plaintext: '🔒 (not sent to this device)' };
    try {
      const myPrivateKeyJwk = await loadPrivateKey(userId);
      if (!myPrivateKeyJwk) return { ...msg, plaintext: '🔒 (set up encryption keys in Settings to read)' };
      const text = await decryptMessage({ ciphertext: msg.ciphertext, iv: msg.iv, wrappedKey: myKeyEntry.wrapped_key }, myPrivateKeyJwk);
      return { ...msg, plaintext: text };
    } catch {
      return { ...msg, plaintext: '⚠️ Could not decrypt' };
    }
  }

  async function decryptVoiceNote(msg, myKeyEntry) {
    if (!myKeyEntry) return { ...msg, plaintext: '🔒 Voice note (not sent to this device)' };
    try {
      const myPrivateKeyJwk = await loadPrivateKey(userId);
      if (!myPrivateKeyJwk) return { ...msg, plaintext: '🔒 Voice note (set up encryption keys in Settings)' };
      const res = await fetch(msg.media_url);
      const ciphertextBuf = await res.arrayBuffer();
      const plainBuf = await decryptBlobForRecipient({ ciphertextBuf, iv: msg.iv, wrappedKey: myKeyEntry.wrapped_key }, myPrivateKeyJwk);
      const objectUrl = URL.createObjectURL(new Blob([plainBuf], { type: 'audio/webm' }));
      return { ...msg, decryptedAudioUrl: objectUrl };
    } catch {
      return { ...msg, plaintext: '⚠️ Could not decrypt voice note' };
    }
  }

  async function sendTyping(isTyping) {
    await supabase.from('typing_status').upsert({ chat_id: chat.id, user_id: userId, is_typing: isTyping, updated_at: new Date().toISOString() });
  }

  function handleInputChange(e) {
    setBody(e.target.value);
    sendTyping(true);
    clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => sendTyping(false), 1500);
  }

  // Recipients = every chat member who has published a public key, sender
  // included (so the sender can decrypt their own message on reload).
  // Works identically for a 2-person DM and an N-person group.
  function encryptableRecipients() {
    return memberKeys.filter((m) => m.publicKeyJwk);
  }

  async function sendMessage(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBody('');
    sendTyping(false);

    const recipients = encryptableRecipients();
    const missing = memberKeys.filter((m) => !m.publicKeyJwk);
    if (recipients.length === 0) {
      alert('No one in this chat has set up encryption keys yet — set yours up in Settings first.');
      setBody(text);
      return;
    }

    const { ciphertext, iv, wrappedKeys } = await encryptForRecipients(text, recipients);
    const { data: msg, error } = await supabase.from('messages')
      .insert({ chat_id: chat.id, sender_id: userId, ciphertext, iv }).select().single();
    if (error || !msg) return;

    await supabase.from('message_keys').insert(
      wrappedKeys.map((w) => ({ message_id: msg.id, recipient_id: w.recipientId, wrapped_key: w.wrappedKey }))
    );
    setMessages((prev) => [...prev, { ...msg, plaintext: text }]);
    if (missing.length > 0) {
      // Non-blocking heads-up — message still sent to everyone who can receive it.
      console.warn(`${missing.length} member(s) without encryption keys won't be able to read this message:`, missing.map((m) => m.username));
    }
  }

  async function sendVoiceNote(blob, durationSeconds) {
    const recipients = encryptableRecipients();
    if (recipients.length === 0) {
      alert('No one in this chat has set up encryption keys yet — set yours up in Settings first.');
      return;
    }
    try {
      const { encryptedBlob, iv, wrappedKeys } = await encryptBlobForRecipients(blob, recipients);
      const mediaUrl = await uploadMediaBlob(encryptedBlob, { userId, folder: 'voice-notes', ext: 'bin' });
      const { data: msg, error } = await supabase.from('messages')
        .insert({
          chat_id: chat.id, sender_id: userId,
          media_url: mediaUrl, media_type: 'voice_note', iv,
          plaintext: `🎤 Voice note (${durationSeconds}s)`, // duration label only — audio itself is encrypted
        }).select().single();
      if (error || !msg) throw error ?? new Error('insert failed');

      await supabase.from('message_keys').insert(
        wrappedKeys.map((w) => ({ message_id: msg.id, recipient_id: w.recipientId, wrapped_key: w.wrappedKey }))
      );
      // Play back our own copy immediately from the original blob rather
      // than round-tripping through storage + decrypt.
      setMessages((prev) => [...prev, { ...msg, decryptedAudioUrl: URL.createObjectURL(blob) }]);
    } catch (err) {
      alert('Could not send voice note: ' + err.message);
    }
  }

  async function togglePin(msg) {
    await supabase.from('messages').update({ is_pinned: !msg.is_pinned }).eq('id', msg.id);
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, is_pinned: !m.is_pinned } : m)));
  }

  const pinned = messages.filter((m) => m.is_pinned);
  const encryptionReady = encryptableRecipients().length > 0;

  return (
    <div className="flex flex-col h-full w-full">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-dusk2">
        <button className="sm:hidden text-paper" onClick={onBack}>←</button>
        <h3 className="text-paper font-semibold">{chat.is_group ? chat.title : otherMember?.profiles?.username}</h3>
        {typingUsers.length > 0 && <span className="text-mint text-xs">typing…</span>}
        <span className="ml-auto text-xs" title="End-to-end encrypted for members who've set up keys">
          {encryptionReady ? '🔒' : '🔓'}
        </span>
      </header>

      {pinned.length > 0 && (
        <div className="px-4 py-2 bg-dusk2/50 text-xs text-gold overflow-x-auto whitespace-nowrap">
          📌 {pinned.map((p) => p.plaintext).join('  ·  ')}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {messages.map((m) => (
          <div key={m.id} className={`max-w-[75%] ${m.sender_id === userId ? 'ml-auto' : ''}`}>
            <div
              onDoubleClick={() => togglePin(m)}
              className={`rounded-bubble px-4 py-2 text-sm ${m.sender_id === userId ? 'bg-coral text-ink' : 'bg-paper text-ink'}`}
              title="Double-click to pin"
            >
              {m.media_type === 'voice_note'
                ? (m.decryptedAudioUrl
                    ? <audio controls src={m.decryptedAudioUrl} className="max-w-[220px] h-9" />
                    : <span>{m.plaintext}</span>)
                : (m.plaintext ?? '')}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={sendMessage} className="flex items-center gap-2 p-3 border-t border-dusk2">
        <VoiceRecorder onSend={sendVoiceNote} />
        <input
          className="flex-1 rounded-full bg-dusk2 px-4 py-2 text-paper placeholder-paper/40 outline-none"
          placeholder="Message" value={body} onChange={handleInputChange}
        />
        <button className="rounded-full bg-coral text-ink px-5 font-semibold">Send</button>
      </form>
    </div>
  );
}
