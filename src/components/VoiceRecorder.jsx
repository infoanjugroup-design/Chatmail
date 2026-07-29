import { useRef, useState } from 'react';

// Records audio via the browser's MediaRecorder API. Calls onSend(blob,
// durationSeconds) when the user hits send. Falls back to a clear error
// message if the browser/device denies mic access — never fails silently.
export default function VoiceRecorder({ onSend }) {
  const [state, setState] = useState('idle'); // 'idle' | 'recording' | 'error'
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setState('recording');
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    } catch (err) {
      setState('error');
      setError(err.name === 'NotAllowedError' ? 'Microphone permission denied.' : 'Could not access microphone.');
    }
  }

  function cleanup() {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
    setState('idle');
    setSeconds(0);
  }

  function cancelRecording() {
    mediaRecorderRef.current?.stop();
    cleanup();
  }

  function finishAndSend() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    const durationAtStop = seconds;
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      onSend(blob, durationAtStop);
    };
    recorder.stop();
    cleanup();
  }

  if (state === 'recording') {
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    return (
      <div className="flex items-center gap-2 bg-dusk2 rounded-full px-3 py-1.5">
        <span className="w-2 h-2 rounded-full bg-coral animate-pulse" />
        <span className="text-paper/80 text-sm font-mono">{mm}:{ss}</span>
        <button type="button" onClick={cancelRecording} className="text-paper/50 text-sm px-2">Cancel</button>
        <button type="button" onClick={finishAndSend} className="text-coral text-sm font-semibold px-2">Send ▶</button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={startRecording}
        title="Record a voice note"
        className="w-10 h-10 rounded-full bg-dusk2 text-paper flex items-center justify-center hover:bg-coral hover:text-ink transition"
      >
        🎙️
      </button>
      {error && <span className="text-coral text-xs">{error}</span>}
    </div>
  );
}
