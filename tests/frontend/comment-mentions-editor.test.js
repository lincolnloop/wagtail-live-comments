import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, expect, it } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(
    here,
    "../../src/wagtail_live_comments/static/wagtail_live_comments/js/comment-mentions-editor.js",
  ),
  "utf8",
);

function loadApi() {
  const context = { window: {} };
  context.globalThis = context.window;
  vm.runInNewContext(source, context);
  return context.window.WagtailLiveCommentsMentionsEditor;
}

describe("WagtailLiveCommentsMentionsEditor", () => {
  it("builds the page's candidates URL from the editor path", () => {
    const api = loadApi();
    const template = "/cms/live-comments/pages/0/mention-candidates/";

    expect(api.mentionsUrl(template, "/cms/pages/42/edit/")).toBe(
      "/cms/live-comments/pages/42/mention-candidates/",
    );
    expect(api.mentionsUrl(template, "/cms/pages/add/home/standardpage/3/")).toBe("");
  });

  it("sets textarea values through the prototype setter React tracks", () => {
    const api = loadApi();
    const calls = [];
    const proto = {};
    Object.defineProperty(proto, "value", {
      set(value) {
        calls.push(value);
      },
      configurable: true,
    });
    const textarea = Object.create(proto);
    Object.defineProperty(textarea, "value", {
      set() {
        throw new Error("own value setter must not be used");
      },
    });

    api.setReactValue(textarea, "@[Reviewers] ");

    expect(calls).toEqual(["@[Reviewers] "]);
  });

  it("ignores the picker's own DOM changes but not comment text changes", () => {
    const api = loadApi();
    function element(inPicker) {
      return {
        nodeType: 1,
        closest(selector) {
          return inPicker && selector === ".live-page-comment-mentions" ? this : null;
        },
      };
    }
    const body = element(false);
    const list = element(true);
    const comment = element(false);
    const pickerText = { nodeType: 3, parentElement: list };

    expect(
      api.isPickerMutation({
        type: "childList",
        target: body,
        addedNodes: [list],
        removedNodes: [],
      }),
    ).toBe(true);
    expect(
      api.isPickerMutation({
        type: "childList",
        target: list,
        addedNodes: [],
        removedNodes: [comment],
      }),
    ).toBe(true);
    expect(
      api.isPickerMutation({
        type: "characterData",
        target: pickerText,
        addedNodes: [],
        removedNodes: [],
      }),
    ).toBe(true);
    expect(
      api.isPickerMutation({
        type: "childList",
        target: body,
        addedNodes: [comment],
        removedNodes: [],
      }),
    ).toBe(false);
    expect(
      api.isPickerMutation({
        type: "characterData",
        target: { nodeType: 3, parentElement: comment },
        addedNodes: [],
        removedNodes: [],
      }),
    ).toBe(false);
  });
});
