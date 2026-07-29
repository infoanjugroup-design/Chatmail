import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import ChatWindow from '../components/ChatWindow.jsx';

export default function ChatsTab({ userId }) {
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('chat_members')
        .select('chat_id, chats(id, title, is_group, chat_members(user_id, profiles(username, avatar_url)))')
        .eq('user_id', userId);
      setChats((data ?? []).map((r) => r.chats).filter(Boolean));
    })();
  }, [userId]);

  const active = chats.find((c) => c.id === activeChatId);

  return (
    <div className="h-full flex">
      <aside className={`w-full sm:w-80 border-r border-dusk2 overflow-y-auto ${activeChatId ? 'hidden sm:block' : ''}`}>
        <h2 className="font-display text-xl text-paper px-4 py-4">Chats</h2>
        {chats.length === 0 && <p className="text-paper/40 text-sm px-4">No chats yet.</p>}
        {chats.map((c) => {
          const other = c.chat_members?.find((m) => m.user_id !== userId)?.profiles;
          const label = c.is_group ? c.title : other?.username ?? 'Chat';
          return (
            <button
              key={c.id}
              onClick={() => setActiveChatId(c.id)}
              className={`w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-dusk2 ${activeChatId === c.id ? 'bg-dusk2' : ''}`}
            >
              <div className="w-10 h-10 rounded-full bg-coral/30 flex items-center justify-center text-paper font-semibold">
                {label?.[0]?.toUpperCase() ?? '?'}
              </div>
              <span className="text-paper">{label}</span>
            </button>
          );
        })}
      </aside>

      <section className={`flex-1 ${activeChatId ? '' : 'hidden sm:flex sm:items-center sm:justify-center'}`}>
        {active ? (
          <ChatWindow chat={active} userId={userId} onBack={() => setActiveChatId(null)} />
        ) : (
          <p className="text-paper/40">Select a chat to start messaging.</p>
        )}
      </section>
    </div>
  );
}
