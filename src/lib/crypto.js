// Client-side envelope encryption helpers (Web Crypto API).
//
// Model: each user generates an RSA-OAEP keypair once on first login; the
// PRIVATE key never leaves the browser (kept in IndexedDB), the PUBLIC key
// is published to profiles.public_key. To send a DM:
//   1. Generate a fresh random AES-GCM key ("data key") for this message.
//   2. Encrypt the message body with the data key -> ciphertext + iv.
//   3. Wrap (encrypt) the data key itself with the recipient's RSA public
//      key, so only their private key can unwrap it.
//   4. Store {ciphertext, iv, wrappedKey} — the server/DB only ever sees
//      ciphertext, never plaintext or an unwrapped key.
//
// This is a genuine building block, not a full Signal-protocol
// implementation (no forward secrecy / ratcheting yet) — good enough for
// "the server operator can't read your DMs by querying the DB", not yet
// audited for nation-state-level threat models.

const RSA_PARAMS = { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-256' };

export async function generateKeypair() {
  const keyPair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return { publicKeyJwk, privateKeyJwk };
}

export async function importPublicKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, RSA_PARAMS, true, ['encrypt']);
}
export async function importPrivateKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, RSA_PARAMS, true, ['decrypt']);
}

function toB64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function fromB64(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }

export async function encryptMessage(plaintext, recipientPublicKeyJwk) {
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, dataKey, new TextEncoder().encode(plaintext)
  );

  const recipientPublicKey = await importPublicKey(recipientPublicKeyJwk);
  const rawDataKey = await crypto.subtle.exportKey('raw', dataKey);
  const wrappedKeyBuf = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, recipientPublicKey, rawDataKey);

  return {
    ciphertext: toB64(ciphertextBuf),
    iv: toB64(iv),
    wrappedKey: toB64(wrappedKeyBuf),
  };
}

export async function decryptMessage({ ciphertext, iv, wrappedKey }, myPrivateKeyJwk) {
  const myPrivateKey = await importPrivateKey(myPrivateKeyJwk);
  const rawDataKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, myPrivateKey, fromB64(wrappedKey));
  const dataKey = await crypto.subtle.importKey('raw', rawDataKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, dataKey, fromB64(ciphertext));
  return new TextDecoder().decode(plaintextBuf);
}

// ---------------------------------------------------------------------
// N-RECIPIENT ENVELOPE ENCRYPTION (group chats)
//
// Same scheme as encryptMessage/decryptMessage above, except the single
// random AES data key is wrapped once per member of the chat instead of
// once for a single DM recipient. This is the "wrap the data key once per
// member" extension the README flags as a straightforward reuse of the
// existing AES-GCM step — same message_keys table, just N rows instead
// of 1. Works for a 2-person DM too (N=2, including the sender), so
// callers can use this single path for both DMs and groups.
//
// `recipients` = [{ id, publicKeyJwk }, ...] — include the sender's own
// id/key so they can decrypt their own sent messages after a reload.
// ---------------------------------------------------------------------
export async function encryptForRecipients(plaintext, recipients) {
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, dataKey, new TextEncoder().encode(plaintext)
  );
  const rawDataKey = await crypto.subtle.exportKey('raw', dataKey);
  const wrappedKeys = await wrapDataKeyForRecipients(rawDataKey, recipients);

  return { ciphertext: toB64(ciphertextBuf), iv: toB64(iv), wrappedKeys };
}

// Binary variant of the above for voice notes / any Blob media. Encrypts
// the raw bytes with AES-GCM before upload, so Supabase Storage (and
// anyone with the public bucket URL) only ever sees ciphertext bytes —
// the wrapped per-recipient keys (in message_keys, RLS-protected) are
// what actually gates who can decrypt it.
export async function encryptBlobForRecipients(blob, recipients) {
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plainBuf = await blob.arrayBuffer();
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, plainBuf);
  const rawDataKey = await crypto.subtle.exportKey('raw', dataKey);
  const wrappedKeys = await wrapDataKeyForRecipients(rawDataKey, recipients);

  return {
    encryptedBlob: new Blob([cipherBuf], { type: 'application/octet-stream' }),
    iv: toB64(iv),
    wrappedKeys,
  };
}

export async function decryptBlobForRecipient({ ciphertextBuf, iv, wrappedKey }, myPrivateKeyJwk) {
  const myPrivateKey = await importPrivateKey(myPrivateKeyJwk);
  const rawDataKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, myPrivateKey, fromB64(wrappedKey));
  const dataKey = await crypto.subtle.importKey('raw', rawDataKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, dataKey, ciphertextBuf);
  return plainBuf; // caller wraps in a Blob with the right mime type
}

async function wrapDataKeyForRecipients(rawDataKey, recipients) {
  return Promise.all(recipients.map(async ({ id, publicKeyJwk }) => {
    const pubKey = await importPublicKey(publicKeyJwk);
    const wrappedKeyBuf = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, pubKey, rawDataKey);
    return { recipientId: id, wrappedKey: toB64(wrappedKeyBuf) };
  }));
}

// --- local private-key storage (IndexedDB, never sent to the server) ---
const DB_NAME = 'chatmail_keys', STORE = 'keys';
function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function savePrivateKey(userId, privateKeyJwk) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(privateKeyJwk, userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function loadPrivateKey(userId) {
  const db = await openKeyDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(userId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
