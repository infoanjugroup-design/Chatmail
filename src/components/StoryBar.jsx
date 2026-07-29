import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function StoryBar({ userId }) {
  const [groups, setGroups] = useState([]); // [{ user, stories: [...] }]

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('stories')
        .select('*, profiles(username, avatar_url, mood_media_url, mood_expires_at)')
        .order('created_at', { ascending: false });

      const byUser = new Map();
      for (const s of data ?? []) {
        const key = s.user_id;
        if (!byUser.has(key)) byUser.set(key, { user: s.profiles, userId: key, stories: [] });
        byUser.get(key).stories.push(s);
      }
      setGroups([...byUser.values()]);
    })();
  }, []);

  return (
    <div className="flex gap-4 overflow-x-auto px-4 py-4">
      {groups.map((g) => (
        <button key={g.userId} className="flex flex-col items-center gap-1 shrink-0">
          {/* VibeSync mood ring: gold ring = active mood media, coral = plain story */}
          <div className={`w-16 h-16 rounded-full p-[3px] ${g.user?.mood_media_url ? 'bg-gradient-to-tr from-gold to-coral' : 'bg-coral'}`}>
            <div className="w-full h-full rounded-full bg-dusk2 flex items-center justify-center text-paper font-semibold overflow-hidden">
              {g.user?.avatar_url
                ? <img src={g.user.avatar_url} alt="" className="w-full h-full object-cover rounded-full" />
                : g.user?.username?.[0]?.toUpperCase()}
            </div>
          </div>
          <span className="text-xs text-paper/70 max-w-[64px] truncate">{g.user?.username}</span>
        </button>
      ))}
    </div>
  );
}
