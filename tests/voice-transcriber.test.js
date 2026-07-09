const {
  DEFAULT_LANG,
  normalizeLang,
  classifyAvailability,
  joinTranscript,
  isSupported,
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
