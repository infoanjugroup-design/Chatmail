import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import StoryBar from '../components/StoryBar.jsx';
import PostCard from '../components/PostCard.jsx';

export default function FeedTab({ userId }) {
  const [posts, setPosts] = useState([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('posts_ranked').select('*, profiles(username, avatar_url)').limit(50);
      setPosts(data ?? []);
    })();
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <StoryBar userId={userId} />
      <div className="max-w-lg mx-auto px-3 space-y-4 pb-6">
        {posts.length === 0 && <p className="text-paper/40 text-center py-10">No posts yet — be the first to share something.</p>}
        {posts.map((p) => <PostCard key={p.id} post={p} userId={userId} />)}
      </div>
    </div>
  );
}
