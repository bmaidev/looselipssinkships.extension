const {
  VoiceActivityCorrelator,
  EVENT_TYPES,
  MESSAGE_SOURCE,
} = require("../lib/voice-detector");

describe("VoiceActivityCorrelator", () => {
  test("flags getUserMedia audio feeding a MediaRecorder as leak risk", () => {
    const c = new VoiceActivityCorrelator();
    c.noteAudioCapture(["track-a"], 0);
    const detection = c.noteRecorderStart(["track-a"], 10);

    expect(detection).not.toBeNull();
    expect(detection.type).toBe(EVENT_TYPES.AUDIO_CAPTURE_TO_RECORDER);
    expect(detection.leakRisk).toBe(true);
    expect(detection.trackId).toBe("track-a");
  });

  test("recorder over an unrelated track is not flagged", () => {
    const c = new VoiceActivityCorrelator();
    c.noteAudioCapture(["track-a"], 0);
    expect(c.noteRecorderStart(["some-other-track"], 10)).toBeNull();
  });

  test("recorder with no prior capture is not flagged", () => {
    const c = new VoiceActivityCorrelator();
    expect(c.noteRecorderStart(["track-a"], 0)).toBeNull();
  });

  test("matches when any recorded track intersects a known capture", () => {
    const c = new VoiceActivityCorrelator();
    c.noteAudioCapture(["mic-track"], 0);
    const detection = c.noteRecorderStart(["video-track", "mic-track"], 5);
    expect(detection).not.toBeNull();
    expect(detection.trackId).toBe("mic-track");
  });

  test("does not double-report the same captured track", () => {
    const c = new VoiceActivityCorrelator();
    c.noteAudioCapture(["track-a"], 0);
    expect(c.noteRecorderStart(["track-a"], 10)).not.toBeNull();
    // A second recorder start over the same track should not re-fire.
    expect(c.noteRecorderStart(["track-a"], 20)).toBeNull();
  });

  test("expires captures older than the TTL", () => {
    const c = new VoiceActivityCorrelator(1000);
    c.noteAudioCapture(["track-a"], 0);
    // Recorder starts after the TTL window — the capture is forgotten.
    expect(c.noteRecorderStart(["track-a"], 2000)).toBeNull();
  });

  test("keeps captures within the TTL window", () => {
    const c = new VoiceActivityCorrelator(1000);
    c.noteAudioCapture(["track-a"], 0);
    expect(c.noteRecorderStart(["track-a"], 999)).not.toBeNull();
  });

  test("speech recognition is reported without leak risk", () => {
    const c = new VoiceActivityCorrelator();
    const detection = c.noteSpeechRecognition(0);
    expect(detection.type).toBe(EVENT_TYPES.LOCAL_SPEECH_RECOGNITION);
    expect(detection.leakRisk).toBe(false);
  });

  test("openCaptureCount tracks live captures and evicts stale ones", () => {
    const c = new VoiceActivityCorrelator(1000);
    c.noteAudioCapture(["a"], 0);
    c.noteAudioCapture(["b"], 0);
    expect(c.openCaptureCount()).toBe(2);
    // A later note triggers eviction of the two stale entries.
    c.noteAudioCapture(["c"], 5000);
    expect(c.openCaptureCount()).toBe(1);
  });

  test("ignores non-string / empty track ids", () => {
    const c = new VoiceActivityCorrelator();
    c.noteAudioCapture([null, undefined, "", 42], 0);
    expect(c.openCaptureCount()).toBe(0);
  });

  test("tolerates missing track-id arrays", () => {
    const c = new VoiceActivityCorrelator();
    expect(() => c.noteAudioCapture(undefined, 0)).not.toThrow();
    expect(c.noteRecorderStart(undefined, 0)).toBeNull();
  });
});

describe("module surface", () => {
  test("exports stable event types and message source", () => {
    expect(EVENT_TYPES.AUDIO_CAPTURE_TO_RECORDER).toBe("audio_capture_to_recorder");
    expect(EVENT_TYPES.LOCAL_SPEECH_RECOGNITION).toBe("local_speech_recognition");
    expect(MESSAGE_SOURCE).toBe("llss-voice-detector");
  });

  test("requiring the module in Node does not patch any globals", () => {
    // window is undefined in the Node test env, so the installer must no-op.
    expect(typeof window).toBe("undefined");
  });
});
