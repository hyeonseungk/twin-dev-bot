vi.mock("../core/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  initState,
  toggleOption,
  getSelectedOptions,
  getState,
  isOptionSelected,
  clearState,
} from "../stores/multi-select-state.js";

const PROJ = "test-proj";
const MSG = "msg-001";

const defaultOptions = [
  { label: "Option A" },
  { label: "Option B" },
  { label: "Option C" },
];

afterEach(() => {
  clearState(PROJ, MSG);
});

describe("initState", () => {
  it("initializes state for a new key", () => {
    initState({
      projectName: PROJ,
      messageId: MSG,
      options: defaultOptions,
      questionText: "Pick one",
    });

    const state = getState(PROJ, MSG);
    expect(state).not.toBeNull();
    expect(state!.options).toEqual(defaultOptions);
    expect(state!.questionText).toBe("Pick one");
  });

  it("skips initialization if key already exists", () => {
    initState({
      projectName: PROJ,
      messageId: MSG,
      options: defaultOptions,
      questionText: "First",
    });

    initState({
      projectName: PROJ,
      messageId: MSG,
      options: [{ label: "Different" }],
      questionText: "Second",
    });

    const state = getState(PROJ, MSG);
    expect(state!.questionText).toBe("First");
    expect(state!.options).toEqual(defaultOptions);
  });
});

describe("toggleOption", () => {
  beforeEach(() => {
    initState({
      projectName: PROJ,
      messageId: MSG,
      options: defaultOptions,
      questionText: "Pick",
    });
  });

  it("selects an option and returns true", () => {
    const result = toggleOption(PROJ, MSG, 0);
    expect(result).toBe(true);
    expect(isOptionSelected(PROJ, MSG, 0)).toBe(true);
  });

  it("deselects an already selected option and returns false", () => {
    toggleOption(PROJ, MSG, 1);
    const result = toggleOption(PROJ, MSG, 1);
    expect(result).toBe(false);
    expect(isOptionSelected(PROJ, MSG, 1)).toBe(false);
  });

  it("returns false if state is missing", () => {
    const result = toggleOption("no-proj", "no-msg", 0);
    expect(result).toBe(false);
  });
});

describe("getSelectedOptions", () => {
  beforeEach(() => {
    initState({
      projectName: PROJ,
      messageId: MSG,
      options: defaultOptions,
      questionText: "Pick",
    });
  });

  it("returns empty array initially", () => {
    expect(getSelectedOptions(PROJ, MSG)).toEqual([]);
  });

  it("returns sorted indexes of selected options", () => {
    toggleOption(PROJ, MSG, 2);
    toggleOption(PROJ, MSG, 0);
    expect(getSelectedOptions(PROJ, MSG)).toEqual([0, 2]);
  });

  it("returns empty array if state is missing", () => {
    expect(getSelectedOptions("no-proj", "no-msg")).toEqual([]);
  });
});

describe("getState", () => {
  it("returns state object when initialized", () => {
    initState({
      projectName: PROJ,
      messageId: MSG,
      options: defaultOptions,
      questionText: "Pick",
      header: "Header",
    });

    const state = getState(PROJ, MSG);
    expect(state).not.toBeNull();
    expect(state!.header).toBe("Header");
    expect(state!.selected).toBeInstanceOf(Set);
  });

  it("returns null if state is missing", () => {
    expect(getState("no-proj", "no-msg")).toBeNull();
  });
});

describe("isOptionSelected", () => {
  beforeEach(() => {
    initState({
      projectName: PROJ,
      messageId: MSG,
      options: defaultOptions,
      questionText: "Pick",
    });
  });

  it("returns true for selected option", () => {
    toggleOption(PROJ, MSG, 1);
    expect(isOptionSelected(PROJ, MSG, 1)).toBe(true);
  });

  it("returns false for unselected option", () => {
    expect(isOptionSelected(PROJ, MSG, 0)).toBe(false);
  });

  it("returns false if state is missing", () => {
    expect(isOptionSelected("no-proj", "no-msg", 0)).toBe(false);
  });
});

describe("clearState", () => {
  it("removes state", () => {
    initState({
      projectName: PROJ,
      messageId: MSG,
      options: defaultOptions,
      questionText: "Pick",
    });

    clearState(PROJ, MSG);
    expect(getState(PROJ, MSG)).toBeNull();
  });

  it("is no-op for missing state", () => {
    // Should not throw
    expect(() => clearState("no-proj", "no-msg")).not.toThrow();
  });
});
