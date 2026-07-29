import { supabase } from './supabaseClient';

// Uploads a Blob to the public "media" bucket and returns its public URL.
// Path convention: <folder>/<userId>/<timestamp>.<ext>
export async function uploadMediaBlob(blob, { userId, folder = 'uploads', ext = 'webm' }) {
  const path = `${folder}/${userId}/${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('media').upload(path, blob, {
    contentType: blob.type || 'application/octet-stream',
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from('media').getPublicUrl(path);
  return data.publicUrl;
}
