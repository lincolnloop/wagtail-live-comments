import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { describe, expect, it } from "bun:test";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "../../src/wagtail_live_comments/static/wagtail_live_comments/js/live-comments.js"),
  "utf8",
);

function loadApi() {
  const context = { window: {}, URLSearchParams };
  context.globalThis = context.window;
  vm.runInNewContext(source, context);
  return context.window.WagtailLiveComments;
}

describe("WagtailLiveComments helpers", () => {
  it("parses bootstrap JSON and eligible IDs", () => {
    const api = loadApi();
    const config = api.parseCommentConfig(
      JSON.stringify({
        pageId: 12,
        createUrl: "/cms/live-comments/pages/12/",
        eligibleBlockIds: ["aaa", "bbb"],
      }),
    );

    expect(config).toEqual({
      pageId: 12,
      createUrl: "/cms/live-comments/pages/12/",
      mentionsUrl: "",
      cssUrl: "",
      eligibleBlockIds: ["aaa", "bbb"],
      currentUser: "",
      currentAvatar: "",
      comments: {},
    });
    expect(api.parseCommentConfig("")).toBeNull();
  });

  it("reads config JSON from the userbar's shadow root", () => {
    const api = loadApi();
    const json = JSON.stringify({
      pageId: 9,
      createUrl: "/cms/live-comments/pages/9/",
      cssUrl: "/static/live-comments.css",
      eligibleBlockIds: ["abc"],
    });
    const shadowRoot = {
      querySelector(selector) {
        return selector === "#wagtail-live-comments-config" ? { textContent: json } : null;
      },
    };
    const doc = {
      querySelector(selector) {
        return selector === "wagtail-userbar" ? { shadowRoot, querySelector: () => null } : null;
      },
    };
    expect(api.findConfig(doc)).toEqual({
      pageId: 9,
      createUrl: "/cms/live-comments/pages/9/",
      mentionsUrl: "",
      cssUrl: "/static/live-comments.css",
      eligibleBlockIds: ["abc"],
      currentUser: "",
      currentAvatar: "",
      comments: {},
    });
  });

  it("adds the page stylesheet once", () => {
    const api = loadApi();
    const appended = [];
    const doc = {
      head: { appendChild: (el) => appended.push(el) },
      querySelector: () => (appended.length ? appended[0] : null),
      createElement: () => ({
        attrs: {},
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
      }),
    };
    api.ensureStylesheet(doc, "/static/live-comments.css");
    api.ensureStylesheet(doc, "/static/live-comments.css");
    expect(appended).toHaveLength(1);
    expect(appended[0].rel).toBe("stylesheet");
    expect(appended[0].href).toBe("/static/live-comments.css");
  });

  it("never picks our own UI (pins, popovers) as a block", () => {
    const api = loadApi();
    const block = { closest: (sel) => (sel === "[data-block-ids-ignore]" ? null : block) };
    const pinButton = {
      closest: (sel) => (sel === "[data-block-ids-ignore]" ? {} : block),
    };
    expect(api.closestSelectable(block)).toBe(block);
    expect(api.closestSelectable(pinButton)).toBeNull();
  });

  it("says when blocks are out of the latest draft", () => {
    const api = loadApi();
    expect(api.targetingMessage(3, 0)).toBe("Highlighted regions can receive a comment.");
    expect(api.targetingMessage(3, 1)).toBe(
      "Highlighted regions can receive a comment. 1 block isn't in the latest draft, so it can't.",
    );
    expect(api.targetingMessage(2, 29)).toContain("29 blocks aren't in the latest draft");
    expect(api.targetingMessage(0, 4)).toContain("Publish or revert the draft");
    expect(api.targetingMessage(0, 0)).toBe("No blocks on this page can receive a comment.");
  });

  it("boots after the page stylesheet loads, or fails to", () => {
    const api = loadApi();
    const calls = [];
    const listeners = {};
    const pending = {
      sheet: null,
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
    };
    api.afterStylesheet(pending, () => calls.push("pending"));
    expect(calls).toEqual([]);
    listeners.load();
    listeners.error();
    expect(calls).toEqual(["pending"]);
    api.afterStylesheet({ sheet: {} }, () => calls.push("loaded"));
    api.afterStylesheet(null, () => calls.push("none"));
    expect(calls).toEqual(["pending", "loaded", "none"]);
  });

  it("treats a non-JSON answer as an expired session", async () => {
    const api = loadApi();
    const html = { ok: false, status: 403, json: () => Promise.reject(new Error("HTML")) };
    expect(await api.readCommentResponse(html)).toEqual({
      ok: false,
      payload: {
        ok: false,
        error: "session",
        message: "Your session may have expired. Reload the page and try again.",
      },
    });
    const refused = { ok: false, json: () => Promise.resolve({ ok: false, error: "auth" }) };
    expect((await api.readCommentResponse(refused)).ok).toBe(false);
    const created = { ok: true, json: () => Promise.resolve({ ok: true, comment: {} }) };
    expect(await api.readCommentResponse(created)).toEqual({
      ok: true,
      payload: { ok: true, comment: {} },
    });
  });

  it("reads the csrftoken cookie", () => {
    const api = loadApi();
    expect(api.readCsrfToken("sessionid=x; csrftoken=token%2Fvalue")).toBe("token/value");
    expect(api.readCsrfToken("other=1")).toBe("");
  });

  it("treats only draft-eligible UUIDs as selectable", () => {
    const api = loadApi();
    const eligible = new Set(["keep-me"]);
    expect(api.isSelectableId("keep-me", eligible)).toBe(true);
    expect(api.isSelectableId("stale-live-id", eligible)).toBe(false);
    expect(api.isSelectableId("", eligible)).toBe(false);
  });

  it("prefers the server error message and falls back", () => {
    const api = loadApi();
    expect(
      api.errorMessageFromPayload(
        { message: "That block is not present on the latest draft." },
        "fallback",
      ),
    ).toBe("That block is not present on the latest draft.");
    expect(api.errorMessageFromPayload({}, "Couldn't save the comment. Try again.")).toBe(
      "Couldn't save the comment. Try again.",
    );
  });

  it("looks up a portaled popover by pin key", () => {
    const api = loadApi();
    const popover = { id: "pop" };
    const pin = {
      querySelector() {
        return null;
      },
      getAttribute(name) {
        return name === "data-live-page-comment-pin-key" ? "12" : null;
      },
    };
    const doc = {
      querySelector(selector) {
        return selector.includes('pin-key="12"') ? popover : null;
      },
    };
    expect(api.commentPopoverForPin(doc, pin)).toBe(popover);
  });

  it("clamps a click to a fraction of the block box", () => {
    const api = loadApi();
    const block = {
      getBoundingClientRect() {
        return { left: 100, top: 50, width: 200, height: 100 };
      },
    };
    expect(api.clickPositionInBlock({ clientX: 140, clientY: 70 }, block)).toEqual({
      x: 0.2,
      y: 0.2,
    });
    expect(api.commentPinPoint({ position: { x: 0.2, y: 0.2 } })).toEqual({ x: 0.2, y: 0.2 });
    expect(api.commentPinPoint({ position: null })).toBeNull();
    expect(api.commentPinPoint({})).toBeNull();
  });

  it("keeps server comment card fields including action URLs", () => {
    const api = loadApi();
    const comments = {
      "block-1": [
        {
          id: 12,
          text: "Hello",
          position: { x: 0.2, y: 0.15 },
          replyUrl: "/cms/live-comments/pages/9/comments/12/replies/",
          editUrl: "/cms/live-comments/pages/9/comments/12/edit/",
          deleteUrl: "/cms/live-comments/pages/9/comments/12/delete/",
          resolveUrl: "/cms/live-comments/pages/9/comments/12/resolve/",
          editorUrl: "/cms/pages/9/edit/#block-aaaa-section",
          replies: [
            {
              id: 3,
              text: "Reply",
              editUrl: "/cms/live-comments/pages/9/comments/12/replies/3/edit/",
              deleteUrl: "/cms/live-comments/pages/9/comments/12/replies/3/delete/",
            },
          ],
        },
      ],
    };
    const config = api.parseCommentConfig(
      JSON.stringify({
        pageId: 9,
        createUrl: "/cms/live-comments/pages/9/",
        eligibleBlockIds: ["block-1"],
        comments,
      }),
    );
    expect(config.comments).toEqual(comments);
  });

  it("places a pin at the comment's x/y fractions", () => {
    const api = loadApi();
    const styleVars = {};
    const pinAttrs = {};
    const appendedToRoot = [];
    const popoverLayerChildren = [];
    const root = {
      attrs: { "data-block-id": "block-1" },
      getAttribute(name) {
        return this.attrs[name];
      },
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      hasAttribute(name) {
        return Object.hasOwn(this.attrs, name);
      },
      querySelectorAll(selector) {
        return selector === "[data-live-page-comment-pin]" ? [] : [];
      },
      appendChild(el) {
        appendedToRoot.push(el);
      },
    };
    const popoverLayer = {
      id: "live-page-comment-popovers",
      appendChild(el) {
        popoverLayerChildren.push(el);
      },
    };
    const doc = {
      body: {},
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "[data-block-id]") {
          return [root];
        }
        if (selector === "[data-live-page-comment-host]") {
          return [];
        }
        return [];
      },
      getElementById(id) {
        return id === "live-page-comment-popovers" ? popoverLayer : null;
      },
      createElement(tag) {
        const el = {
          tagName: String(tag).toUpperCase(),
          className: "",
          hidden: false,
          innerHTML: "",
          attrs: {},
          style: {
            setProperty(name, value) {
              styleVars[name] = value;
            },
          },
          setAttribute(name, value) {
            this.attrs[name] = value;
            pinAttrs[name] = value;
          },
          getAttribute(name) {
            return this.attrs[name];
          },
          querySelector(sel) {
            if (
              sel === "[data-live-page-comment-pill]" &&
              this.innerHTML.includes("data-live-page-comment-pill")
            ) {
              return {
                style: { setProperty() {} },
                setAttribute() {},
              };
            }
            return null;
          },
        };
        return el;
      },
    };
    api.renderCommentPins(doc, {
      "block-1": [
        {
          id: 12,
          text: "Hi",
          position: { x: 0.2, y: 0.15 },
          editorUrl: "/cms/pages/9/edit/#block-aaaa-section",
          replies: [],
        },
      ],
    });
    expect(pinAttrs["data-live-page-comment-pin-placed"]).toBe("");
    expect(styleVars["--live-page-comment-x"]).toBe("20.00%");
    expect(styleVars["--live-page-comment-y"]).toBe("15.00%");
    expect(appendedToRoot).toHaveLength(1);
    expect(popoverLayerChildren).toHaveLength(1);
    expect(popoverLayerChildren[0].innerHTML).toContain("Go to block");
    expect(popoverLayerChildren[0].innerHTML).toContain(
      'href="/cms/pages/9/edit/#block-aaaa-section"',
    );
    expect(popoverLayerChildren[0].innerHTML).toContain('data-live-page-comment-action="link"');
    expect(pinAttrs.id).toBe("live-page-comment-12");
  });

  it("builds a live-page comment permalink from the current location", () => {
    const api = loadApi();
    expect(
      api.commentPermalink(
        { origin: "http://localhost:8000", pathname: "/about/", search: "" },
        12,
      ),
    ).toBe("http://localhost:8000/about/#live-page-comment-12");
    expect(
      api.commentPermalink(
        {
          origin: "http://localhost:8000",
          pathname: "/p/",
          search: "?preview=1",
        },
        "12",
      ),
    ).toBe("http://localhost:8000/p/?preview=1#live-page-comment-12");
    expect(api.commentPermalink({ origin: "http://x", pathname: "/" }, "")).toBe("");
  });

  it("reads a comment id from a live-page comment hash", () => {
    const api = loadApi();
    expect(api.commentIdFromHash("#live-page-comment-12")).toBe("12");
    expect(api.commentIdFromHash("live-page-comment-12")).toBe("12");
    expect(api.commentIdFromHash("#section")).toBe("");
    expect(api.commentIdFromHash("")).toBe("");
  });

  it("renders a Go to block link from the comment editorUrl", () => {
    const api = loadApi();
    expect(api.commentEditorLinkHtml("")).toBe("");
    expect(api.commentEditorLinkHtml(null)).toBe("");
    const html = api.commentEditorLinkHtml("/cms/pages/9/edit/#block-aaaa-section");
    expect(html).toContain("Go to block");
    expect(html).toContain('href="/cms/pages/9/edit/#block-aaaa-section"');
    expect(html).toContain("comment__button--goto-block");
  });

  it("does not build comment action URLs by concatenating createUrl", () => {
    expect(source).not.toContain('+ "comments/"');
  });

  it("treats Cmd/Ctrl+Enter as a comment form submit chord", () => {
    const api = loadApi();
    expect(api.isCommentSubmitChord({ key: "Enter", metaKey: true })).toBe(true);
    expect(api.isCommentSubmitChord({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(api.isCommentSubmitChord({ key: "Enter" })).toBe(false);
    expect(api.isCommentSubmitChord({ key: "Enter", shiftKey: true })).toBe(false);
    expect(api.isCommentSubmitChord({ key: "Escape", metaKey: true })).toBe(false);
  });

  it("finds the comment form wrapping a textarea", () => {
    const api = loadApi();
    const form = { name: "create" };
    const textarea = {
      tagName: "TEXTAREA",
      closest(sel) {
        return sel === "[data-live-page-comment-form]" ? form : null;
      },
    };
    expect(api.commentFormFromKeyTarget(textarea)).toBe(form);
    expect(
      api.commentFormFromKeyTarget({
        tagName: "INPUT",
        closest() {
          return form;
        },
      }),
    ).toBeNull();
  });

  it("submits the wrapping comment form on Cmd+Enter", () => {
    const api = loadApi();
    const submitted = [];
    const form = {
      requestSubmit() {
        submitted.push("requestSubmit");
      },
    };
    const event = {
      key: "Enter",
      metaKey: true,
      preventDefault() {
        submitted.push("preventDefault");
      },
      target: {
        tagName: "TEXTAREA",
        closest(sel) {
          return sel === "[data-live-page-comment-reply-form]" ? form : null;
        },
      },
    };
    expect(api.submitCommentFormFromKeydown(event)).toBe(true);
    expect(submitted).toEqual(["preventDefault", "requestSubmit"]);
  });

  it("focuses the reply input in an opened popover", () => {
    const api = loadApi();
    const focused = [];
    const input = {
      focus() {
        focused.push("reply");
      },
    };
    expect(
      api.focusPopoverReplyInput({
        querySelector(sel) {
          return sel === ".comment__reply-input" ? input : null;
        },
      }),
    ).toBe(true);
    expect(focused).toEqual(["reply"]);
    expect(api.focusPopoverReplyInput(null)).toBe(false);
    expect(api.focusPopoverReplyInput({ querySelector: () => null })).toBe(false);
  });

  it("recognizes the popover Cancel button as a close action", () => {
    const api = loadApi();
    const cancel = { name: "cancel" };
    expect(
      api.isPopoverCancelTarget({
        closest(sel) {
          return sel === "[data-live-page-comment-reply-cancel]" ? cancel : null;
        },
      }),
    ).toBe(true);
    expect(
      api.isPopoverCancelTarget({
        closest() {
          return null;
        },
      }),
    ).toBe(false);
  });

  it("only rebuilds pins for the blocks it is asked to refresh", () => {
    const api = loadApi();
    const touched = [];
    function blockRoot(id) {
      return {
        attrs: { "data-block-id": id },
        getAttribute(name) {
          return this.attrs[name];
        },
        hasAttribute(name) {
          return name in this.attrs;
        },
        setAttribute(name, value) {
          this.attrs[name] = value;
        },
        removeAttribute(name) {
          delete this.attrs[name];
        },
        querySelectorAll() {
          touched.push(id);
          return [];
        },
        appendChild() {},
      };
    }
    const roots = [blockRoot("block-1"), blockRoot("block-2")];
    const layer = { appendChild() {} };
    const doc = {
      querySelector() {
        return null;
      },
      querySelectorAll(selector) {
        if (selector === "[data-block-id]") {
          return roots;
        }
        if (selector === "[data-live-page-comment-host]") {
          return roots.filter((root) => root.hasAttribute("data-live-page-comment-host"));
        }
        return [];
      },
      getElementById(id) {
        return id === "live-page-comment-popovers" ? layer : null;
      },
      createElement() {
        return {
          attrs: {},
          style: { setProperty() {} },
          setAttribute(name, value) {
            this.attrs[name] = value;
          },
          querySelector() {
            return null;
          },
        };
      },
    };
    const comments = {
      "block-1": [{ id: 1, text: "One", replies: [] }],
      "block-2": [{ id: 2, text: "Two", replies: [] }],
    };
    api.renderCommentPins(doc, comments);
    touched.length = 0;

    api.renderCommentPins(doc, comments, ["block-2"]);

    expect(touched).toEqual(["block-2"]);
  });

  it("wraps resolved mentions and escapes everything else", () => {
    const api = loadApi();
    const html = api.renderCommentText("<b>Hi</b> @ana and @[Content Editors]. @anabel", [
      { type: "user", id: 1, label: "Ana", token: "@ana" },
      { type: "group", id: 2, label: "Content Editors", token: "@[Content Editors]" },
    ]);

    expect(html.startsWith("&lt;b&gt;Hi&lt;/b&gt; ")).toBe(true);
    expect(html).toContain('data-mention-type="user">@ana</span> and ');
    expect(html).toContain('data-mention-type="group">@[Content Editors]</span>. @anabel');
    expect(html.match(/data-mention-type=/g)).toHaveLength(2);
  });

  it("ends mentions where the server's grammar does", () => {
    const api = loadApi();
    const mentions = [{ type: "user", id: 1, label: "Ana", token: "@ana" }];
    const highlighted = (text) =>
      (api.renderCommentText(text, mentions).match(/data-mention-type=/g) || []).length;

    expect(highlighted("ping @ana-")).toBe(1);
    expect(highlighted("ping @ana.bob")).toBe(0);
    expect(highlighted("ping @anaé")).toBe(0);
    expect(highlighted("ping é@ana")).toBe(0);
  });

  it("adds query params to URLs with or without a query string", () => {
    const api = loadApi();

    expect(api.withQuery("/m/", { q: "a b" })).toBe("/m/?q=a+b");
    expect(api.withQuery("/m/?x=1", [["tokens", "@[A]"]])).toBe("/m/?x=1&tokens=%40%5BA%5D");
  });

  it("does not highlight unresolved or email-like @ text", () => {
    const api = loadApi();
    const mentions = [{ type: "user", id: 1, label: "Ana", token: "@ana" }];

    expect(api.renderCommentText("mail ana@ana.org or @bob", mentions)).toBe(
      "mail ana@ana.org or @bob",
    );
    expect(api.renderCommentText("Thanks @ana.", mentions)).toContain(
      'data-mention-type="user">@ana</span>.',
    );
    expect(api.renderCommentText("<i>@x</i>", [])).toBe("&lt;i&gt;@x&lt;/i&gt;");
  });

  it("finds the @query being typed before the caret", () => {
    const api = loadApi();

    expect(api.mentionQueryAt("Hi @an", 6)).toEqual({ start: 3, query: "an" });
    expect(api.mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(api.mentionQueryAt("Ask @[Content Ed", 16)).toEqual({
      start: 4,
      query: "Content Ed",
    });
    expect(api.mentionQueryAt("mail ana@ex", 11)).toBeNull();
    expect(api.mentionQueryAt("Hi @ana done", 12)).toBeNull();
  });

  it("inserts the chosen token in place of the typed query", () => {
    const api = loadApi();

    expect(api.insertMention("Hi @an please", 3, 6, "@ana.silva")).toEqual({
      value: "Hi @ana.silva please",
      caret: 13,
    });
    expect(api.insertMention("Hi @[Con", 3, 8, "@[Content Editors]")).toEqual({
      value: "Hi @[Content Editors] ",
      caret: 22,
    });
  });
});
