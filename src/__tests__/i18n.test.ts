import { t, getCurrentLocale, type TranslationKey } from "../i18n/index.js";

describe("t()", () => {
  it("returns English text for known key when locale is en (default)", () => {
    expect(t("question.header")).toBe("Question");
  });

  it("replaces {{param}} placeholders", () => {
    expect(t("progress.completed", { elapsed: "15s" })).toBe(
      ":white_check_mark: Completed (15s)"
    );
  });

  it("does not double-substitute when param value contains {{key}} pattern", () => {
    // "runner.errorOccurred" template: "Error: {{error}}"
    const result = t("runner.errorOccurred", {
      error: "{{elapsed}} is not a path",
      elapsed: "LEAKED",
    });
    expect(result).toBe("Error: {{elapsed}} is not a path");
    expect(result).not.toContain("LEAKED");
  });

  it("returns key string when key not found", () => {
    expect(t("nonexistent.key.that.does.not.exist" as TranslationKey)).toBe(
      "nonexistent.key.that.does.not.exist",
    );
  });
});

describe("initLocale()", () => {
  it("defaults to 'en'", async () => {
    vi.resetModules();
    const { initLocale, getCurrentLocale: getLocale } = await import(
      "../i18n/index.js"
    );
    initLocale();
    expect(getLocale()).toBe("en");
  });
});

describe("getCurrentLocale()", () => {
  it("returns 'en' by default", () => {
    expect(getCurrentLocale()).toBe("en");
  });
});
