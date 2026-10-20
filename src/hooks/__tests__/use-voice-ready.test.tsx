/**
 * Regression: selecting Settings → Voice → "On-device" writes a model id
 * (`large-v3-turbo`) even when nothing has been downloaded yet, so a check
 * that only asked "is the model pref non-empty?" left the composer mic
 * enabled. The user found out it was dead only after speaking a sentence
 * and getting NO_MODEL back. Readiness now asks the shell what is actually
 * on disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

import type { VoiceModel, VoiceModelProgress } from "@/lib/voice-api";

const listModels = vi.fn();
let progressCb: ((p: VoiceModelProgress) => void) | null = null;

vi.mock("@/lib/voice-api", () => ({
  voice: {
    listModels: () => listModels(),
    onModelProgress: (cb: (p: VoiceModelProgress) => void) => {
      progressCb = cb;
      return () => { progressCb = null; };
    },
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  },
}));

import { useVoiceReady, setVoicePref } from "../use-voice-dictation";

const mdl = (id: string, downloaded: boolean): VoiceModel =>
  ({ id, name: id, size_mb: 1, downloaded });

const models = (...ms: VoiceModel[]) =>
  listModels.mockResolvedValue({ ok: true, supported: true, models: ms });

beforeEach(() => {
  localStorage.clear();
  listModels.mockReset();
  progressCb = null;
});

describe("useVoiceReady", () => {
  it("is ready without touching the shell for cloud/key/auto engines", async () => {
    localStorage.setItem("fleet.voice.engine", "broker");
    const { result } = renderHook(() => useVoiceReady());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.reason).toBeNull();
    expect(listModels).not.toHaveBeenCalled();
  });

  it("blocks the mic when on-device is picked with nothing downloaded", async () => {
    localStorage.setItem("fleet.voice.engine", "local");
    // What Settings actually persists on a fresh install: an id, not a file.
    localStorage.setItem("fleet.voice.model", "large-v3-turbo");
    models(mdl("large-v3-turbo", false), mdl("base", false));

    const { result } = renderHook(() => useVoiceReady());
    // Gate on the settled reason: the transient "checking" state is also
    // ready:false, so asserting that alone would pass before the IPC lands.
    await waitFor(() => expect(result.current.reason).toMatch(/not installed/));
    expect(result.current.ready).toBe(false);
    expect(result.current.reason).toMatch(/Settings → Voice/);
  });

  it("is ready when any model is downloaded, even a different one", async () => {
    // Rust's resolve_model_path falls back to any downloaded model, so a
    // stale pref pointing at an undownloaded id still transcribes.
    localStorage.setItem("fleet.voice.engine", "local");
    localStorage.setItem("fleet.voice.model", "large-v3-turbo");
    models(mdl("large-v3-turbo", false), mdl("base", true));

    const { result } = renderHook(() => useVoiceReady());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.reason).toBeNull();
  });

  it("blocks the mic on a build compiled without the local engine", async () => {
    localStorage.setItem("fleet.voice.engine", "local");
    listModels.mockResolvedValue({ ok: true, supported: false, models: [] });

    const { result } = renderHook(() => useVoiceReady());
    await waitFor(() => expect(result.current.reason).toMatch(/build/i));
    expect(result.current.ready).toBe(false);
  });

  it("re-enables the mic when a download finishes, without a remount", async () => {
    localStorage.setItem("fleet.voice.engine", "local");
    models(mdl("base", false));

    const { result } = renderHook(() => useVoiceReady());
    await waitFor(() => expect(result.current.reason).toMatch(/not installed/));

    models(mdl("base", true));
    await act(async () => { progressCb?.({ id: "base", received: 1, total: 1, done: true }); });
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it("re-enables the mic when Settings switches away from on-device", async () => {
    localStorage.setItem("fleet.voice.engine", "local");
    models(mdl("base", false));

    const { result } = renderHook(() => useVoiceReady());
    await waitFor(() => expect(result.current.reason).toMatch(/not installed/));

    // The composer stays mounted under the Settings route, so the engine
    // switch has to reach it as an event rather than on a fresh mount.
    await act(async () => { setVoicePref("engine", "broker"); });
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it("ignores unrelated pref writes instead of re-querying the shell", async () => {
    localStorage.setItem("fleet.voice.engine", "local");
    models(mdl("base", true));

    const { result } = renderHook(() => useVoiceReady());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(listModels).toHaveBeenCalledTimes(1);

    // Typing in the vocabulary-hint box writes a pref on every keystroke.
    await act(async () => { setVoicePref("prompt", "Fleetify"); });
    expect(listModels).toHaveBeenCalledTimes(1);
  });
});
