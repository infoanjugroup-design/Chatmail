import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function PostCard({ post, userId }) {
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(post.like_count ?? 0);
  const [showComments, setShowComments] = useState(false);
  const [comments, setComments] = useState(null);
  const [commentBody, setCommentBody] = useState('');
  const [commentError, setCommentError] = useState('');

  async function toggleLike() {
    if (liked) {
      await supabase.from('post_likes').delete().eq('post_id', post.id).eq('user_id', userId);
      setLikeCount((n) => n - 1);
    } else {
      await supabase.from('post_likes').insert({ post_id: post.id, user_id: userId });
      setLikeCount((n) => n + 1);
    }
    setLiked(!liked);
  }

  async function loadComments() {
    setShowComments(true);
    if (comments) return;
    const { data } = await supabase.from('comments').select('*, profiles(username)').eq('post_id', post.id).eq('is_hidden', false).order('created_at');
    setComments(data ?? []);
  }

  async function submitComment(e) {
    e.preventDefault();
    const text = commentBody.trim();
    if (!text) return;
    setCommentError('');

    // Run past the moderation Edge Function first — content that's
    // outright blocked never gets inserted.
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/moderate-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: 'comment', contentId: crypto.randomUUID(), text }),
    }).then((r) => r.json()).catch(() => ({ allowed: true, flagged: false })); // fail-open on network error; tighten if you need fail-closed

    if (!res.allowed) {
      setCommentError("This comment can't be posted — it matched a blocked term.");
      return;
    }

    const { data, error } = await supabase.from('comments')
      .insert({ post_id: post.id, user_id: userId, body: text, is_flagged: res.flagged })
      .select('*, profiles(username)').single();
    if (!error) {
      setComments((prev) => [...(prev ?? []), data]);
      setCommentBody('');
    }
  }

  return (
    <article className="bg-dusk2 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="w-8 h-8 rounded-full bg-coral/30 flex items-center justify-center text-paper text-sm font-semibold">
          {post.profiles?.username?.[0]?.toUpperCase()}
        </div>
        <span className="text-paper text-sm font-medium">{post.profiles?.username}</span>
        {post.quality_weight > 1 && <span className="text-mint text-xs ml-auto">✓ Educational</span>}
      </div>

      {post.media_url && (
        post.media_type === 'video'
          ? <video src={post.media_url} controls className="w-full max-h-[480px] object-cover" />
          : <img src={post.media_url} alt="" className="w-full max-h-[480px] object-cover" />
      )}

      {post.caption && <p className="text-paper/90 text-sm px-4 py-2">{post.caption}</p>}

      <div className="flex items-center gap-4 px-4 py-3 text-sm">
        <button onClick={toggleLike} className={liked ? 'text-coral' : 'text-paper/60'}>
          {liked ? '♥' : '♡'} {likeCount}
        </button>
        <button onClick={loadComments} className="text-paper/60">💬 {post.comment_count ?? 0}</button>
      </div>

      {showComments && (
        <div className="px-4 pb-4 space-y-2 border-t border-dusk/50 pt-3">
          {(comments ?? []).map((c) => (
            <div key={c.id} className="text-sm">
              <span className="text-paper font-medium">{c.profiles?.username}</span>{' '}
              <span className="text-paper/80">{c.body}</span>
            </div>
          ))}
          <form onSubmit={submitComment} className="flex gap-2 pt-1">
            <input
              className="flex-1 rounded-full bg-dusk px-3 py-1.5 text-sm text-paper placeholder-paper/40 outline-none"
              placeholder="Add a comment…" value={commentBody} onChange={(e) => setCommentBody(e.target.value)}
            />
            <button className="text-coral text-sm font-semibold">Post</button>
          </form>
          {commentError && <p className="text-coral text-xs">{commentError}</p>}
        </div>
      )}
    </article>
  );
}
