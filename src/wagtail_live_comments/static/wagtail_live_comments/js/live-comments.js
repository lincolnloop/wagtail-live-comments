/* Live-page comment targeting: userbar entry, block highlight, modal create. */
(function (global) {
  const SELECTABLE = "[data-block-id][data-commentable]";
  const UNAVAILABLE = "[data-block-id][data-comment-unavailable]";
  // Page modes that highlight blocks (live comments, inspect) are exclusive: each
  // announces itself on the document and turns off when another one turns on.
  // Contract documented in wagtail-block-ids.
  const MODE_ON_EVENT = "wagtail-block-ids:mode-on";
  const MODE_SOURCE = "wagtail-live-comments";
  // Our own UI on the page (pins, popovers): block modes ignore hovers and clicks
  // on it, so it is never highlighted or picked as a block. Same contract.
  const IGNORE_ATTR = "data-block-ids-ignore";
  const UNAVAILABLE_HINT =
    "Not in the latest draft. Publish or revert the draft to comment on this block.";
  const CONFIG_ID = "wagtail-live-comments-config";
  const STYLESHEET_ATTR = "data-wagtail-live-comments-css";
  const SUCCESS_MESSAGE = "Comment added.";
  const NETWORK_MESSAGE = "Couldn't save the comment. Try again.";
  const SESSION_MESSAGE = "Your session may have expired. Reload the page and try again.";

  function log(step, detail) {
    if (
      !global.WagtailLiveCommentsDebug ||
      typeof console === "undefined" ||
      typeof console.info !== "function"
    ) {
      return;
    }
    if (detail === undefined) {
      console.info("[live-page-comments]", step);
      return;
    }
    console.info("[live-page-comments]", step, detail);
  }

  function parseCommentConfig(text) {
    if (!text || !String(text).trim()) {
      return null;
    }
    const data = JSON.parse(text);
    if (!data || typeof data !== "object") {
      return null;
    }
    const eligible = Array.isArray(data.eligibleBlockIds) ? data.eligibleBlockIds.map(String) : [];
    const comments =
      data.comments && typeof data.comments === "object" && !Array.isArray(data.comments)
        ? data.comments
        : {};
    return {
      pageId: data.pageId,
      createUrl: data.createUrl,
      mentionsUrl: typeof data.mentionsUrl === "string" ? data.mentionsUrl : "",
      cssUrl: typeof data.cssUrl === "string" ? data.cssUrl : "",
      eligibleBlockIds: eligible,
      currentUser: typeof data.currentUser === "string" ? data.currentUser : "",
      currentAvatar: typeof data.currentAvatar === "string" ? data.currentAvatar : "",
      comments,
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Same grammar as _MENTION_RE in wagtail_live_comments/mentions.py (Python's \w is
  // Unicode): "@username" or "@[Group name]", not after a word character or "@".
  const MENTION_RE = /(?<![\p{L}\p{N}_@])@(?:\[[^\]\n]{1,150}\]|[\p{L}\p{N}_.@+-]{1,150})/gu;

  /** Tokens a raw match may resolve to: as typed, then without a trailing "." / "-". */
  function mentionTokenCandidates(raw) {
    if (raw.endsWith("]")) {
      return [raw];
    }
    const trimmed = raw.replace(/[.-]+$/, "");
    return trimmed === raw ? [raw] : [raw, trimmed];
  }

  /** `{index, token}` for each resolved mention in `text` (mirrors mentions_in). */
  function findMentions(text, isResolved) {
    const found = [];
    for (const match of String(text || "").matchAll(MENTION_RE)) {
      const token = mentionTokenCandidates(match[0]).find(isResolved);
      if (token) {
        found.push({ index: match.index, token });
      }
    }
    return found;
  }

  /** Escaped comment text with server-resolved @mentions wrapped for styling. */
  function renderCommentText(text, mentions) {
    const raw = String(text || "");
    const list = Array.isArray(mentions) ? mentions.filter((m) => m && m.token) : [];
    const byToken = new Map(list.map((m) => [String(m.token), m]));
    let html = "";
    let index = 0;
    for (const { index: at, token } of findMentions(raw, (t) => byToken.has(t))) {
      html +=
        escapeHtml(raw.slice(index, at)) +
        '<span class="live-page-comment-mention" data-mention-type="' +
        escapeHtml(byToken.get(token).type || "") +
        '">' +
        escapeHtml(token) +
        "</span>";
      index = at + token.length;
    }
    return html + escapeHtml(raw.slice(index));
  }

  /** `url` with `params` added to its query string. */
  function withQuery(url, params) {
    const query = new URLSearchParams(params).toString();
    return url + (url.includes("?") ? "&" : "?") + query;
  }

  /** Parsed JSON from a same-origin admin GET, or `null` on a non-2xx answer. */
  async function getJson(fetchImpl, url) {
    const response = await fetchImpl(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
    });
    return response.ok ? response.json() : null;
  }

  /** The "@query" being typed just before the caret, if any. */
  function mentionQueryAt(value, caret) {
    const before = String(value || "").slice(0, caret);
    const match = before.match(/(?:^|[\s(])@(\[[^\]\n]{0,60}|[\w.+-]{0,60})$/);
    if (!match) {
      return null;
    }
    const typed = match[1];
    return { start: caret - typed.length - 1, query: typed.replace(/^\[/, "") };
  }

  /** Replace the "@query" at [start, caret) with `token` and a trailing space. */
  function insertMention(value, start, caret, token) {
    const text = String(value || "");
    const after = text.slice(caret);
    const spacer = /^\s/.test(after) ? "" : " ";
    return {
      value: text.slice(0, start) + token + spacer + after,
      caret: start + token.length + spacer.length,
    };
  }

  function formatCommentTime(value) {
    if (!value) {
      return "";
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  const COMMENT_ICON =
    '<svg class="live-page-comment-pill__icon" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M8 1.313C3.84 1.313.5 4.037.5 7.405c0 1.436.645 2.784 1.67 3.809-.352 1.494-1.582 2.812-1.582 2.812-.088.059-.088.176-.059.264a.22.22 0 0 0 .205.146c1.963 0 3.37-.937 4.131-1.523.967.352 2.022.586 3.135.586 4.16 0 7.47-2.754 7.47-6.094 0-3.34-3.34-6.093-7.47-6.093Zm-3.78 7.03a.944.944 0 0 1-.937-.937c0-.468.41-.937.938-.937.498 0 .937.44.937.937 0 .528-.41.938-.937.938Zm3.78 0a.944.944 0 0 1-.938-.937c0-.468.44-.937.938-.937.469 0 .908.44.908.937A.92.92 0 0 1 8 8.344Zm3.72 0a.944.944 0 0 1-.937-.937c0-.468.41-.937.938-.937.498 0 .937.44.937.937 0 .528-.41.938-.937.938Z"></path></svg>';

  function readCsrfToken(cookieSource) {
    const source = cookieSource == null ? "" : String(cookieSource);
    const match = source.match(/(?:^|; )csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  // Comments attach to the latest draft, so rendered blocks the draft dropped
  // can't take one. Say so, rather than leaving them silently inert.
  function targetingMessage(selectableCount, unavailableCount) {
    if (!selectableCount) {
      return unavailableCount
        ? "No blocks on this page are in the latest draft, so none can receive a comment. Publish or revert the draft to comment here."
        : "No blocks on this page can receive a comment.";
    }
    const base = "Highlighted regions can receive a comment.";
    if (!unavailableCount) {
      return base;
    }
    const blocks = unavailableCount === 1 ? "1 block isn't" : unavailableCount + " blocks aren't";
    return (
      base +
      " " +
      blocks +
      " in the latest draft, so " +
      (unavailableCount === 1 ? "it" : "they") +
      " can't."
    );
  }

  function isSelectableId(blockId, eligibleIds) {
    return Boolean(blockId) && eligibleIds.has(String(blockId));
  }

  // CSRF failures and an expired admin session answer with HTML, not the JSON
  // contract; report those as a session error the editor can fix by reloading.
  async function readCommentResponse(response) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== "object") {
      return {
        ok: false,
        payload: { ok: false, error: "session", message: SESSION_MESSAGE },
      };
    }
    return { ok: response.ok && payload.ok !== false, payload };
  }

  function errorMessageFromPayload(payload, fallback) {
    if (payload && typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
    return fallback;
  }

  const COMMENT_HASH_PREFIX = "live-page-comment-";

  function commentHashId(commentId) {
    if (commentId == null || String(commentId).trim() === "") {
      return "";
    }
    return COMMENT_HASH_PREFIX + String(commentId);
  }

  function commentPermalink(loc, commentId) {
    const hashId = commentHashId(commentId);
    if (!hashId || !loc) {
      return "";
    }
    return (
      String(loc.origin || "") +
      String(loc.pathname || "") +
      String(loc.search || "") +
      "#" +
      hashId
    );
  }

  function commentIdFromHash(hash) {
    const text = String(hash || "").replace(/^#/, "");
    if (!text.startsWith(COMMENT_HASH_PREFIX)) {
      return "";
    }
    return text.slice(COMMENT_HASH_PREFIX.length);
  }

  function copyTextToClipboard(text, clipboard) {
    if (!text || !clipboard || typeof clipboard.writeText !== "function") {
      return Promise.resolve(false);
    }
    return clipboard.writeText(text).then(
      function () {
        return true;
      },
      function () {
        return false;
      },
    );
  }

  function isCommentSubmitChord(event) {
    return Boolean(event && event.key === "Enter" && (event.metaKey || event.ctrlKey));
  }

  function commentFormFromKeyTarget(target) {
    if (!target || typeof target.closest !== "function") {
      return null;
    }
    if (String(target.tagName).toUpperCase() !== "TEXTAREA") {
      return null;
    }
    return (
      target.closest("[data-live-page-comment-form]") ||
      target.closest("[data-live-page-comment-reply-form]") ||
      target.closest("[data-live-page-comment-edit-form]")
    );
  }

  function submitCommentFormFromKeydown(event) {
    if (!isCommentSubmitChord(event)) {
      return false;
    }
    const form = commentFormFromKeyTarget(event.target);
    if (!form) {
      return false;
    }
    if (typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (typeof form.requestSubmit === "function") {
      try {
        form.requestSubmit();
        return true;
      } catch {
        // Disabled submitter (empty reply) still needs a submit event.
      }
    }
    if (typeof form.dispatchEvent === "function") {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    return true;
  }

  function isPopoverCancelTarget(target) {
    return Boolean(
      target &&
      typeof target.closest === "function" &&
      target.closest("[data-live-page-comment-reply-cancel]"),
    );
  }

  function focusPopoverReplyInput(popover) {
    if (!popover || typeof popover.querySelector !== "function") {
      return false;
    }
    const input =
      popover.querySelector("[data-live-page-comment-edit-form] textarea") ||
      popover.querySelector(".comment__reply-input");
    if (!input || typeof input.focus !== "function") {
      return false;
    }
    input.focus();
    return true;
  }

  function closestSelectable(target) {
    const el =
      target && typeof target.closest === "function" ? target : target && target.parentElement;
    if (!el || typeof el.closest !== "function" || el.closest("[" + IGNORE_ATTR + "]")) {
      return null;
    }
    return el.closest(SELECTABLE);
  }

  function queryInRoots(selector, roots) {
    for (const root of roots) {
      if (!root || typeof root.querySelector !== "function") {
        continue;
      }
      const found = root.querySelector(selector);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function userbarRoots(doc) {
    const host = doc.querySelector("wagtail-userbar");
    const roots = [];
    if (host && host.shadowRoot) {
      roots.push(host.shadowRoot);
    }
    if (host) {
      roots.push(host);
    }
    roots.push(doc);
    return roots;
  }

  /** First element on the page for each block id: one scan, however many blocks. */
  function blockRootsById(doc) {
    const roots = new Map();
    doc.querySelectorAll("[data-block-id]").forEach((el) => {
      const id = el.getAttribute("data-block-id");
      if (!roots.has(id)) {
        roots.set(id, el);
      }
    });
    return roots;
  }

  function commentItemsForBlock(comments, blockId) {
    const items = comments && comments[blockId];
    return Array.isArray(items) ? items : [];
  }

  function commentPinPoint(item) {
    const position = item && item.position;
    if (!position) {
      return null;
    }
    const x = Number(position.x);
    const y = Number(position.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return null;
    }
    return { x, y };
  }

  function clickPositionInBlock(event, block) {
    if (!event || !block || typeof block.getBoundingClientRect !== "function") {
      return null;
    }
    const rect = block.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return {
      x: Math.min(0.98, Math.max(0.02, x)),
      y: Math.min(0.98, Math.max(0.02, y)),
    };
  }

  function commentPinKey(blockId, item, index) {
    return String(item && item.id != null ? item.id : blockId + "-" + index);
  }

  function commentPopoverLayer(doc) {
    let layer = doc.getElementById("live-page-comment-popovers");
    if (layer) {
      return layer;
    }
    layer = doc.createElement("div");
    layer.id = "live-page-comment-popovers";
    if (doc.body) {
      doc.body.appendChild(layer);
    }
    return layer;
  }

  function commentPopoverForKey(doc, pinKey) {
    if (!pinKey) {
      return null;
    }
    return doc.querySelector(
      '[data-live-page-comment-popover][data-live-page-comment-pin-key="' + pinKey + '"]',
    );
  }

  /** Popovers live in the page-level layer, not in their pin: find them by pin key. */
  function commentPopoverForPin(doc, pin) {
    return pin
      ? commentPopoverForKey(doc, pin.getAttribute("data-live-page-comment-pin-key"))
      : null;
  }

  function removeCommentPin(doc, pin) {
    const key = pin.getAttribute("data-live-page-comment-pin-key");
    pin.remove();
    const popover = commentPopoverForKey(doc, key);
    if (popover) {
      popover.remove();
    }
  }

  const DOTS_ICON =
    '<svg class="icon icon-dots-horizontal" viewBox="0 0 16 16" aria-hidden="true">' +
    '<circle cx="3" cy="8" r="1.5"></circle>' +
    '<circle cx="8" cy="8" r="1.5"></circle>' +
    '<circle cx="13" cy="8" r="1.5"></circle></svg>';

  function renderCommentHeader(item, options) {
    const when = formatCommentTime(item.createdAt);
    const avatar = item.avatar
      ? '<img class="comment-header__avatar" src="' +
        escapeHtml(item.avatar) +
        '" alt="" decoding="async" loading="lazy">'
      : "";
    const canEdit = Boolean(item.mine);
    const canResolve = Boolean(options && options.canResolve);
    const permalink = Boolean(options && options.permalink);
    const actions = [];
    if (permalink) {
      actions.push(
        '<button type="button" role="menuitem" data-live-page-comment-action="link">Link</button>',
      );
    }
    if (canEdit) {
      actions.push(
        '<button type="button" role="menuitem" data-live-page-comment-action="edit">Edit</button>',
      );
      actions.push(
        '<button type="button" role="menuitem" data-live-page-comment-action="delete">Delete</button>',
      );
    }
    if (canResolve) {
      actions.push(
        '<button type="button" role="menuitem" data-live-page-comment-action="resolve">Resolve</button>',
      );
    }
    const menu = actions.length
      ? '<div class="comment-header__actions">' +
        '<div class="comment-header__action comment-header__action--more">' +
        "<details>" +
        '<summary aria-label="More actions" aria-haspopup="menu" role="button">' +
        DOTS_ICON +
        "</summary>" +
        '<div class="comment-header__more-actions" role="menu">' +
        actions.join("") +
        "</div></details></div></div>"
      : "";
    return (
      '<div class="comment-header">' +
      menu +
      avatar +
      '<span><p class="comment-header__author">' +
      escapeHtml(item.author || "") +
      "</p>" +
      (when
        ? '<p class="comment-header__date"><time datetime="' +
          escapeHtml(item.createdAt) +
          '">' +
          escapeHtml(when) +
          "</time></p>"
        : "") +
      "</span></div>"
    );
  }

  function renderEditForm(text, inputClass) {
    return (
      "<form data-live-page-comment-edit-form>" +
      '<textarea rows="1" class="' +
      inputClass +
      '" name="text">' +
      escapeHtml(text || "") +
      "</textarea>" +
      '<div class="comment__actions">' +
      '<button type="submit" class="button comment__button comment__button--primary">Save</button>' +
      '<button type="button" class="button button-secondary comment__button" data-live-page-comment-mode="default">Cancel</button>' +
      "</div></form>"
    );
  }

  function commentEditorLinkHtml(url) {
    const href = String(url || "").trim();
    if (!href) {
      return "";
    }
    return (
      '<a class="button button-secondary comment__button comment__button--goto-block" href="' +
      escapeHtml(href) +
      '" target="_parent">Go to block</a>'
    );
  }

  function renderDeleteConfirm() {
    return (
      '<div class="comment__confirm-delete">' +
      "Are you sure?" +
      '<button type="button" class="button button-secondary comment__button" data-live-page-comment-mode="default">Cancel</button>' +
      '<button type="button" class="button comment__button" data-live-page-comment-action="delete-confirm">Delete</button>' +
      "</div>"
    );
  }

  function renderCommentReply(item) {
    const mode = item.mode || "default";
    let body = '<p class="comment__text">' + renderCommentText(item.text, item.mentions) + "</p>";
    if (mode === "editing") {
      body = renderEditForm(
        item.newText != null ? item.newText : item.text,
        "comment-reply__input",
      );
    } else if (mode === "delete_confirm") {
      body += renderDeleteConfirm();
    }
    return (
      '<li class="comment-reply comment-reply--mode-' +
      escapeHtml(mode) +
      '" data-reply-id="' +
      escapeHtml(String(item.id || "")) +
      '">' +
      renderCommentHeader(item) +
      body +
      "</li>"
    );
  }

  function renderCommentCard(item) {
    const replies = Array.isArray(item.replies) ? item.replies : [];
    const mode = item.mode || "default";
    const hideReply = mode === "delete_confirm" || mode === "editing";
    let body = '<p class="comment__text">' + renderCommentText(item.text, item.mentions) + "</p>";
    if (mode === "editing") {
      body = renderEditForm(item.newText != null ? item.newText : item.text, "comment__input");
    } else if (mode === "delete_confirm") {
      body += renderDeleteConfirm();
    }
    return (
      '<div class="comment comment--mode-' +
      escapeHtml(mode) +
      ' comment--focused" data-comment-id="' +
      escapeHtml(String(item.id || "")) +
      '">' +
      renderCommentHeader(item, { canResolve: true, permalink: true }) +
      body +
      '<ul class="comment__replies">' +
      replies.map(renderCommentReply).join("") +
      "</ul>" +
      (hideReply
        ? ""
        : "<form data-live-page-comment-reply-form>" +
          '<textarea rows="1" class="comment__reply-input" name="text" placeholder="Enter your reply..."></textarea>' +
          '<div class="comment__reply-actions">' +
          commentEditorLinkHtml(item.editorUrl) +
          '<button disabled type="submit" class="button comment__button comment__button--primary">Reply</button>' +
          '<button type="button" class="button button-secondary comment__button" data-live-page-comment-reply-cancel>Cancel</button>' +
          "</div></form>") +
      "</div>"
    );
  }

  function renderCommentPins(doc, comments, blockIds) {
    // `blockIds` limits the rebuild to those blocks; omit it to render them all.
    const scope = Array.isArray(blockIds) ? new Set(blockIds.map(String)) : null;
    const known = new Set();
    let roots = null;
    Object.keys(comments || {}).forEach((blockId) => {
      if (scope && !scope.has(blockId)) {
        return;
      }
      const items = commentItemsForBlock(comments, blockId);
      if (!items.length) {
        return;
      }
      roots = roots || blockRootsById(doc);
      const root = roots.get(blockId);
      if (!root) {
        return;
      }
      root.setAttribute("data-live-page-comment-host", "");
      const stale = Array.from(root.querySelectorAll("[data-live-page-comment-pin]"));
      stale.forEach((pin) => removeCommentPin(doc, pin));
      let fallbackIndex = 0;
      items.forEach((item, index) => {
        const pinKey = commentPinKey(blockId, item, index);
        known.add(blockId);
        const pin = doc.createElement("div");
        pin.setAttribute("data-live-page-comment-pin", "");
        pin.setAttribute("data-live-page-comment-pin-key", pinKey);
        // Not data-block-id: a pin is our UI, not a block.
        pin.setAttribute("data-live-page-comment-pin-block", blockId);
        pin.setAttribute(IGNORE_ATTR, "");
        const hashId = commentHashId(item.id);
        if (hashId) {
          pin.setAttribute("id", hashId);
        }
        pin.innerHTML =
          '<button type="button" class="live-page-comment-pill" data-live-page-comment-pill aria-expanded="false" aria-haspopup="dialog">' +
          COMMENT_ICON +
          "</button>";
        const point = commentPinPoint(item);
        if (point) {
          pin.setAttribute("data-live-page-comment-pin-placed", "");
          pin.style.setProperty("--live-page-comment-x", (point.x * 100).toFixed(2) + "%");
          pin.style.setProperty("--live-page-comment-y", (point.y * 100).toFixed(2) + "%");
        } else {
          pin.style.setProperty(
            "--live-page-comment-fallback-offset",
            fallbackIndex * 2.25 + "rem",
          );
          fallbackIndex += 1;
        }
        const button = pin.querySelector("[data-live-page-comment-pill]");
        const popover = doc.createElement("div");
        popover.className = "live-page-comment-popover";
        popover.setAttribute("data-live-page-comment-popover", "");
        popover.setAttribute("data-live-page-comment-pin-key", pinKey);
        popover.setAttribute(IGNORE_ATTR, "");
        popover.hidden = true;
        const anchor = `--live-page-comment-${pinKey}`;
        if (button) {
          button.style.setProperty("anchor-name", anchor);
          button.setAttribute("aria-label", "Comment on this block");
        }
        popover.style.setProperty("position-anchor", anchor);
        popover.setAttribute("role", "dialog");
        popover.setAttribute("aria-label", "Comment");
        popover.innerHTML = renderCommentCard(item);
        root.appendChild(pin);
        commentPopoverLayer(doc).appendChild(popover);
      });
    });
    doc.querySelectorAll("[data-live-page-comment-host]").forEach((root) => {
      const id = root.getAttribute("data-block-id");
      if (scope && !scope.has(id)) {
        return;
      }
      if (id && known.has(id)) {
        return;
      }
      root.querySelectorAll("[data-live-page-comment-pin]").forEach((pin) => {
        removeCommentPin(doc, pin);
      });
      root.removeAttribute("data-live-page-comment-host");
    });
  }

  function findConfig(doc) {
    const el = queryInRoots("#" + CONFIG_ID, userbarRoots(doc));
    return parseCommentConfig(el ? el.textContent : "");
  }

  // The userbar's own Media CSS only reaches its shadow root; pins and popovers
  // live in the page, so they need the stylesheet in the document too.
  function ensureStylesheet(doc, href) {
    const existing = doc.querySelector("link[" + STYLESHEET_ATTR + "]");
    if (existing || !href || !doc.head) {
      return existing || null;
    }
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.setAttribute(STYLESHEET_ATTR, "");
    doc.head.appendChild(link);
    return link;
  }

  // Boot once the page stylesheet has loaded, so pins never paint unstyled.
  function afterStylesheet(link, callback) {
    if (!link || link.sheet) {
      callback();
      return;
    }
    let done = false;
    const once = () => {
      if (!done) {
        done = true;
        callback();
      }
    };
    link.addEventListener("load", once);
    link.addEventListener("error", once);
  }

  function findTrigger(doc) {
    return queryInRoots("[data-live-page-comment-trigger]", userbarRoots(doc));
  }

  function chromeRoots(doc) {
    return userbarRoots(doc).concat([doc.body]);
  }

  function mountRoot(doc) {
    const host = doc.querySelector("wagtail-userbar");
    const shadow = host && host.shadowRoot;
    if (shadow) {
      return shadow.querySelector("[data-wagtail-userbar]") || shadow;
    }
    return doc.body;
  }

  function createChrome(doc) {
    const root = mountRoot(doc);
    let status = queryInRoots("[data-live-page-comment-status]", chromeRoots(doc));
    if (!status) {
      status = doc.createElement("div");
      status.setAttribute("data-live-page-comment-status", "");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      root.appendChild(status);
    }

    let dialog = queryInRoots("[data-live-page-comment-dialog]", chromeRoots(doc));
    if (!dialog) {
      dialog = doc.createElement("dialog");
      dialog.className = "w-dialog w-dialog--floating";
      dialog.setAttribute("data-live-page-comment-dialog", "");
      dialog.setAttribute("aria-labelledby", "live-page-comment-title");
      dialog.setAttribute("aria-describedby", "live-page-comment-description");
      dialog.innerHTML =
        '<div class="w-dialog__overlay" data-live-page-comment-overlay></div>' +
        '<div class="w-dialog__box">' +
        '<button type="button" class="w-dialog__close-button" data-live-page-comment-dismiss aria-label="Close dialog">' +
        '<svg class="icon icon-cross w-dialog__close-icon" aria-hidden="true">' +
        '<use href="#icon-cross"></use></svg></button>' +
        '<form class="w-dialog__content" data-live-page-comment-form>' +
        '<div class="w-dialog__header">' +
        '<h2 class="w-dialog__title w-h1" id="live-page-comment-title">' +
        "<span>Add a comment</span></h2>" +
        '<p class="w-dialog__subtitle w-help-text" id="live-page-comment-description">' +
        "This comment is attached to the selected block.</p>" +
        "</div>" +
        '<div class="w-dialog__body">' +
        '<div class="w-field">' +
        '<label class="w-field__label" for="live-page-comment-text">Comment</label>' +
        '<div class="w-field__wrapper">' +
        '<div class="w-field__input">' +
        '<textarea id="live-page-comment-text" name="text" required></textarea>' +
        "</div></div></div>" +
        '<p class="error-message" data-live-page-comment-error hidden></p>' +
        '<div class="w-flex w-justify-end w-gap-2">' +
        '<button type="button" class="button button-secondary" data-live-page-comment-dismiss>Cancel</button>' +
        '<button type="submit" class="button" data-live-page-comment-submit>Submit comment</button>' +
        "</div></div></form></div>";
      root.appendChild(dialog);
    }

    return {
      status,
      dialog,
      form: dialog.querySelector("[data-live-page-comment-form]"),
      textarea: dialog.querySelector("#live-page-comment-text"),
      error: dialog.querySelector("[data-live-page-comment-error]"),
      dismissButtons: dialog.querySelectorAll("[data-live-page-comment-dismiss]"),
      overlay: dialog.querySelector("[data-live-page-comment-overlay]"),
      submit: dialog.querySelector("[data-live-page-comment-submit]"),
    };
  }

  /**
   * "@" autocomplete for comment textareas (ARIA combobox + listbox). Results
   * come from the page's mention-candidates endpoint, cached per query.
   *
   * `floating: true` mounts the list on <body> under the textarea instead of
   * after it (for DOM owned by another renderer, e.g. Wagtail's React comments);
   * `setValue(textarea, value)` replaces the plain `.value` assignment.
   */
  function createMentionPicker(options) {
    const doc = options.document;
    const fetchImpl = options.fetch;
    const url = options.url;
    const floating = Boolean(options.floating);
    const setValue =
      options.setValue ||
      function (textarea, value) {
        textarea.value = value;
      };
    const view = doc.defaultView || global;
    const cache = new Map();
    let state = null;
    let frame = 0;
    let timer = null;
    let ticket = 0;
    let uid = 0;

    function close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      ticket += 1;
      if (!state) {
        return;
      }
      state.list.remove();
      state.textarea.setAttribute("aria-expanded", "false");
      state.textarea.removeAttribute("aria-activedescendant");
      state = null;
    }

    function open(textarea) {
      const list = doc.createElement("ul");
      uid += 1;
      list.id = "live-page-comment-mentions-" + uid;
      list.className = "live-page-comment-mentions";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "People and groups");
      // mousedown, not click: keeps textarea focus, and the document click
      // handler stops propagation inside comment popovers.
      list.addEventListener("mousedown", (event) => {
        event.preventDefault();
        const option = event.target.closest ? event.target.closest("[data-mention-index]") : null;
        if (option) {
          choose(Number(option.getAttribute("data-mention-index")));
        }
      });
      if (floating) {
        list.classList.add("live-page-comment-mentions--floating");
        place(list, textarea);
        doc.body.appendChild(list);
      } else {
        textarea.insertAdjacentElement("afterend", list);
      }
      textarea.setAttribute("role", "combobox");
      textarea.setAttribute("aria-autocomplete", "list");
      textarea.setAttribute("aria-controls", list.id);
      textarea.setAttribute("aria-expanded", "true");
      return { textarea, list, items: [], index: 0, start: 0 };
    }

    function place(list, textarea) {
      const rect = textarea.getBoundingClientRect();
      list.style.setProperty("top", rect.bottom + 4 + "px");
      list.style.setProperty("left", rect.left + "px");
      list.style.setProperty("width", Math.max(rect.width, 224) + "px");
    }

    /** Keep a floating list under its textarea (scroll, layout shifts), once per frame. */
    function reposition() {
      if (!floating || !state || frame) {
        return;
      }
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        if (state) {
          place(state.list, state.textarea);
        }
      });
    }

    function render() {
      const { list, items, index, textarea } = state;
      if (!items.length) {
        list.innerHTML =
          '<li class="live-page-comment-mentions__empty" role="presentation">No matches</li>';
        textarea.removeAttribute("aria-activedescendant");
        return;
      }
      list.innerHTML = items
        .map(
          (item, i) =>
            '<li role="option" class="live-page-comment-mentions__option" id="' +
            list.id +
            "-" +
            i +
            '" data-mention-index="' +
            i +
            '" aria-selected="' +
            (i === index ? "true" : "false") +
            '"><span class="live-page-comment-mentions__label">' +
            escapeHtml(item.label || "") +
            '</span> <span class="live-page-comment-mentions__token">' +
            escapeHtml(item.token || "") +
            "</span></li>",
        )
        .join("");
      textarea.setAttribute("aria-activedescendant", list.id + "-" + index);
    }

    async function load(query) {
      if (cache.has(query)) {
        return cache.get(query);
      }
      const data = await getJson(fetchImpl, withQuery(url, { q: query }));
      if (!data) {
        return [];
      }
      const items = [].concat(data.users || [], data.groups || []);
      cache.set(query, items);
      return items;
    }

    function update(textarea) {
      const found = mentionQueryAt(textarea.value, textarea.selectionStart);
      if (!found) {
        close();
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      ticket += 1;
      const current = ticket;
      timer = setTimeout(async () => {
        timer = null;
        let items = [];
        try {
          items = await load(found.query);
        } catch {
          items = [];
        }
        if (current !== ticket || !textarea.isConnected) {
          return;
        }
        if (!state || state.textarea !== textarea) {
          close();
          ticket = current;
          state = open(textarea);
        }
        state.items = items;
        state.index = 0;
        state.start = found.start;
        render();
      }, 150);
    }

    function choose(index) {
      const item = state && state.items[index];
      if (!item) {
        return;
      }
      const textarea = state.textarea;
      const next = insertMention(textarea.value, state.start, textarea.selectionStart, item.token);
      close();
      setValue(textarea, next.value);
      textarea.setSelectionRange(next.caret, next.caret);
      textarea.focus();
      // Let the reply form enable its submit button.
      textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }

    /** Returns true when the key drove the picker (caller should not act on it). */
    function onKeydown(event, textarea) {
      if (!state || state.textarea !== textarea) {
        return false;
      }
      const count = state.items.length;
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && count) {
        const step = event.key === "ArrowDown" ? 1 : -1;
        state.index = (state.index + step + count) % count;
        render();
      } else if (
        ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") &&
        count
      ) {
        choose(state.index);
      } else if (event.key === "Escape") {
        close();
      } else {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      return true;
    }

    return {
      update,
      onKeydown,
      close,
      reposition,
      isOpenFor(textarea) {
        return Boolean(state && state.textarea === textarea);
      },
    };
  }

  function createController(options) {
    const doc = options.document;
    const config = options.config;
    const fetchImpl = options.fetch;
    const cookieSource = () => (options.cookie ? options.cookie() : doc.cookie || "");

    const eligible = new Set(config.eligibleBlockIds || []);
    const comments = Object.assign({}, config.comments || {});
    const chrome = createChrome(doc);
    const trigger = options.trigger || findTrigger(doc);
    const mentions = config.mentionsUrl
      ? createMentionPicker({
          document: doc,
          fetch: fetchImpl,
          url: config.mentionsUrl,
        })
      : null;

    // The create dialog lives in the userbar shadow root, so document-level
    // listeners see the host as `target`; the composed path has the textarea.
    function commentTextareaFromEvent(event) {
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      const target = path[0] || event.target;
      return commentFormFromKeyTarget(target) ? target : null;
    }

    function onMentionInput(event) {
      const textarea = mentions && commentTextareaFromEvent(event);
      if (textarea) {
        mentions.update(textarea);
      }
    }

    function onMentionKeydown(event) {
      const textarea = mentions && commentTextareaFromEvent(event);
      if (textarea) {
        mentions.onKeydown(event, textarea);
      }
    }

    function onMentionFocusOut(event) {
      const textarea = mentions && commentTextareaFromEvent(event);
      if (textarea && mentions.isOpenFor(textarea)) {
        mentions.close();
      }
    }

    let targeting = false;
    let selected = null;
    let pendingPosition = null;
    let submittedOk = false;
    let submitting = false;

    function setStatus(message) {
      chrome.status.textContent = message;
    }

    function setTriggerState() {
      if (!trigger) {
        return;
      }
      trigger.setAttribute("aria-pressed", targeting ? "true" : "false");
    }

    function clearError() {
      chrome.error.hidden = true;
      chrome.error.textContent = "";
      chrome.textarea.removeAttribute("aria-invalid");
      chrome.textarea.removeAttribute("aria-describedby");
    }

    function showError(message) {
      chrome.error.hidden = false;
      chrome.error.id = "live-page-comment-error";
      chrome.error.textContent = message;
      chrome.textarea.setAttribute("aria-invalid", "true");
      chrome.textarea.setAttribute("aria-describedby", "live-page-comment-error");
    }

    function selectableBlocks() {
      return Array.from(doc.querySelectorAll("[data-block-id]")).filter((el) =>
        isSelectableId(el.getAttribute("data-block-id"), eligible),
      );
    }

    // Blocks the latest draft dropped, skipping wrappers of ones it kept.
    function unavailableBlocks() {
      return Array.from(doc.querySelectorAll("[data-block-id]")).filter(
        (el) =>
          !isSelectableId(el.getAttribute("data-block-id"), eligible) &&
          !el.querySelector("[data-commentable]"),
      );
    }

    function applyUnavailableAttrs(on) {
      if (!on) {
        doc.querySelectorAll(UNAVAILABLE).forEach((el) => {
          el.removeAttribute("data-comment-unavailable");
          if (el.getAttribute("title") === UNAVAILABLE_HINT) {
            el.removeAttribute("title");
          }
        });
        return [];
      }
      const blocks = unavailableBlocks();
      blocks.forEach((el) => {
        el.setAttribute("data-comment-unavailable", "");
        if (!el.hasAttribute("title")) {
          el.setAttribute("title", UNAVAILABLE_HINT);
        }
      });
      return blocks;
    }

    function applyTargetingAttrs(on) {
      const blocks = selectableBlocks();
      blocks.forEach((el) => {
        if (on) {
          el.setAttribute("data-commentable", "");
          el.setAttribute("tabindex", "0");
          el.setAttribute("role", "button");
          el.setAttribute("aria-label", "Comment on this block");
        } else {
          el.removeAttribute("data-commentable");
          el.removeAttribute("tabindex");
          el.removeAttribute("role");
          el.removeAttribute("aria-label");
          el.removeAttribute("data-comment-selected");
        }
      });
      return blocks;
    }

    // At most one popover is open. Tracking it means a click anywhere on the
    // page closes one node instead of rewriting every popover and pill.
    let openPopover = null;

    function hasOpenPopover() {
      return Boolean(openPopover && openPopover.popover.isConnected !== false);
    }

    function closeCommentPopovers() {
      if (!openPopover) {
        return;
      }
      openPopover.popover.hidden = true;
      if (openPopover.button) {
        openPopover.button.setAttribute("aria-expanded", "false");
      }
      openPopover = null;
    }

    function showCommentPopover(popover, button) {
      if (!popover) {
        return;
      }
      if (openPopover && openPopover.popover !== popover) {
        closeCommentPopovers();
      }
      popover.hidden = false;
      if (button) {
        button.setAttribute("aria-expanded", "true");
      }
      openPopover = { popover, button };
      focusPopoverReplyInput(popover);
    }

    function revealCommentFromHash(hash) {
      const commentId = commentIdFromHash(hash);
      if (!commentId) {
        return false;
      }
      const pin = doc.querySelector(
        '[data-live-page-comment-pin][data-live-page-comment-pin-key="' + commentId + '"]',
      );
      if (!pin) {
        return false;
      }
      if (typeof pin.scrollIntoView === "function") {
        pin.scrollIntoView({ block: "center", inline: "nearest" });
      }
      showCommentPopover(
        commentPopoverForPin(doc, pin),
        pin.querySelector("[data-live-page-comment-pill]"),
      );
      return true;
    }

    function refreshPins(blockId) {
      renderCommentPins(doc, comments, blockId ? [blockId] : undefined);
    }

    function setSelected(block) {
      if (selected) {
        selected.removeAttribute("data-comment-selected");
      }
      selected = block;
      if (selected) {
        selected.setAttribute("data-comment-selected", "");
      }
    }

    function startTargeting() {
      targeting = true;
      submittedOk = false;
      doc.documentElement.setAttribute("data-live-page-comment-targeting", "");
      const blocks = applyTargetingAttrs(true);
      const unavailable = applyUnavailableAttrs(true);
      setTriggerState();
      setStatus(targetingMessage(blocks.length, unavailable.length));
      const ModeEvent = (doc.defaultView && doc.defaultView.CustomEvent) || global.CustomEvent;
      if (typeof ModeEvent === "function") {
        doc.dispatchEvent(new ModeEvent(MODE_ON_EVENT, { detail: { source: MODE_SOURCE } }));
      }
      log("targeting-on", {
        selectableCount: blocks.length,
        unavailableCount: unavailable.length,
      });
    }

    function stopTargeting() {
      if (mentions) {
        mentions.close();
      }
      if (chrome.dialog.open) {
        chrome.dialog.close();
      }
      targeting = false;
      pendingPosition = null;
      setSelected(null);
      applyTargetingAttrs(false);
      applyUnavailableAttrs(false);
      doc.documentElement.removeAttribute("data-live-page-comment-targeting");
      chrome.form.reset();
      clearError();
      setTriggerState();
    }

    function openDialog(block, position) {
      if (!targeting || !block) {
        log("dialog-skip", { targeting, hasBlock: Boolean(block) });
        return;
      }
      submittedOk = false;
      pendingPosition = position || null;
      setSelected(block);
      clearError();
      log("dialog-open", {
        id: block.getAttribute("data-block-id"),
        tag: block.tagName,
      });
      try {
        chrome.dialog.showModal();
      } catch (err) {
        log("dialog-showModal-error", String(err));
        throw err;
      }
      chrome.textarea.focus();
    }

    function dismissDialog() {
      if (chrome.dialog.open) {
        chrome.dialog.close();
      }
    }

    function setSubmitting(busy) {
      submitting = busy;
      chrome.submit.disabled = busy;
      chrome.textarea.disabled = busy;
      if (busy) {
        chrome.form.setAttribute("aria-busy", "true");
      } else {
        chrome.form.removeAttribute("aria-busy");
      }
    }

    function failSubmit(text, message) {
      setSubmitting(false);
      chrome.textarea.value = text;
      showError(message);
      chrome.textarea.focus();
    }

    function onDialogClose() {
      setSubmitting(false);
      if (submittedOk) {
        stopTargeting();
        setStatus(SUCCESS_MESSAGE);
        return;
      }
      if (targeting && selected) {
        selected.focus();
      }
    }

    async function submitComment(event) {
      event.preventDefault();
      if (submitting || !selected) {
        return;
      }
      const text = chrome.textarea.value;
      setSubmitting(true);
      clearError();

      try {
        const result = await postCommentJson(config.createUrl, {
          block_uuid: selected.getAttribute("data-block-id"),
          text,
          position: pendingPosition,
        });
        if (!result.ok) {
          failSubmit(text, errorMessageFromPayload(result.payload, NETWORK_MESSAGE));
          return;
        }
        submittedOk = true;
        const blockId = selected.getAttribute("data-block-id");
        if (blockId && result.payload.comment) {
          const existing = commentItemsForBlock(comments, blockId).slice();
          existing.push(result.payload.comment);
          comments[blockId] = existing;
          refreshPins(blockId);
        }
        chrome.textarea.value = "";
        dismissDialog();
      } catch {
        failSubmit(text, NETWORK_MESSAGE);
      }
    }

    function onDocumentClick(event) {
      const popoverHit = event.target.closest
        ? event.target.closest("[data-live-page-comment-popover]")
        : null;
      if (popoverHit) {
        event.stopPropagation();
        if (isPopoverCancelTarget(event.target)) {
          event.preventDefault();
          closeCommentPopovers();
          return;
        }
        onCommentCardClick(event);
        return;
      }
      const pin = event.target.closest
        ? event.target.closest("[data-live-page-comment-pin]")
        : null;
      if (pin) {
        event.stopPropagation();
        event.preventDefault();
        const button = event.target.closest
          ? event.target.closest("[data-live-page-comment-pill]")
          : null;
        if (!button) {
          return;
        }
        const popover = commentPopoverForPin(doc, pin);
        const willOpen = Boolean(popover && popover.hidden);
        closeCommentPopovers();
        if (willOpen && popover) {
          showCommentPopover(popover, button);
        }
        return;
      }
      closeCommentPopovers();
      if (!targeting || chrome.dialog.open) {
        return;
      }
      const block = closestSelectable(event.target);
      if (!block) {
        const unavailable = event.target.closest && event.target.closest(UNAVAILABLE);
        if (unavailable && !event.target.closest("[" + IGNORE_ATTR + "]")) {
          event.preventDefault();
          event.stopImmediatePropagation();
          setStatus(UNAVAILABLE_HINT);
        }
        return;
      }
      // Capture phase on the document runs before any handler on the block's
      // links, tabs, dialog triggers or galleries (Alpine @click, htmx), so the
      // click places the comment and nothing on the page reacts to it.
      event.preventDefault();
      event.stopImmediatePropagation();
      openDialog(block, clickPositionInBlock(event, block));
    }

    // Menus, carousels and drag handles act on pointerdown/mousedown, before the
    // click: swallow those too while picking a block.
    function onTargetingPointerDown(event) {
      if (!targeting || chrome.dialog.open || !closestSelectable(event.target)) {
        return;
      }
      event.stopImmediatePropagation();
    }

    function onDocumentKeydown(event) {
      if (submitCommentFormFromKeydown(event)) {
        return;
      }
      if (event.key === "Escape" && hasOpenPopover()) {
        event.preventDefault();
        closeCommentPopovers();
        return;
      }
      if (!targeting) {
        return;
      }
      if (event.key === "Escape" && !chrome.dialog.open) {
        event.preventDefault();
        stopTargeting();
        return;
      }
      if (chrome.dialog.open) {
        return;
      }
      const block = closestSelectable(event.target);
      if (!block) {
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDialog(block);
      }
    }

    function onTriggerClick(event) {
      event.preventDefault();
      log("trigger-click", { targetingBefore: targeting });
      if (targeting) {
        stopTargeting();
        log("targeting-off", { reason: "trigger" });
      } else {
        startTargeting();
        log("commenting-enabled", {
          from: "userbar",
          pageId: config.pageId,
          createUrl: config.createUrl,
        });
      }
    }

    function onBackdropClick(event) {
      if (event.target === chrome.dialog || (chrome.overlay && event.target === chrome.overlay)) {
        dismissDialog();
      }
    }

    chrome.dismissButtons.forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        dismissDialog();
      });
    });
    refreshPins();
    const view = doc.defaultView;
    if (view && view.location) {
      revealCommentFromHash(view.location.hash);
    }
    if (view && typeof view.addEventListener === "function") {
      view.addEventListener("hashchange", () => {
        revealCommentFromHash(view.location.hash);
      });
    }
    function storedReply(comment, replyId) {
      return (comment.replies || []).find((reply) => String(reply.id) === String(replyId));
    }

    function findStoredComment(commentId) {
      const keys = Object.keys(comments);
      for (let i = 0; i < keys.length; i += 1) {
        const items = commentItemsForBlock(comments, keys[i]);
        for (let j = 0; j < items.length; j += 1) {
          if (String(items[j].id) === String(commentId)) {
            return { blockId: keys[i], comment: items[j] };
          }
        }
      }
      return null;
    }

    function rerenderOpenComment(commentId) {
      // Swap the card markup inside the existing popover. Rebuilding every pin
      // (refreshPins) would drop the popover node, its anchor position, focus,
      // and any half-typed reply, which reads as a flicker.
      const found = findStoredComment(commentId);
      const pin = doc.querySelector(
        '[data-live-page-comment-pin][data-live-page-comment-pin-key="' + commentId + '"]',
      );
      const popover = commentPopoverForPin(doc, pin);
      if (mentions) {
        mentions.close();
      }
      if (!found || !popover) {
        refreshPins(found && found.blockId);
        return;
      }
      popover.innerHTML = renderCommentCard(found.comment);
      const button = pin && pin.querySelector("[data-live-page-comment-pill]");
      showCommentPopover(popover, button);
    }

    function setCommentMode(commentId, replyId, mode) {
      const found = findStoredComment(commentId);
      if (!found) {
        return;
      }
      if (replyId) {
        found.comment.replies = (found.comment.replies || []).map((reply) => {
          if (String(reply.id) !== String(replyId)) {
            return reply;
          }
          return {
            ...reply,
            mode,
            newText: mode === "editing" ? reply.text : reply.newText,
          };
        });
      } else {
        found.comment.mode = mode;
        if (mode === "editing") {
          found.comment.newText = found.comment.text;
        }
      }
      rerenderOpenComment(commentId);
    }

    function removeStoredComment(commentId) {
      const found = findStoredComment(commentId);
      if (!found) {
        return;
      }
      const blockId = found.blockId;
      comments[blockId] = commentItemsForBlock(comments, blockId).filter(
        (item) => String(item.id) !== String(commentId),
      );
      if (!comments[blockId].length) {
        delete comments[blockId];
      }
      refreshPins(blockId);
    }

    function removeStoredReply(commentId, replyId) {
      const found = findStoredComment(commentId);
      if (!found) {
        return;
      }
      found.comment.replies = (found.comment.replies || []).filter(
        (reply) => String(reply.id) !== String(replyId),
      );
      rerenderOpenComment(commentId);
    }

    function updateStoredText(commentId, replyId, text, mentionList) {
      const found = findStoredComment(commentId);
      if (!found) {
        return;
      }
      const resolved = Array.isArray(mentionList) ? mentionList : [];
      if (replyId) {
        found.comment.replies = (found.comment.replies || []).map((reply) => {
          if (String(reply.id) !== String(replyId)) {
            return reply;
          }
          return { ...reply, text, mentions: resolved, mode: "default" };
        });
      } else {
        found.comment.text = text;
        found.comment.mentions = resolved;
        found.comment.mode = "default";
      }
      rerenderOpenComment(commentId);
    }

    async function postCommentJson(url, body) {
      const response = await fetchImpl(url, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-CSRFToken": readCsrfToken(cookieSource()),
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify(body || {}),
      });
      return readCommentResponse(response);
    }

    function onCommentCardClick(event) {
      const action = event.target.closest
        ? event.target.closest("[data-live-page-comment-action]")
        : null;
      const modeButton = event.target.closest
        ? event.target.closest("[data-live-page-comment-mode]")
        : null;
      const card = event.target.closest("[data-comment-id]");
      const commentId = card && card.getAttribute("data-comment-id");
      if (!commentId) {
        return;
      }
      const replyEl = event.target.closest("[data-reply-id]");
      const replyId = replyEl && replyEl.getAttribute("data-reply-id");
      if (modeButton) {
        event.preventDefault();
        setCommentMode(commentId, replyId, modeButton.getAttribute("data-live-page-comment-mode"));
        return;
      }
      if (!action) {
        return;
      }
      event.preventDefault();
      const name = action.getAttribute("data-live-page-comment-action");
      if (name === "link") {
        const view = doc.defaultView;
        const loc = view && view.location;
        const clipboard = view && view.navigator && view.navigator.clipboard;
        copyTextToClipboard(commentPermalink(loc, commentId), clipboard);
        const details = action.closest("details");
        if (details) {
          details.removeAttribute("open");
        }
        return;
      }
      if (name === "edit") {
        setCommentMode(commentId, replyId, "editing");
        return;
      }
      if (name === "delete") {
        setCommentMode(commentId, replyId, "delete_confirm");
        return;
      }
      if (name === "resolve") {
        const found = findStoredComment(commentId);
        const url = found && found.comment.resolveUrl;
        if (!url) {
          return;
        }
        postCommentJson(url).then((result) => {
          if (result.ok) {
            removeStoredComment(commentId);
          }
        });
        return;
      }
      if (name === "delete-confirm") {
        const found = findStoredComment(commentId);
        if (!found) {
          return;
        }
        const url = replyId
          ? (storedReply(found.comment, replyId) || {}).deleteUrl
          : found.comment.deleteUrl;
        if (!url) {
          return;
        }
        postCommentJson(url).then((result) => {
          if (!result.ok) {
            return;
          }
          if (replyId) {
            removeStoredReply(commentId, replyId);
          } else {
            removeStoredComment(commentId);
          }
        });
      }
    }

    async function onEditSubmit(event) {
      const form = event.target.closest
        ? event.target.closest("[data-live-page-comment-edit-form]")
        : null;
      if (!form) {
        return;
      }
      event.preventDefault();
      const card = form.closest("[data-comment-id]");
      const commentId = card && card.getAttribute("data-comment-id");
      const replyEl = form.closest("[data-reply-id]");
      const replyId = replyEl && replyEl.getAttribute("data-reply-id");
      const textarea = form.querySelector("textarea");
      const text = textarea && textarea.value.trim();
      if (!commentId || !text) {
        return;
      }
      const found = findStoredComment(commentId);
      if (!found) {
        return;
      }
      const url = replyId
        ? (storedReply(found.comment, replyId) || {}).editUrl
        : found.comment.editUrl;
      if (!url) {
        return;
      }
      const result = await postCommentJson(url, { text });
      if (result.ok && typeof result.payload.text === "string") {
        updateStoredText(commentId, replyId, result.payload.text, result.payload.mentions);
      }
    }

    function onReplyInput(event) {
      const textarea = event.target.closest ? event.target.closest(".comment__reply-input") : null;
      if (!textarea) {
        return;
      }
      const form = textarea.closest("[data-live-page-comment-reply-form]");
      const submit = form && form.querySelector('[type="submit"]');
      if (submit) {
        submit.disabled = !textarea.value.trim();
      }
    }

    async function onReplySubmit(event) {
      const form = event.target.closest
        ? event.target.closest("[data-live-page-comment-reply-form]")
        : null;
      if (!form) {
        return;
      }
      event.preventDefault();
      const card = form.closest("[data-comment-id]");
      const textarea = form.querySelector(".comment__reply-input");
      const submit = form.querySelector('[type="submit"]');
      const commentId = card && card.getAttribute("data-comment-id");
      const text = textarea && textarea.value.trim();
      if (!commentId || !text) {
        return;
      }
      const found = findStoredComment(commentId);
      const url = found && found.comment.replyUrl;
      if (!url) {
        return;
      }
      function setBusy(busy) {
        textarea.disabled = busy;
        if (submit) {
          submit.disabled = busy;
        }
      }
      setBusy(true);
      try {
        const result = await postCommentJson(url, { text });
        // The server's reply DTO is the only source of author/avatar/createdAt.
        const reply = result.ok ? result.payload.reply : null;
        if (!reply) {
          setBusy(false);
          return;
        }
        found.comment.replies = (found.comment.replies || []).concat([reply]);
        rerenderOpenComment(commentId);
      } catch {
        setBusy(false);
      }
    }

    chrome.form.addEventListener("submit", submitComment);
    chrome.form.addEventListener("keydown", (event) => {
      submitCommentFormFromKeydown(event);
    });
    chrome.dialog.addEventListener("close", onDialogClose);
    chrome.dialog.addEventListener("click", onBackdropClick);
    doc.addEventListener("click", onDocumentClick, true);
    doc.addEventListener("pointerdown", onTargetingPointerDown, true);
    doc.addEventListener("mousedown", onTargetingPointerDown, true);
    doc.addEventListener("input", onReplyInput);
    doc.addEventListener("submit", onReplySubmit);
    doc.addEventListener("submit", onEditSubmit);
    doc.addEventListener("keydown", onDocumentKeydown);
    doc.addEventListener(MODE_ON_EVENT, (event) => {
      if (targeting && (!event.detail || event.detail.source !== MODE_SOURCE)) {
        stopTargeting();
      }
    });
    if (mentions) {
      // Capture: picker keys (Enter, Escape, arrows) must not reach the
      // dialog/popover handlers once the picker has used them.
      doc.addEventListener("keydown", onMentionKeydown, true);
      doc.addEventListener("input", onMentionInput);
      doc.addEventListener("focusout", onMentionFocusOut);
    }
    if (trigger) {
      trigger.addEventListener("click", onTriggerClick);
      log("trigger-bound", { tag: trigger.tagName });
    } else {
      log("trigger-missing");
    }

    return {
      startTargeting,
      stopTargeting,
      openDialog,
      isTargeting() {
        return targeting;
      },
      getSelected() {
        return selected;
      },
    };
  }

  function boot(doc, fetchImpl) {
    log("boot-start");
    const config = findConfig(doc);
    const trigger = findTrigger(doc);
    log("boot-config", {
      hasConfig: Boolean(config),
      createUrl: config && config.createUrl,
      pageId: config && config.pageId,
      eligibleBlockIds: config && config.eligibleBlockIds,
      hasTrigger: Boolean(trigger),
    });
    if (!config || !config.createUrl) {
      log("boot-abort", { reason: "missing-config-or-createUrl" });
      return null;
    }
    ensureStylesheet(doc, config.cssUrl);
    return createController({
      document: doc,
      config,
      fetch: fetchImpl,
      trigger,
    });
  }

  function whenReady(doc, callback) {
    // Wagtail emits the userbar media.js after <wagtail-userbar> and userbar.js,
    // so the shadow root (and our trigger) already exists when this runs. No
    // trigger means this user can't comment here: stop instead of watching the
    // whole document for mutations that will never come.
    const config = findConfig(doc);
    const trigger = findTrigger(doc);
    log("when-ready-check", {
      hasConfig: Boolean(config),
      hasTrigger: Boolean(trigger),
    });
    if (config && trigger) {
      afterStylesheet(ensureStylesheet(doc, config.cssUrl), callback);
    }
  }

  const api = {
    parseCommentConfig,
    findConfig,
    ensureStylesheet,
    afterStylesheet,
    commentPopoverLayer,
    commentPopoverForPin,
    clickPositionInBlock,
    commentPinPoint,
    renderCommentPins,
    readCsrfToken,
    readCommentResponse,
    isSelectableId,
    closestSelectable,
    targetingMessage,
    errorMessageFromPayload,
    isCommentSubmitChord,
    commentFormFromKeyTarget,
    submitCommentFormFromKeydown,
    isPopoverCancelTarget,
    focusPopoverReplyInput,
    commentEditorLinkHtml,
    commentPermalink,
    commentIdFromHash,
    MENTION_RE,
    mentionTokenCandidates,
    findMentions,
    renderCommentText,
    withQuery,
    getJson,
    mentionQueryAt,
    insertMention,
    createMentionPicker,
    createController,
    boot,
  };

  global.WagtailLiveComments = api;

  if (global.document && global.fetch) {
    const start = () => {
      log("script-start", { readyState: global.document.readyState });
      whenReady(global.document, () => {
        api.boot(global.document, global.fetch.bind(global));
      });
    };
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);
