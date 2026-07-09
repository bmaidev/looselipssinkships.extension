const { createVault, tokenize, restore, labelFor } = require("../lib/token-vault");

describe("labelFor", () => {
  test("uppercases and cleans a type id", () => {
    expect(labelFor("email")).toBe("EMAIL");
    expect(labelFor("bank_account")).toBe("BANK_ACCOUNT");
  });
  test("maps name ids to PERSON", () => {
    expect(labelFor("name_vector")).toBe("PERSON");
    expect(labelFor("name")).toBe("PERSON");
  });
  test("defaults to PII", () => {
    expect(labelFor("")).toBe("PII");
    expect(labelFor(undefined)).toBe("PII");
  });
});

describe("tokenize", () => {
  test("mints unique tokens per distinct value", () => {
    const r = tokenize("email a@x.com and b@y.com", [
      { original: "a@x.com", typeId: "email" },
      { original: "b@y.com", typeId: "email" },
    ]);
    expect(r.text).toBe("email [[EMAIL_1]] and [[EMAIL_2]]");
    expect(r.vault.byToken["[[EMAIL_1]]"]).toBe("a@x.com");
    expect(r.vault.byToken["[[EMAIL_2]]"]).toBe("b@y.com");
  });

  test("reuses the same token for a repeated value", () => {
    const r = tokenize("a@x.com writes to a@x.com", [
      { original: "a@x.com", typeId: "email" },
    ]);
    expect(r.text).toBe("[[EMAIL_1]] writes to [[EMAIL_1]]");
    expect(Object.keys(r.vault.byToken)).toHaveLength(1);
  });

  test("numbers per label independently", () => {
    const r = tokenize("John on a@x.com", [
      { original: "John", typeId: "name_vector" },
      { original: "a@x.com", typeId: "email" },
    ]);
    expect(r.text).toBe("[[PERSON_1]] on [[EMAIL_1]]");
  });

  test("is consistent across calls sharing a vault (cross-message)", () => {
    const v = createVault();
    const r1 = tokenize("first a@x.com", [{ original: "a@x.com", typeId: "email" }], v);
    const r2 = tokenize("again a@x.com and c@z.com", [
      { original: "a@x.com", typeId: "email" },
      { original: "c@z.com", typeId: "email" },
    ], v);
    expect(r1.text).toBe("first [[EMAIL_1]]");
    // a@x.com keeps EMAIL_1; the new value gets EMAIL_2.
    expect(r2.text).toBe("again [[EMAIL_1]] and [[EMAIL_2]]");
  });

  test("replaces longest-first so substrings don't shadow", () => {
    const r = tokenize("acc 123456789 and 1234", [
      { original: "1234", typeId: "bank_account" },
      { original: "123456789", typeId: "bank_account" },
    ]);
    // The 9-digit value must be tokenized as a whole, not partially eaten by 1234.
    expect(r.text).toContain("[[BANK_ACCOUNT_2]]");
    expect(r.text).not.toContain("123456789");
    expect(r.text.match(/\[\[BANK_ACCOUNT_/g)).toHaveLength(2);
  });

  test("returns text unchanged with no matches", () => {
    const r = tokenize("nothing here", []);
    expect(r.text).toBe("nothing here");
    expect(r.applied).toHaveLength(0);
  });

  test("ignores malformed matches", () => {
    const r = tokenize("a@x.com", [null, { typeId: "email" }, { original: "" }, { original: "a@x.com", typeId: "email" }]);
    expect(r.text).toBe("[[EMAIL_1]]");
  });
});

describe("restore", () => {
  test("round-trips tokenized text back to originals", () => {
    const original = "Call John Smith at 0491 570 110 or a@x.com";
    const matches = [
      { original: "John Smith", typeId: "name_vector" },
      { original: "0491 570 110", typeId: "phone_au" },
      { original: "a@x.com", typeId: "email" },
    ];
    const t = tokenize(original, matches);
    expect(t.text).not.toContain("John Smith");
    // Simulate the model echoing the placeholders in a reply.
    const modelReply = `I've noted ${t.vault.byOriginal["John Smith"]} (${t.vault.byOriginal["a@x.com"]}).`;
    const restored = restore(modelReply, t.vault);
    expect(restored).toBe("I've noted John Smith (a@x.com).");
  });

  test("leaves unknown tokens untouched", () => {
    const v = createVault();
    tokenize("a@x.com", [{ original: "a@x.com", typeId: "email" }], v);
    expect(restore("[[EMAIL_1]] and [[EMAIL_99]]", v)).toBe("a@x.com and [[EMAIL_99]]");
  });

  test("handles token prefix collisions (EMAIL_1 vs EMAIL_10)", () => {
    const v = createVault();
    // Force 10 distinct emails so EMAIL_1 and EMAIL_10 both exist.
    const matches = [];
    for (let i = 1; i <= 10; i++) matches.push({ original: `u${i}@x.com`, typeId: "email" });
    tokenize(matches.map((m) => m.original).join(" "), matches, v);
    const restored = restore("[[EMAIL_10]] then [[EMAIL_1]]", v);
    expect(restored).toBe("u10@x.com then u1@x.com");
  });

  test("returns input unchanged for an empty vault", () => {
    expect(restore("[[EMAIL_1]]", createVault())).toBe("[[EMAIL_1]]");
  });
});
