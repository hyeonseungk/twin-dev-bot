vi.mock("../i18n/index.js", () => ({
  t: vi.fn((key: string) => key),
}));

import { TEMPLATES, getTemplate, getTemplateListText } from "../templates.js";

describe("TEMPLATES", () => {
  it("contains expected keys", () => {
    const expectedKeys = [
      "react",
      "nextjs",
      "vue",
      "nuxt",
      "sveltekit",
      "angular",
      "react-native-expo",
      "react-native-bare",
      "flutter",
      "express",
      "nestjs",
      "fastify",
      "spring-boot",
      "django",
      "fastapi",
      "go",
      "rails",
      "laravel",
    ];

    for (const key of expectedKeys) {
      expect(TEMPLATES).toHaveProperty(key);
    }
  });

  it("each template has name, category, and scaffold", () => {
    for (const [key, template] of Object.entries(TEMPLATES)) {
      expect(template).toHaveProperty("name");
      expect(template).toHaveProperty("category");
      expect(template).toHaveProperty("scaffold");
      expect(typeof template.name).toBe("string");
      expect(["frontend", "backend"]).toContain(template.category);
      expect(typeof template.scaffold).toBe("function");
    }
  });

  it("scaffold returns string or async function", () => {
    for (const [key, template] of Object.entries(TEMPLATES)) {
      const result = template.scaffold("test-project");
      const isStringOrFunction =
        typeof result === "string" || typeof result === "function";
      expect(isStringOrFunction).toBe(true);
    }
  });

  it("cross-platform templates (fastapi, go, spring-boot) return async functions", () => {
    const crossPlatformKeys = ["fastapi", "go", "spring-boot"];
    for (const key of crossPlatformKeys) {
      const result = TEMPLATES[key].scaffold("test-project");
      expect(typeof result).toBe("function");
    }
  });

  it("npm/npx-based templates return strings", () => {
    const stringKeys = ["react", "nextjs", "vue", "express", "nestjs"];
    for (const key of stringKeys) {
      const result = TEMPLATES[key].scaffold("test-project");
      expect(typeof result).toBe("string");
    }
  });
});

describe("scaffold() rejects unsafe project names", () => {
  const unsafeNames = [
    "foo; rm -rf /",
    "$(whoami)",
    "name`id`",
    "a b",
    "../etc/passwd",
    "foo|cat /etc/passwd",
    "name&echo pwned",
    "",
  ];

  for (const [key, template] of Object.entries(TEMPLATES)) {
    for (const unsafeName of unsafeNames) {
      it(`${key}: throws for "${unsafeName}"`, () => {
        expect(() => template.scaffold(unsafeName)).toThrow(/Unsafe project name/);
      });
    }
  }

  it("allows valid project names", () => {
    for (const [key, template] of Object.entries(TEMPLATES)) {
      expect(() => template.scaffold("my-project")).not.toThrow();
      expect(() => template.scaffold("app_v2.0")).not.toThrow();
      expect(() => template.scaffold("MyApp123")).not.toThrow();
    }
  });
});

describe("getTemplate()", () => {
  it("returns template for known key", () => {
    const result = getTemplate("react");
    expect(result).toBeDefined();
    expect(result!.name).toBe("React (Vite + TypeScript)");
    expect(result!.category).toBe("frontend");
  });

  it("is case-insensitive", () => {
    const lower = getTemplate("react");
    const upper = getTemplate("React");
    const mixed = getTemplate("REACT");

    expect(lower).toBeDefined();
    expect(upper).toEqual(lower);
    expect(mixed).toEqual(lower);
  });

  it("returns undefined for unknown key", () => {
    expect(getTemplate("nonexistent")).toBeUndefined();
  });
});

describe("getTemplateListText()", () => {
  it("includes all category prefixes", () => {
    const text = getTemplateListText();
    expect(text).toContain("template.frontend");
    expect(text).toContain("template.backend");
  });

  it("includes all template keys", () => {
    const text = getTemplateListText();
    for (const key of Object.keys(TEMPLATES)) {
      expect(text).toContain(`\`${key}\``);
    }
  });
});
