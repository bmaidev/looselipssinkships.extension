const {
  DEFAULT_LANG,
  normalizeLang,
  classifyAvailability,
  joinTranscript,
  isSupported,
  pickEngine,
  cleanTranscript,
} = require("../lib/voice-transcriber");

describe("normalizeLang", () => {
  test("keeps a valid tag", () => {
    expect(normalizeLang("en-GB")).toBe("en-GB");
  });
  test("falls back to default for empty/invalid", () => {
    expect(normalizeLang("")).toBe(DEFAULT_LANG);
    expect(normalizeLang("   ")).toBe(DEFAULT_LANG);
    expect(normalizeLang(undefined)).toBe(DEFAULT_LANG);
    expect(normalizeLang(null)).toBe(DEFAULT_LANG);
    expect(normalizeLang(42)).toBe(DEFAULT_LANG);
  });
  test("trims surrounding whitespace", () => {
    expect(normalizeLang("  fr-FR  ")).toBe("fr-FR");
  });
});

describe("classifyAvailability", () => {
  test("available → ready", () => {
    const c = classifyAvailability("available");
    expect(c.ready).toBe(true);
    expect(c.unsupported).toBe(false);
  });
  test("downloadable → needs install", () => {
    const c = classifyAvailability("downloadable");
    expect(c.ready).toBe(false);
    expect(c.needsInstall).toBe(true);
  });
  test("downloading → downloading", () => {
    const c = classifyAvailability("downloading");
    expect(c.downloading).toBe(true);
    expect(c.ready).toBe(false);
  });
  test("unavailable → unsupported", () => {
    const c = classifyAvailability("unavailable");
    expect(c.unsupported).toBe(true);
  });
  test("unknown/undefined → unsupported with a defined state", () => {
    const c = classifyAvailability(undefined);
    expect(c.unsupported).toBe(true);
    expect(c.state).toBe("unavailable");
  });
});

describe("joinTranscript", () => {
  test("joins final segments with single spaces", () => {
    expect(joinTranscript(["Hello", "world"])).toBe("Hello world");
  });
  test("trims and collapses whitespace", () => {
    expect(joinTranscript(["  my name is  ", "  Dave  "])).toBe("my name is Dave");
  });
  test("drops empty and non-string segments", () => {
    expect(joinTranscript(["a", "", null, undefined, "b", 3])).toBe("a b");
  });
  test("returns empty string for non-array input", () => {
    expect(joinTranscript(null)).toBe("");
    expect(joinTranscript(undefined)).toBe("");
    expect(joinTranscript("hello")).toBe("");
  });
  test("returns empty string for all-empty segments", () => {
    expect(joinTranscript(["  ", ""])).toBe("");
  });
});

describe("isSupported", () => {
  test("false when no SpeechRecognition constructor", () => {
    expect(isSupported({})).toBe(false);
  });
  test("false when constructor lacks processLocally on prototype", () => {
    function FakeSR() {}
    expect(isSupported({ SpeechRecognition: FakeSR })).toBe(false);
  });
  test("true when processLocally is present on the prototype", () => {
    function FakeSR() {}
    FakeSR.prototype.processLocally = false;
    expect(isSupported({ SpeechRecognition: FakeSR })).toBe(true);
  });
  test("recognizes the webkit-prefixed constructor", () => {
    function FakeSR() {}
    FakeSR.prototype.processLocally = false;
    expect(isSupported({ webkitSpeechRecognition: FakeSR })).toBe(true);
  });
});

describe("pickEngine", () => {
  test("prefers Web Speech when ready", () => {
    expect(pickEngine({ webSpeechReady: true, nanoReady: true })).toBe("webspeech");
  });
  test("falls back to Nano when Web Speech is not ready", () => {
    expect(pickEngine({ webSpeechReady: false, nanoReady: true })).toBe("nano");
  });
  test("returns null when nothing is ready", () => {
    expect(pickEngine({ webSpeechReady: false, nanoReady: false })).toBeNull();
  });
  test("handles missing input", () => {
    expect(pickEngine(null)).toBeNull();
    expect(pickEngine(undefined)).toBeNull();
  });
});

describe("cleanTranscript", () => {
  test("passes through a plain transcript", () => {
    expect(cleanTranscript("my tax file number is 123 456 789"))
      .toBe("my tax file number is 123 456 789");
  });
  test("strips a leading 'Transcription:' label", () => {
    expect(cleanTranscript("Transcription: hello there")).toBe("hello there");
    expect(cleanTranscript("transcript - hello")).toBe("hello");
  });
  test("strips a conversational preamble", () => {
    expect(cleanTranscript("Here's the transcription: hello")).toBe("hello");
    expect(cleanTranscript("Here is the transcription: hello")).toBe("hello");
  });
  test("strips a single layer of wrapping quotes", () => {
    expect(cleanTranscript('"hello world"')).toBe("hello world");
    expect(cleanTranscript("“hello”")).toBe("hello");
  });
  test("does not strip internal quotes", () => {
    expect(cleanTranscript('she said "hi" to me')).toBe('she said "hi" to me');
  });
  test("trims whitespace and handles non-strings", () => {
    expect(cleanTranscript("   spaced   ")).toBe("spaced");
    expect(cleanTranscript(null)).toBe("");
    expect(cleanTranscript(undefined)).toBe("");
    expect(cleanTranscript(42)).toBe("");
  });
});
