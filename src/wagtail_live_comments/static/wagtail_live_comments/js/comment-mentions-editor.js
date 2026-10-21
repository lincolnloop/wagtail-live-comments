/* @mentions in the Wagtail page editor's comments (same contract as live-page comments). */
(function (global) {
  const TEXTAREAS = ".comment__input, .comment__reply-input, .comment-reply__input";
  const COMMENT_TEXT = ".comments-list .comment__text";
  const HIGHLIGHT = "wagtail-live-comments-mention";

  function mentionsUrl(template, pathname) {
    const match = String(pathname || "").match(/\/pages\/(\d+)\/edit\//);
    return match && template ? template.replace("/0/", "/" + match[1] + "/") : "";
  }

  /** Text ranges of `tokens` inside `root` (text nodes only; no DOM changes). */
  function mentionRanges(doc, root, tokens) {
    const { findMentions } = global.WagtailLiveComments;
    const ranges = [];
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const { index, token } of findMentions(node.nodeValue, (t) => tokens.has(t))) {
        const range = doc.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + token.length);
        ranges.push(range);
      }
    }
    return ranges;
  }

  // Wagtail's comment textareas are React-controlled: set through the native
  // setter so React's onChange sees the new value on the next input event.
  function setReactValue(textarea, value) {
    const proto = Object.getPrototypeOf(textarea);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(textarea, value);
    } else {
      textarea.value = value;
    }
  }

  function boot(doc, fetchImpl) {
    const api = global.WagtailLiveComments;
    const configEl = doc.getElementById("wagtail-live-comments-mentions-config");
    if (!api || !configEl) {
      return null;
    }
    const config = JSON.parse(configEl.textContent || "{}");
    const url = mentionsUrl(config.mentionsUrlTemplate, doc.defaultView.location.pathname);
    if (!url) {
      return null; // Unsaved pages have no comments endpoint yet.
    }

    const picker = api.createMentionPicker({
      document: doc,
      fetch: fetchImpl,
      url,
      floating: true,
      setValue: setReactValue,
    });
    const isCommentTextarea = (el) =>
      Boolean(el && typeof el.matches === "function" && el.matches(TEXTAREAS));

    doc.addEventListener("input", (event) => {
      if (isCommentTextarea(event.target)) {
        picker.update(event.target);
      }
    });
    // Capture: Enter/Escape/arrows must not reach Wagtail's comment handlers
    // once the picker has used them.
    doc.addEventListener(
      "keydown",
      (event) => {
        if (isCommentTextarea(event.target)) {
          picker.onKeydown(event, event.target);
        }
      },
      true,
    );
    doc.addEventListener("focusout", (event) => {
      if (picker.isOpenFor(event.target)) {
        picker.close();
      }
    });
    // The editor scrolls and re-lays out comments while typing; keep the list
    // under its textarea (closing here would also drop the pending lookup).
    doc.addEventListener("scroll", () => picker.reposition(), true);

    const css = global.CSS;
    if (!css || !css.highlights || typeof global.Highlight !== "function") {
      return { picker };
    }

    // Which tokens are real mentions on this page, answered by the server.
    const resolved = new Set();
    const asked = new Set();
    let frame = null;

    async function resolve(tokens) {
      const fresh = tokens.filter((token) => !asked.has(token));
      if (!fresh.length) {
        return false;
      }
      fresh.forEach((token) => asked.add(token));
      const query = fresh.map((token) => ["tokens", token]);
      try {
        const response = await fetchImpl(api.withQuery(url, query), {
          credentials: "same-origin",
          headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
        });
        if (!response.ok) {
          return false;
        }
        const data = await response.json();
        (data.mentions || []).forEach((mention) => resolved.add(mention.token));
        return true;
      } catch {
        return false;
      }
    }

    function paint() {
      const roots = Array.from(doc.querySelectorAll(COMMENT_TEXT));
      const ranges = roots.flatMap((root) => mentionRanges(doc, root, resolved));
      css.highlights.set(HIGHLIGHT, new global.Highlight(...ranges));
      return roots;
    }

    async function refresh() {
      frame = null;
      const roots = paint();
      const seen = new Set();
      roots.forEach((root) => {
        for (const match of (root.textContent || "").matchAll(api.MENTION_RE)) {
          api.mentionTokenCandidates(match[0]).forEach((token) => seen.add(token));
        }
      });
      if (await resolve(Array.from(seen))) {
        paint();
      }
    }

    // Comments render (and re-render) inside React; repaint after changes.
    new MutationObserver(() => {
      if (frame === null) {
        frame = global.requestAnimationFrame(refresh);
      }
    }).observe(doc.body, { childList: true, subtree: true, characterData: true });
    refresh();

    return { picker };
  }

  global.WagtailLiveCommentsMentionsEditor = {
    mentionsUrl,
    mentionRanges,
    setReactValue,
    boot,
  };

  if (global.document && global.fetch) {
    const start = () => boot(global.document, global.fetch.bind(global));
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
