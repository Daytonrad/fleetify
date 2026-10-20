/**
 * Voice dictation hook — delegates mic capture entirely to Rust (cpal).
 *
 * The renderer no longer calls getUserMedia / ScriptProcessorNode / AudioContext.
 * Instead:
 *   toggle()  →  voice_start_recording (cpal starts WASAPI capture in Rust)
 *   toggle()  →  voice_stop_recording  (cpal stops, WAV encoded, transcribed in Rust)
 *
 * This eliminates the browser-style mic permission popup on Windows because
 * cpal uses the OS WASAPI API directly (trusted desktop-app context).
 */
import { useCallback, useEffect, useState } from "react";

import { voice, type VoiceEngine } from "@/lib/voice-api";

const LS = {
  engine:   "fleet.voice.engine",
  language: "fleet.voice.language",
  model:    "fleet.voice.model",
  prompt:   "fleet.voice.prompt",
  device:   "fleet.mic.deviceId",
} as const;

export interface VoicePrefs {
  engine:   VoiceEngine;
  language: string;
  model:    string;
  prompt:   string;
  deviceId: string | null;
}

const VALID_ENGINES: VoiceEngine[] = ["auto", "local", "broker", "byok"];

/** Actionable messages keyed by Rust error codes. */
const VOICE_ERRORS: Partial<Record<string, string>> = {
  NO_ENGINE:         "No voice engine available — sign in, add an API key, or download a local model in Settings → Voice.",
  NO_TOKEN:          "Sign in to Fleetify to use cloud voice. Open Settings → Account.",
  QUOTA_EXCEEDED:    "Daily voice quota reached. Switch to your own key or a local model in Settings → Voice.",
  NO_KEY:            "No API key saved. Add a Groq or OpenAI key in Settings → Voice.",
  NO_MODEL:          "No local Whisper model downloaded. Download one in Settings → Voice.",
  LOCAL_UNAVAILABLE: "Local Whisper engine not available in this build. Use Fleetify cloud or your own key.",
  CAPTURE_FAILED:    "Could not access the microphone. Check your system audio settings.",
  NOT_RECORDING:     "No active recording — try again.",
};

/** Read voice prefs from localStorage (shared with Settings → Voice). */
export function getVoicePrefs(): VoicePrefs {
  const get = (k: string, d: string) => {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  };
  const engine = get(LS.engine, "auto");
  return {
    engine:   (VALID_ENGINES.includes(engine as VoiceEngine) ? engine : "auto") as VoiceEngine,
    language: get(LS.language, "auto"),
    model:    get(LS.model, ""),
    prompt:   get(LS.prompt, ""),
    deviceId: (() => { try { return localStorage.getItem(LS.device); } catch { return null; } })(),
  };
}

/** Fired after every pref write. Settings is a sibling route that does NOT
 *  unmount the composer, so a mount-time read would never see the change. */
export const VOICE_PREFS_EVENT = "fleet:voice-prefs";

export function setVoicePref(key: keyof typeof LS, value: string) {
  try { localStorage.setItem(LS[key], value); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(VOICE_PREFS_EVENT)); } catch { /* no DOM */ }
}

/** Whether dictation can run right now, and why not when it can't. */
export interface VoiceReadiness {
  ready: boolean;
  /** Hover text for the disabled mic. Null while ready. */
  reason: string | null;
}

const READY:    VoiceReadiness = { ready: true,  reason: null };
const CHECKING: VoiceReadiness = { ready: false, reason: "Checking the on-device voice model…" };
const NO_MODEL: VoiceReadiness = {
  ready: false,
  reason: "Voice model not installed — download an on-device model in Settings → Voice",
};
const NO_ENGINE: VoiceReadiness = {
  ready: false,
  reason: "This build has no on-device voice engine — pick another engine in Settings → Voice",
};

/**
 * Readiness of the current voice prefs.
 *
 * Only the on-device ("local") engine can be dead on arrival: it needs a
 * downloaded Whisper model, and Settings persists a model *id* the moment you
 * pick the engine — before anything is on disk — so the pref string alone
 * proves nothing. Rust falls back to any downloaded model
 * (`src-tauri/src/shell/voice/models.rs::resolve_model_path`), so "at least
 * one downloaded" is the exact condition; anything less only ever yields a
 * NO_MODEL error after the user has already spoken.
 *
 * "auto" / "broker" / "byok" never require a local model — they're ready
 * immediately and never touch the IPC.
 */
export function useVoiceReady(): VoiceReadiness {
  const [state, setState] = useState<VoiceReadiness>(
    () => (getVoicePrefs().engine === "local" ? CHECKING : READY),
  );

  useEffect(() => {
    let cancelled = false;
    let lastEngine: VoiceEngine | null = null;

    /** `force` re-runs the IPC even when the engine is unchanged — used when a
     *  download finishes or the window regains focus. The engine guard exists
     *  because Settings writes a pref on every keystroke of the vocabulary
     *  hint, and those must not each cost a round-trip. */
    const check = (force: boolean) => {
      const { engine } = getVoicePrefs();
      const changed = engine !== lastEngine;
      lastEngine = engine;
      if (!changed && !force) return;
      if (engine !== "local") { setState(READY); return; }
      if (changed) setState(CHECKING);
      voice
        .listModels()
        .then((r) => {
          if (cancelled) return;
          if (!r.supported) { setState(NO_ENGINE); return; }
          setState(r.models.some((m) => m.downloaded) ? READY : NO_MODEL);
        })
        .catch(() => { if (!cancelled) setState(NO_MODEL); });
    };

    check(true);
    const onPrefs = () => check(false);
    const onFocus = () => check(true);
    // A download finishing while Settings is open has to re-enable the mic
    // underneath it — the composer never unmounted, so nothing else would.
    const off = voice.onModelProgress((p) => { if (p.done) check(true); });
    window.addEventListener(VOICE_PREFS_EVENT, onPrefs);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      off();
      window.removeEventListener(VOICE_PREFS_EVENT, onPrefs);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return state;
}

type State = "idle" | "recording" | "transcribing";

export interface UseVoiceDictation {
  state:     State;
  recording: boolean;
  busy:      boolean;
  error:     string | null;
  /** Start if idle, stop + transcribe if recording. */
  toggle: () => void;
  cancel: () => void;
}

export function useVoiceDictation(onTranscript: (text: string) => void): UseVoiceDictation {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(() => {
    // Best-effort stop — discard any captured audio.
    void voice.stopRecording("auto", "auto", "", "");
    setState("idle");
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") {
      setState("transcribing");
      const prefs = getVoicePrefs();
      voice
        .stopRecording(prefs.engine, prefs.language, prefs.model, prefs.prompt)
        .then((res) => {
          setState("idle");
          if (res.ok && res.text?.trim()) {
            onTranscript(res.text.trim());
          } else if (!res.ok) {
            const msg = res.code
              ? (VOICE_ERRORS[res.code] ?? res.error ?? "Transcription failed.")
              : (res.error ?? "Transcription failed.");
            setError(msg);
          }
        })
        .catch(() => {
          setState("idle");
          setError("Transcription failed.");
        });
    } else if (state === "idle") {
      setError(null);
      const prefs = getVoicePrefs();
      voice
        .startRecording(prefs.deviceId)
        .then((res) => {
          if (res.ok) {
            setState("recording");
          } else {
            const msg = res.code
              ? (VOICE_ERRORS[res.code] ?? res.error ?? "Could not start recording.")
              : (res.error ?? "Could not start recording.");
            setError(msg);
          }
        })
        .catch(() => setError("Could not start recording."));
    }
  }, [state, onTranscript]);

  return {
    state,
    recording: state === "recording",
    busy:      state === "transcribing",
    error,
    toggle,
    cancel,
  };
}
