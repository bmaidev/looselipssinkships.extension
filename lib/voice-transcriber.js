/**
 * Voice Transcriber — on-device speech-to-text using Chrome's built-in,
 * local Web Speech recognizer (SpeechRecognition with processLocally = true,
 * stable Chrome 139+). Audio never leaves the machine.
 *
 * This is the local-first answer to the dictation bypass: instead of a site
 * uploading your microphone audio to transcribe it server-side, transcribe it
 * here, on-device, and redact the text before it goes anywhere.
 *
 * Runs only in a window context (extension tab / offscreen document) — never in
 * the service worker. The pure helpers (availability classification, transcript
 * assembly, language normalization) are side-effect-free and unit tested; the
 * recognizer methods are guarded and only touch the browser API when present.
 */

(function () {
  'use strict';

  const DEFAULT_LANG = 'en-US';

  /** Normalize a BCP-47 language tag, falling back to the default. */
  function normalizeLang(lang) {
    if (typeof lang !== 'string') return DEFAULT_LANG;
    const trimmed = lang.trim();
    return trimmed || DEFAULT_LANG;
  }

  /**
   * Map a SpeechRecognition.available() result to a simple capability object.
   * @param {string} state - "available" | "downloadable" | "downloading" | "unavailable"
   * @returns {{ready: boolean, needsInstall: boolean, downloading: boolean, unsupported: boolean, state: string}}
   */
  function classifyAvailability(state) {
    switch (state) {
      case 'available':
        return { ready: true, needsInstall: false, downloading: false, unsupported: false, state };
      case 'downloadable':
        return { ready: false, needsInstall: true, downloading: false, unsupported: false, state };
      case 'downloading':
        return { ready: false, needsInstall: false, downloading: true, unsupported: false, state };
      case 'unavailable':
      default:
        return { ready: false, needsInstall: false, downloading: false, unsupported: true, state: state || 'unavailable' };
    }
  }

  /**
   * Assemble a clean transcript from recognized final segments.
   * @param {string[]} segments
   * @returns {string}
   */
  function joinTranscript(segments) {
    if (!Array.isArray(segments)) return '';
    return segments
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Whether on-device Web Speech is even present in this environment.
   * @param {object} [env] - injectable for tests; defaults to the real globals
   * @returns {boolean}
   */
  function isSupported(env) {
    const scope = env || (typeof window !== 'undefined' ? window : {});
    const Ctor = scope.SpeechRecognition || scope.webkitSpeechRecognition;
    if (typeof Ctor !== 'function') return false;
    // processLocally lives on the prototype in supporting builds (Chrome 139+).
    return 'processLocally' in Ctor.prototype;
  }

  function getRecognitionCtor() {
    if (typeof window === 'undefined') return null;
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  /**
   * Check whether the on-device language pack is ready.
   * @param {string} lang
   * @returns {Promise<object>} capability (see classifyAvailability)
   */
  async function checkAvailability(lang) {
    const Ctor = getRecognitionCtor();
    if (!Ctor || typeof Ctor.available !== 'function') {
      return classifyAvailability('unavailable');
    }
    try {
      const state = await Ctor.available({
        langs: [normalizeLang(lang)],
        processLocally: true,
      });
      return classifyAvailability(state);
    } catch {
      return classifyAvailability('unavailable');
    }
  }

  /**
   * Trigger download/install of the on-device language pack.
   * @param {string} lang
   * @returns {Promise<boolean>} true if installed/available
   */
  async function installLanguagePack(lang) {
    const Ctor = getRecognitionCtor();
    if (!Ctor || typeof Ctor.install !== 'function') return false;
    try {
      return await Ctor.install({ langs: [normalizeLang(lang)] });
    } catch {
      return false;
    }
  }

  /**
   * Ensure the on-device language pack is downloaded and ready. Checks
   * availability, triggers install if the pack is downloadable, and polls until
   * ready (or times out). Must be awaited before startDictation, otherwise the
   * recognizer throws "language-not-supported" on a not-yet-installed pack.
   *
   * @param {string} lang
   * @param {object} [opts]
   * @param {(state: string) => void} [opts.onProgress] - reports poll states
   * @param {number} [opts.timeoutMs] - give up after this long (default 30s)
   * @param {number} [opts.pollMs] - poll interval (default 1s)
   * @returns {Promise<{ready: boolean, reason?: string, state?: string}>}
   */
  async function ensureReady(lang, opts = {}) {
    const Ctor = getRecognitionCtor();
    if (!Ctor || typeof Ctor.available !== 'function') {
      return { ready: false, reason: 'unsupported' };
    }
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
    const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 1000;
    // How long to wait for install() to at least *begin* downloading before we
    // conclude it can't fetch the pack in this browser (a known Chromium
    // limitation: install() returns false and availability stays "downloadable").
    const graceMs = typeof opts.graceMs === 'number' ? opts.graceMs : 5000;

    let cap = await checkAvailability(lang);
    if (cap.ready) return { ready: true };
    if (cap.unsupported) return { ready: false, reason: 'unsupported' };

    // Downloadable or downloading — request install, then poll until ready.
    await installLanguagePack(lang);

    const start = Date.now();
    let sawDownloading = false;
    while (Date.now() - start < timeoutMs) {
      cap = await checkAvailability(lang);
      if (cap.ready) return { ready: true };
      if (cap.unsupported) return { ready: false, reason: 'unsupported' };
      if (cap.downloading) sawDownloading = true;
      if (typeof opts.onProgress === 'function') opts.onProgress(cap.state);
      // If the pack never even starts downloading within the grace window,
      // install() cannot fetch it here — stop instead of polling forever.
      if (!sawDownloading && Date.now() - start > graceMs) {
        return { ready: false, reason: 'install_unavailable', state: cap.state };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ready: false, reason: 'timeout', state: cap.state };
  }

  /**
   * Start on-device dictation from the microphone. Resolves with the final
   * transcript when stopped. Audio is transcribed locally and never uploaded.
   *
   * @param {object} opts
   * @param {string} [opts.lang]
   * @param {(interim: string) => void} [opts.onPartial] - live interim text
   * @param {(err: Error) => void} [opts.onError]
   * @returns {Promise<{ transcript: string, stop: () => void, handle: object }>}
   *   Resolves immediately with a handle exposing stop(); the final transcript
   *   is delivered via the returned handle's `done` promise.
   */
  async function startDictation(opts = {}) {
    const Ctor = getRecognitionCtor();
    if (!Ctor) throw new Error('SpeechRecognition is not available in this browser.');
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      throw new Error('Microphone access is not available.');
    }

    const lang = normalizeLang(opts.lang);
    const segments = [];

    // Capture our own mic track so recognition transcribes exactly this stream.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const track = stream.getAudioTracks()[0];

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    try {
      recognition.processLocally = true; // force on-device (no network)
    } catch {
      /* older builds: property may be read-only or absent */
    }

    let settle;
    const done = new Promise((resolve) => { settle = resolve; });

    function cleanup() {
      try { track && track.stop(); } catch { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    }

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          segments.push(res[0].transcript);
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim && typeof opts.onPartial === 'function') opts.onPartial(interim);
    };

    recognition.onerror = (event) => {
      if (typeof opts.onError === 'function') {
        opts.onError(new Error(event.error || 'speech recognition error'));
      }
    };

    recognition.onend = () => {
      cleanup();
      settle(joinTranscript(segments));
    };

    // Prefer feeding our captured track (Chrome 135+); fall back to default mic.
    try {
      recognition.start(track);
    } catch {
      try {
        recognition.start();
      } catch (err) {
        cleanup();
        throw err;
      }
    }

    function stop() {
      try { recognition.stop(); } catch { cleanup(); settle(joinTranscript(segments)); }
    }

    return { stop, done, handle: recognition };
  }

  // ── Engine selection (pure) ──────────────────────────────────────────────

  /**
   * Choose the best available on-device transcription engine.
   * Web Speech (streaming) is preferred when it genuinely reports ready;
   * otherwise Gemini Nano audio (record-then-transcribe). Cloud is never chosen
   * — it would upload audio.
   * @param {{webSpeechReady?: boolean, nanoReady?: boolean}} caps
   * @returns {'webspeech'|'nano'|null}
   */
  function pickEngine(caps) {
    if (!caps) return null;
    if (caps.webSpeechReady) return 'webspeech';
    if (caps.nanoReady) return 'nano';
    return null;
  }

  /**
   * Clean an LLM transcription result — strip a leading "Transcription:" style
   * label and surrounding quotes that small models sometimes add.
   * @param {string} raw
   * @returns {string}
   */
  function cleanTranscript(raw) {
    if (typeof raw !== 'string') return '';
    let text = raw.trim();
    text = text.replace(/^(here'?s?\s+(is\s+)?the\s+)?transcription\s*[:\-]\s*/i, '');
    text = text.replace(/^transcript\s*[:\-]\s*/i, '');
    // Strip a single layer of wrapping quotes.
    if (text.length >= 2 && /^["'“”]/.test(text) && /["'“”]$/.test(text)) {
      text = text.slice(1, -1).trim();
    }
    return text.trim();
  }

  // ── Gemini Nano audio engine (browser) ───────────────────────────────────

  function getLanguageModel() {
    return typeof LanguageModel !== 'undefined' ? LanguageModel : null;
  }

  /** Whether the Nano audio engine is present in this context. */
  function nanoAudioSupported() {
    return !!getLanguageModel();
  }

  /**
   * Check whether Nano can accept audio input.
   * @returns {Promise<object>} capability (see classifyAvailability)
   */
  async function nanoAudioAvailability() {
    const LM = getLanguageModel();
    if (!LM || typeof LM.availability !== 'function') return classifyAvailability('unavailable');
    try {
      const state = await LM.availability({ expectedInputs: [{ type: 'audio' }] });
      return classifyAvailability(state);
    } catch {
      return classifyAvailability('unavailable');
    }
  }

  /**
   * Record a microphone clip. Returns a handle whose stop() resolves the audio
   * Blob. Audio stays in memory; nothing is uploaded.
   * @returns {Promise<{stop: () => Promise<Blob>, cancel: () => void}>}
   */
  async function startRecording() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      throw new Error('Microphone access is not available.');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('MediaRecorder is not available.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start();

    function stopTracks() {
      try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    }

    return {
      stop() {
        return new Promise((resolve) => {
          recorder.onstop = () => {
            stopTracks();
            resolve(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
          };
          try { recorder.stop(); } catch { stopTracks(); resolve(new Blob(chunks)); }
        });
      },
      cancel() {
        try { recorder.stop(); } catch { /* ignore */ }
        stopTracks();
      },
    };
  }

  /**
   * Transcribe an audio Blob on-device with Gemini Nano.
   * @param {Blob} blob
   * @returns {Promise<string>} transcript
   */
  async function transcribeWithNano(blob) {
    const LM = getLanguageModel();
    if (!LM || typeof LM.create !== 'function') {
      throw new Error('On-device model is not available.');
    }
    const session = await LM.create({ expectedInputs: [{ type: 'audio' }] });
    try {
      const result = await session.prompt([
        {
          role: 'user',
          content: [
            { type: 'text', value: 'Transcribe the following audio to text verbatim. Output only the transcription with no commentary, labels, or quotation marks.' },
            { type: 'audio', value: blob },
          ],
        },
      ]);
      return cleanTranscript(result);
    } finally {
      try { session.destroy(); } catch { /* ignore */ }
    }
  }

  // ── Exports ──────────────────────────────────────────────────────────────
  const api = {
    DEFAULT_LANG,
    normalizeLang,
    classifyAvailability,
    joinTranscript,
    isSupported,
    checkAvailability,
    installLanguagePack,
    ensureReady,
    startDictation,
    pickEngine,
    cleanTranscript,
    nanoAudioSupported,
    nanoAudioAvailability,
    startRecording,
    transcribeWithNano,
  };

  if (typeof globalThis !== 'undefined') globalThis.LLSS_voiceTranscriber = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
