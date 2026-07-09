/**
 * Voice Detector — observe-only, site-agnostic microphone-capture detection.
 *
 * Detects, in the moment and on ANY site (no domain allowlist), when a page
 * captures microphone audio in a way that would upload it off-device — the last
 * redaction bypass, since spoken PII leaves as an audio blob before any text
 * guard can see it.
 *
 * Design principle: hook capabilities, not sites. Every site that records mic
 * audio uses the same small set of browser APIs. We instrument those, so a
 * brand-new AI service or an internal enterprise tool is covered with zero
 * configuration.
 *
 * This module is OBSERVE-ONLY: it wraps native APIs transparently, calling
 * through and returning their real values unchanged, and never alters, blocks,
 * or delays anything. If any instrumentation throws, the original call path is
 * used, so it can never break a page. It emits detections to the extension's
 * isolated-world content script via window.postMessage; it performs no network
 * activity and stores no audio.
 *
 * Two signals are distinguished:
 *   - AUDIO_CAPTURE_TO_RECORDER — getUserMedia(audio) feeding a MediaRecorder.
 *     Strong indicator the raw audio is being packaged for upload (leak risk).
 *   - LOCAL_SPEECH_RECOGNITION — the Web Speech API is used. Audio is handled by
 *     the browser's recognizer, not packaged as a blob by the page (no blob
 *     leaves the page's JS; informational only).
 *
 * The correlation logic is a pure, side-effect-free class so it can be unit
 * tested without a DOM. The installer at the bottom only runs in a real
 * browser MAIN-world context.
 */

(function () {
  'use strict';

  /** How long an opened audio capture stays "recent" for correlation (ms). */
  const CAPTURE_TTL_MS = 60_000;

  const EVENT_TYPES = {
    AUDIO_CAPTURE_TO_RECORDER: 'audio_capture_to_recorder',
    LOCAL_SPEECH_RECOGNITION: 'local_speech_recognition',
  };

  /** postMessage tag used to bridge MAIN world → isolated content script. */
  const MESSAGE_SOURCE = 'llss-voice-detector';

  /**
   * Pure correlation logic. Fed normalized events by the installer; decides
   * whether a microphone capture looks like audio destined to leave the page.
   * No DOM or timer access — the caller supplies timestamps.
   */
  class VoiceActivityCorrelator {
    constructor(ttlMs = CAPTURE_TTL_MS) {
      this.ttlMs = ttlMs;
      /** @type {Map<string, number>} audio track id → capture timestamp */
      this._openAudioTracks = new Map();
      /** track ids we've already reported a recorder for (dedup) */
      this._reportedTracks = new Set();
    }

    _evict(now) {
      for (const [trackId, t] of this._openAudioTracks) {
        if (now - t > this.ttlMs) {
          this._openAudioTracks.delete(trackId);
          this._reportedTracks.delete(trackId);
        }
      }
    }

    /**
     * Record that getUserMedia returned an audio stream.
     * @param {string[]} audioTrackIds
     * @param {number} now - timestamp (ms)
     */
    noteAudioCapture(audioTrackIds, now) {
      this._evict(now);
      for (const id of audioTrackIds || []) {
        if (typeof id === 'string' && id) this._openAudioTracks.set(id, now);
      }
    }

    /**
     * Record that a MediaRecorder started over a stream. If that stream's audio
     * tracks came from a getUserMedia capture we saw, this is the leak-risk
     * signal.
     * @param {string[]} recordedTrackIds
     * @param {number} now
     * @returns {{type: string, leakRisk: boolean, trackId: string}|null}
     */
    noteRecorderStart(recordedTrackIds, now) {
      this._evict(now);
      for (const id of recordedTrackIds || []) {
        if (this._openAudioTracks.has(id) && !this._reportedTracks.has(id)) {
          this._reportedTracks.add(id);
          return {
            type: EVENT_TYPES.AUDIO_CAPTURE_TO_RECORDER,
            leakRisk: true,
            trackId: id,
          };
        }
      }
      return null;
    }

    /**
     * Record that the Web Speech API was started.
     * @param {number} now
     * @returns {{type: string, leakRisk: boolean}}
     */
    noteSpeechRecognition(now) {
      this._evict(now);
      return { type: EVENT_TYPES.LOCAL_SPEECH_RECOGNITION, leakRisk: false };
    }

    /** Number of audio captures currently within the correlation window. */
    openCaptureCount() {
      return this._openAudioTracks.size;
    }
  }

  // ── Exports (for unit tests and isolated-world consumers) ────────────────────
  const api = { VoiceActivityCorrelator, EVENT_TYPES, MESSAGE_SOURCE, CAPTURE_TTL_MS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  // ── MAIN-world installer ─────────────────────────────────────────────────────
  // Only runs in a real browser page. In Node/Jest `window` is undefined, so the
  // pure logic above can be required without patching anything.
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (window.__LLSS_VOICE_DETECTOR_INSTALLED__) return;
  window.__LLSS_VOICE_DETECTOR_INSTALLED__ = true;

  const correlator = new VoiceActivityCorrelator();

  function now() {
    try {
      return performance.now();
    } catch {
      return 0;
    }
  }

  /** Emit a detection to the isolated-world bridge. Never throws. */
  function emit(detection) {
    try {
      window.postMessage(
        { source: MESSAGE_SOURCE, detection, href: location.href },
        location.origin || '*'
      );
    } catch {
      /* observe-only: swallow */
    }
  }

  /** Make a wrapper report the native source, reducing tamper-detection. */
  function maskToString(wrapper, original) {
    try {
      const nativeStr = Function.prototype.toString.call(original);
      wrapper.toString = () => nativeStr;
    } catch {
      /* best effort */
    }
  }

  // 1) navigator.mediaDevices.getUserMedia — note audio captures.
  try {
    const md = navigator.mediaDevices;
    if (md && typeof md.getUserMedia === 'function') {
      const original = md.getUserMedia.bind(md);
      const wrapped = function (constraints) {
        const result = original(constraints);
        try {
          if (constraints && constraints.audio && result && typeof result.then === 'function') {
            result
              .then((stream) => {
                try {
                  const ids = stream.getAudioTracks().map((t) => t.id);
                  if (ids.length) correlator.noteAudioCapture(ids, now());
                } catch {
                  /* swallow */
                }
              })
              .catch(() => {});
          }
        } catch {
          /* swallow — original result is already returned */
        }
        return result;
      };
      maskToString(wrapped, md.getUserMedia);
      md.getUserMedia = wrapped;
    }
  } catch {
    /* leave native getUserMedia untouched */
  }

  // 2) MediaRecorder.prototype.start — correlate against known audio captures.
  //    Patch the method, not the class, to preserve instanceof/prototype identity.
  try {
    const MR = window.MediaRecorder;
    if (MR && MR.prototype && typeof MR.prototype.start === 'function') {
      const originalStart = MR.prototype.start;
      const wrappedStart = function (...args) {
        try {
          const stream = this && this.stream;
          if (stream && typeof stream.getAudioTracks === 'function') {
            const ids = stream.getAudioTracks().map((t) => t.id);
            const detection = correlator.noteRecorderStart(ids, now());
            if (detection) emit(detection);
          }
        } catch {
          /* swallow — fall through to native start */
        }
        return originalStart.apply(this, args);
      };
      maskToString(wrappedStart, originalStart);
      MR.prototype.start = wrappedStart;
    }
  } catch {
    /* leave native MediaRecorder untouched */
  }

  // 3) SpeechRecognition.prototype.start — informational (no blob leaves page).
  try {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR && SR.prototype && typeof SR.prototype.start === 'function') {
      const originalStart = SR.prototype.start;
      const wrappedStart = function (...args) {
        try {
          emit(correlator.noteSpeechRecognition(now()));
        } catch {
          /* swallow */
        }
        return originalStart.apply(this, args);
      };
      maskToString(wrappedStart, originalStart);
      SR.prototype.start = wrappedStart;
    }
  } catch {
    /* leave native SpeechRecognition untouched */
  }
})();
