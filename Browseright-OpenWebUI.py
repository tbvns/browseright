"""
title: Browseright: Embedded Browser Agent
author: Tbvns
version: 0.0.1
license: MIT
description: Full browser-automation tool backed by the browse-embedded server. All content
  retrieval uses the embedded smart-context pipeline (clean -> chunk -> embed -> rerank);
  every other browser capability (navigation, actions, queries, network, logs, storage,
  cookies, screenshots, frames, dialogs, downloads) is exposed from the base browser API.
"""

import requests
from typing import Optional, List, Dict, Any, Union

from pydantic import BaseModel, Field


class Tools:
    def __init__(self):
        # OpenWebUI renders these Valves as editable fields in the tool's config panel.
        self.valves = self.Valves(
            **{
                "BASE_URL": "http://localhost:3000",
                "API_KEY": "",
                "REQUEST_TIMEOUT_SECONDS": 90,
                "DEFAULT_CONTENT_LIMIT": 20000,
                "DEFAULT_RERANK_TOP_K": 6,
                "DEFAULT_CANDIDATE_K": 24,
                "VERIFY_SSL": True,
            }
        )

    class Valves(BaseModel):
        BASE_URL: str = Field(
            default="http://localhost:3000",
            description="Base URL of the running browse-embedded server (no trailing slash needed).",
        )
        API_KEY: str = Field(
            default="",
            description="Optional Bearer token sent as Authorization if the server is behind auth. Leave blank for none.",
        )
        REQUEST_TIMEOUT_SECONDS: int = Field(
            default=90,
            description="HTTP timeout (seconds) for each request to the browser server.",
        )
        DEFAULT_CONTENT_LIMIT: int = Field(
            default=20000,
            description="Default char limit for embedded retrieval. Content longer than this is chunked + reranked instead of returned whole.",
        )
        DEFAULT_RERANK_TOP_K: int = Field(
            default=6,
            description="Default number of top reranked chunks to return when content is embedded.",
        )
        DEFAULT_CANDIDATE_K: int = Field(
            default=24,
            description="Default number of candidate chunks considered before reranking.",
        )
        VERIFY_SSL: bool = Field(
            default=True,
            description="Verify TLS certificates when calling the server.",
        )

    # ------------------------------------------------------------------ #
    #                          internal helper                           #
    # ------------------------------------------------------------------ #
    def _request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        url = f"{self.valves.BASE_URL.rstrip('/')}{path}"
        headers = {}
        if self.valves.API_KEY:
            headers["Authorization"] = f"Bearer {self.valves.API_KEY}"
        try:
            resp = requests.request(
                method,
                url,
                params=params or None,
                json=json_body if json_body is not None else None,
                headers=headers,
                timeout=self.valves.REQUEST_TIMEOUT_SECONDS,
                verify=self.valves.VERIFY_SSL,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            try:
                detail = e.response.json()
            except Exception:
                detail = e.response.text
            return {"error": f"HTTP {e.response.status_code}", "detail": detail}
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)}

    def _embedded_params(
        self,
        query: Optional[str],
        limit: Optional[int],
        top_k: Optional[int] = None,
        candidate_k: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Build query params for the embedded smart-context endpoints, applying Valve defaults."""
        params: Dict[str, Any] = {
            "limit": limit if limit is not None else self.valves.DEFAULT_CONTENT_LIMIT,
        }
        if query:
            params["query"] = query
        if top_k is not None:
            params["topK"] = top_k
        elif self.valves.DEFAULT_RERANK_TOP_K:
            params["topK"] = self.valves.DEFAULT_RERANK_TOP_K
        if candidate_k is not None:
            params["candidateK"] = candidate_k
        elif self.valves.DEFAULT_CANDIDATE_K:
            params["candidateK"] = self.valves.DEFAULT_CANDIDATE_K
        return params

    # ================================================================== #
    #  EMBEDDED SMART-CONTEXT RETRIEVAL (browse-embedded overrides)      #
    #  These replace the base /content, /markdown, /text, /snapshot.     #
    # ================================================================== #

    def get_page_context(
        self,
        page_id: str,
        query: Optional[str] = None,
        limit: Optional[int] = None,
        top_k: Optional[int] = None,
        candidate_k: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Retrieve the full smart-context object for a page: cleaned HTML + markdown, chunk
        count, and (when the page is large) the top embedded+reranked chunks with scores.

        Use this when you need the richest view of a page's relevant content. Provide `query`
        to focus retrieval on a topic; otherwise the page title/URL is used.
        Returns: {mode, embedded, reranked, markdown, html, chunks, url, title, ...}.
        """
        params = self._embedded_params(query, limit, top_k, candidate_k)
        return self._request("GET", f"/api/page/{page_id}/context", params=params)

    def post_page_context(
        self,
        page_id: str,
        query: Optional[str] = None,
        task: Optional[str] = None,
        goal: Optional[str] = None,
        intent: Optional[str] = None,
        limit: Optional[int] = None,
        top_k: Optional[int] = None,
        candidate_k: Optional[int] = None,
        force_embed: bool = False,
    ) -> Dict[str, Any]:
        """Advanced smart-context retrieval via POST. Accepts richer guidance signals
        (task / goal / intent) in addition to `query`, and can force embedding even for
        small pages with force_embed=True.

        Use this when you want to steer chunk selection with a task description rather than
        a plain keyword query. Returns the same context object as get_page_context.
        """
        body: Dict[str, Any] = {
            "limit": limit if limit is not None else self.valves.DEFAULT_CONTENT_LIMIT,
            "topK": top_k if top_k is not None else self.valves.DEFAULT_RERANK_TOP_K,
            "candidateK": (
                candidate_k
                if candidate_k is not None
                else self.valves.DEFAULT_CANDIDATE_K
            ),
        }
        if query:
            body["query"] = query
        if task:
            body["task"] = task
        if goal:
            body["goal"] = goal
        if intent:
            body["intent"] = intent
        if force_embed:
            body["forceEmbed"] = True
        return self._request("POST", f"/api/page/{page_id}/context", json_body=body)

    def get_content(
        self,
        page_id: str,
        query: Optional[str] = None,
        limit: Optional[int] = None,
        as_object: bool = False,
    ) -> Dict[str, Any]:
        """Get the page's HTML via the embedded pipeline (cleaned of scripts/styles/nav chrome,
        chunked and reranked if it exceeds the limit).

        Prefer this over raw HTML whenever you need page content efficiently. Set as_object=True
        to receive the full context object instead of just {html, markdown}.
        Returns: {mode, truncated, html, markdown, query} (or full context object).
        """
        params = self._embedded_params(query, limit)
        if as_object:
            params["object"] = "true"
        return self._request("GET", f"/api/page/{page_id}/content", params=params)

    def get_markdown(
        self,
        page_id: str,
        query: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get the page's content as cleaned Markdown via the embedded pipeline. Images are
        stripped and links are flattened to 'text (url)'. Large pages are chunked and reranked
        around `query`.

        This is the best default for reading an article / documentation page.
        Returns: {mode, truncated, markdown, query}.
        """
        params = self._embedded_params(query, limit)
        return self._request("GET", f"/api/page/{page_id}/markdown", params=params)

    def get_text(
        self,
        page_id: str,
        query: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get the page's plain body text via the embedded pipeline. For large pages this
        returns the concatenated text of the top reranked chunks rather than the whole page.

        Use this when you only need readable text and no structure.
        Returns: {mode, truncated, text, query}.
        """
        params = self._embedded_params(query, limit)
        return self._request("GET", f"/api/page/{page_id}/text", params=params)

    def get_snapshot(
        self,
        page_id: str,
        query: Optional[str] = None,
        text_limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Get a comprehensive agent snapshot: title, url, visible text, accessibility tree,
        links, inputs, and buttons — merged with the embedded smart-context.

        Use this to understand a page's interactive surface (what can be clicked/filled) before
        performing actions. `query` focuses the embedded context portion.
        Returns: {title, url, text, accessibility, links, inputs, buttons, context, ...}.
        """
        params: Dict[str, Any] = {}
        if query:
            params["query"] = query
        if text_limit is not None:
            params["textLimit"] = text_limit
        return self._request("GET", f"/api/page/{page_id}/snapshot", params=params)

    # ================================================================== #
    #  BROWSER MANAGEMENT                                                #
    # ================================================================== #

    def create_browser(
        self,
        browser_id: Optional[str] = None,
        headless: bool = False,
        args: Optional[List[str]] = None,
        executable_path: Optional[str] = None,
        proxy: Optional[Dict[str, Any]] = None,
        idle_timeout_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Launch a new Chromium browser instance. Call this first, then create pages inside it.

        headless=True runs without a visible window (good for servers). idle_timeout_ms
        auto-closes the browser after inactivity (0 disables). Returns: {id}.
        """
        options: Dict[str, Any] = {"headless": headless}
        if args:
            options["args"] = args
        if executable_path:
            options["executablePath"] = executable_path
        if proxy:
            options["proxy"] = proxy
        if idle_timeout_ms is not None:
            options["idleTimeoutMs"] = idle_timeout_ms
        body: Dict[str, Any] = {"options": options}
        if browser_id:
            body["id"] = browser_id
        return self._request("POST", "/api/browser", json_body=body)

    def list_browsers(self) -> Dict[str, Any]:
        """List all active browser instances with their contexts, pages, and connection state.
        Returns: {browsers: [...]}.
        """
        return self._request("GET", "/api/browsers")

    def get_browser_info(self, browser_id: str) -> Dict[str, Any]:
        """Get detailed info about one browser: its contexts and pages.
        Returns: {id, createdAt, lastUsedAt, connected, contexts, pages}.
        """
        return self._request("GET", f"/api/browser/{browser_id}")

    def close_browser(self, browser_id: str) -> Dict[str, Any]:
        """Close a specific browser and all of its contexts/pages.
        Returns: {message}.
        """
        return self._request("DELETE", f"/api/browser/{browser_id}")

    def close_all_browsers(self) -> Dict[str, Any]:
        """Close every active browser. Useful for cleanup at the end of a task.
        Returns: {closed: <count>}.
        """
        return self._request("DELETE", "/api/browsers")

    # ================================================================== #
    #  CONTEXT MANAGEMENT                                                #
    # ================================================================== #

    def create_context(
        self,
        browser_id: str,
        context_id: Optional[str] = None,
        user_agent: Optional[str] = None,
        viewport: Optional[Dict[str, int]] = None,
        locale: Optional[str] = None,
        timezone_id: Optional[str] = None,
        geolocation: Optional[Dict[str, Any]] = None,
        permissions: Optional[List[str]] = None,
        storage_state: Optional[Any] = None,
        color_scheme: Optional[str] = None,
        ignore_https_errors: Optional[bool] = None,
        is_mobile: Optional[bool] = None,
        has_touch: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Create an isolated browser context (separate cookies/storage/cache) inside a browser.
        Use this to run independent sessions (e.g. logged-in vs anonymous) in one browser.

        Returns: {id} — pass this as context_id when creating pages.
        """
        body: Dict[str, Any] = {}
        if context_id:
            body["contextId"] = context_id
        if user_agent:
            body["userAgent"] = user_agent
        if viewport:
            body["viewport"] = viewport
        if locale:
            body["locale"] = locale
        if timezone_id:
            body["timezoneId"] = timezone_id
        if geolocation:
            body["geolocation"] = geolocation
        if permissions:
            body["permissions"] = permissions
        if storage_state is not None:
            body["storageState"] = storage_state
        if color_scheme:
            body["colorScheme"] = color_scheme
        if ignore_https_errors is not None:
            body["ignoreHTTPSErrors"] = ignore_https_errors
        if is_mobile is not None:
            body["isMobile"] = is_mobile
        if has_touch is not None:
            body["hasTouch"] = has_touch
        return self._request(
            "POST", f"/api/browser/{browser_id}/context", json_body=body
        )

    def close_context(self, context_id: str) -> Dict[str, Any]:
        """Close a browser context and all of its pages.
        Returns: {message}.
        """
        return self._request("DELETE", f"/api/context/{context_id}")

    # ================================================================== #
    #  PAGE MANAGEMENT                                                   #
    # ================================================================== #

    def new_page(
        self,
        browser_id: str,
        context_id: Optional[str] = None,
        page_id: Optional[str] = None,
        viewport: Optional[Dict[str, int]] = None,
        timeout: Optional[int] = None,
        auto_save_downloads: Optional[bool] = None,
        download_dir: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create a new page (tab) in a browser. If context_id is omitted, a default context is
        created/used automatically.

        Returns: {message, pageId} — keep the pageId; nearly every other tool needs it.
        """
        body: Dict[str, Any] = {}
        if context_id:
            body["contextId"] = context_id
        if page_id:
            body["pageId"] = page_id
        if viewport:
            body["viewport"] = viewport
        if timeout is not None:
            body["timeout"] = timeout
        if auto_save_downloads is not None:
            body["autoSaveDownloads"] = auto_save_downloads
        if download_dir:
            body["downloadDir"] = download_dir
        return self._request("POST", f"/api/browser/{browser_id}/page", json_body=body)

    def list_pages(self, browser_id: Optional[str] = None) -> Dict[str, Any]:
        """List open pages. If browser_id is given, only pages in that browser are returned.
        Returns: {pages: [{id, browserId, url, closed, ...}]}.
        """
        if browser_id:
            return self._request("GET", f"/api/browser/{browser_id}/pages")
        return self._request("GET", "/api/pages")

    def get_page_info(self, page_id: str) -> Dict[str, Any]:
        """Get a page's current id, url, title, and closed state.
        Returns: {id, url, title, isClosed}.
        """
        return self._request("GET", f"/api/page/{page_id}")

    def close_page(self, page_id: str) -> Dict[str, Any]:
        """Close a page. Returns: {message}."""
        return self._request("DELETE", f"/api/page/{page_id}")

    def bring_to_front(self, page_id: str) -> Dict[str, Any]:
        """Bring a page to the front of its window (focus it). Returns: {ok}."""
        return self._request("POST", f"/api/page/{page_id}/bring-to-front")

    # ================================================================== #
    #  NAVIGATION                                                        #
    # ================================================================== #

    def goto(
        self,
        page_id: str,
        url: str,
        wait_until: str = "load",
        timeout: Optional[int] = None,
        referer: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Navigate the page to a URL. wait_until controls when navigation is considered done
        ('load', 'domcontentloaded', 'networkidle', 'commit').

        Returns: {status, ok, url, title}.
        """
        body: Dict[str, Any] = {"url": url, "waitUntil": wait_until}
        if timeout is not None:
            body["timeout"] = timeout
        if referer:
            body["referer"] = referer
        return self._request("POST", f"/api/page/{page_id}/goto", json_body=body)

    def go_back(self, page_id: str, wait_until: str = "load") -> Dict[str, Any]:
        """Navigate back one step in history. Returns: {status, url, title}."""
        return self._request(
            "POST", f"/api/page/{page_id}/back", json_body={"waitUntil": wait_until}
        )

    def go_forward(self, page_id: str, wait_until: str = "load") -> Dict[str, Any]:
        """Navigate forward one step in history. Returns: {status, url, title}."""
        return self._request(
            "POST", f"/api/page/{page_id}/forward", json_body={"waitUntil": wait_until}
        )

    def reload(self, page_id: str, wait_until: str = "load") -> Dict[str, Any]:
        """Reload the current page. Returns: {status, url, title}."""
        return self._request(
            "POST", f"/api/page/{page_id}/reload", json_body={"waitUntil": wait_until}
        )

    # ================================================================== #
    #  WAITS                                                             #
    # ================================================================== #

    def wait_for_selector(
        self,
        page_id: str,
        selector: str,
        state: str = "visible",
        timeout: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Wait until an element matching the CSS selector reaches the given state
        ('visible', 'hidden', 'attached', 'detached'). Returns element info when found.
        """
        body: Dict[str, Any] = {"selector": selector, "state": state}
        if timeout is not None:
            body["timeout"] = timeout
        return self._request(
            "POST", f"/api/page/{page_id}/wait/selector", json_body=body
        )

    def wait_for_url(
        self, page_id: str, url: str, wait_until: str = "load"
    ) -> Dict[str, Any]:
        """Wait until the page URL matches a string or '*' wildcard pattern.
        Returns: {url, title}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/wait/url",
            json_body={"url": url, "waitUntil": wait_until},
        )

    def wait_for_load_state(self, page_id: str, state: str = "load") -> Dict[str, Any]:
        """Wait for a load state: 'load', 'domcontentloaded', or 'networkidle'.
        Returns: {ok, state}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/wait/load-state", json_body={"state": state}
        )

    def wait_for_function(
        self,
        page_id: str,
        script: str,
        arg: Optional[Any] = None,
        mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Wait until a JS expression (or function, with mode='function') returns truthy in the
        page. Returns: {ok, value}.
        """
        body: Dict[str, Any] = {"script": script}
        if arg is not None:
            body["arg"] = arg
        if mode:
            body["mode"] = mode
        return self._request(
            "POST", f"/api/page/{page_id}/wait/function", json_body=body
        )

    def wait_for_timeout(self, page_id: str, ms: int = 1000) -> Dict[str, Any]:
        """Pause for a fixed number of milliseconds. Use sparingly; prefer explicit waits.
        Returns: {ok, ms}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/wait/timeout", json_body={"ms": ms}
        )

    def wait_for_request(self, page_id: str, url_pattern: str) -> Dict[str, Any]:
        """Wait for an outgoing network request whose URL matches a string/'*' pattern.
        Returns: {url, method, resourceType, postData}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/wait/request",
            json_body={"urlPattern": url_pattern},
        )

    def wait_for_response(self, page_id: str, url_pattern: str) -> Dict[str, Any]:
        """Wait for a network response whose URL matches a string/'*' pattern.
        Returns: {url, status, statusText}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/wait/response",
            json_body={"urlPattern": url_pattern},
        )

    def wait_for_network_idle(self, page_id: str) -> Dict[str, Any]:
        """Wait until there are no more than a couple of network connections for ~500ms.
        Returns: {ok}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/wait/network-idle", json_body={}
        )

    # ================================================================== #
    #  CONTENT (non-overridden base endpoints)                           #
    # ================================================================== #

    def get_title(self, page_id: str) -> Dict[str, Any]:
        """Get just the page's document title. Returns: {title}."""
        return self._request("GET", f"/api/page/{page_id}/title")

    def get_url(self, page_id: str) -> Dict[str, Any]:
        """Get just the page's current URL. Returns: {url}."""
        return self._request("GET", f"/api/page/{page_id}/url")

    def set_content(
        self, page_id: str, html: str, wait_until: str = "load"
    ) -> Dict[str, Any]:
        """Replace the page's DOM with the given HTML string (no network navigation).
        Returns: {url, title}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/set-content",
            json_body={"html": html, "waitUntil": wait_until},
        )

    def get_accessibility_snapshot(
        self, page_id: str, interesting_only: bool = True
    ) -> Dict[str, Any]:
        """Get the page's accessibility tree (roles, names, values). Set interesting_only=False
        for the full tree. Returns: {accessibility}.
        """
        return self._request(
            "GET",
            f"/api/page/{page_id}/accessibility",
            params={"interestingOnly": str(interesting_only).lower()},
        )

    def get_frames(self, page_id: str) -> Dict[str, Any]:
        """List all frames/iframes on the page with index, url, name, and parent.
        Returns: {frames: [...]}.
        """
        return self._request("GET", f"/api/page/{page_id}/frames")

    # ================================================================== #
    #  SCREENSHOT / PDF                                                  #
    # ================================================================== #

    def screenshot(
        self,
        page_id: str,
        full_page: bool = True,
        image_type: str = "png",
        quality: Optional[int] = None,
        clip: Optional[Dict[str, int]] = None,
        omit_background: bool = False,
        path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Capture a screenshot. Returns base64 image data by default, or {path, bytes} if
        `path` is provided (saved server-side). image_type is 'png' or 'jpeg'.
        """
        body: Dict[str, Any] = {
            "fullPage": full_page,
            "type": image_type,
            "omitBackground": omit_background,
        }
        if quality is not None:
            body["quality"] = quality
        if clip:
            body["clip"] = clip
        if path:
            body["path"] = path
        return self._request("POST", f"/api/page/{page_id}/screenshot", json_body=body)

    def pdf(
        self,
        page_id: str,
        path: Optional[str] = None,
        landscape: Optional[bool] = None,
        print_background: Optional[bool] = None,
        format: Optional[str] = None,
        page_ranges: Optional[str] = None,
        scale: Optional[float] = None,
        margin: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Render the page to PDF. Returns base64 data, or {path, bytes} if `path` is given."""
        body: Dict[str, Any] = {}
        if path:
            body["path"] = path
        if landscape is not None:
            body["landscape"] = landscape
        if print_background is not None:
            body["printBackground"] = print_background
        if format:
            body["format"] = format
        if page_ranges:
            body["pageRanges"] = page_ranges
        if scale is not None:
            body["scale"] = scale
        if margin:
            body["margin"] = margin
        return self._request("POST", f"/api/page/{page_id}/pdf", json_body=body)

    # ================================================================== #
    #  ACTIONS                                                           #
    # ================================================================== #

    def click(
        self,
        page_id: str,
        selector: str,
        button: Optional[str] = None,
        click_count: Optional[int] = None,
        modifiers: Optional[List[str]] = None,
        force: bool = False,
        timeout: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Click the first element matching a CSS selector. button: 'left'|'right'|'middle'.
        modifiers e.g. ['Shift','Control']. Returns: {clicked, url, title}.
        """
        body: Dict[str, Any] = {"selector": selector, "force": force}
        if button:
            body["button"] = button
        if click_count is not None:
            body["clickCount"] = click_count
        if modifiers:
            body["modifiers"] = modifiers
        if timeout is not None:
            body["timeout"] = timeout
        return self._request("POST", f"/api/page/{page_id}/click", json_body=body)

    def dblclick(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Double-click the first element matching a CSS selector. Returns: {dblclicked}."""
        return self._request(
            "POST", f"/api/page/{page_id}/dblclick", json_body={"selector": selector}
        )

    def right_click(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Right-click (context click) the first element matching a CSS selector.
        Returns: {clicked, url, title}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/right-click", json_body={"selector": selector}
        )

    def click_text(
        self, page_id: str, text: str, exact: bool = False
    ) -> Dict[str, Any]:
        """Click the first element whose visible text matches `text`. Set exact=True for a full
        match. Great when you don't know the CSS selector. Returns: {clickedText, url, title}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/click-text",
            json_body={"text": text, "exact": exact},
        )

    def click_role(
        self,
        page_id: str,
        role: str,
        name: Optional[str] = None,
        exact: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Click the first element with a given ARIA role (e.g. 'button', 'link', 'checkbox'),
        optionally filtered by accessible name. Returns: {clickedRole, url, title}.
        """
        body: Dict[str, Any] = {"role": role}
        if name is not None:
            body["name"] = name
        if exact is not None:
            body["exact"] = exact
        return self._request("POST", f"/api/page/{page_id}/click-role", json_body=body)

    def hover(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Hover the mouse over the first element matching a CSS selector (to reveal menus etc).
        Returns: {hovered}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/hover", json_body={"selector": selector}
        )

    def focus(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Give keyboard focus to the first element matching a CSS selector. Returns: {focused}."""
        return self._request(
            "POST", f"/api/page/{page_id}/focus", json_body={"selector": selector}
        )

    def check(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Check a checkbox or radio button (no-op if already checked). Returns: {checked}."""
        return self._request(
            "POST", f"/api/page/{page_id}/check", json_body={"selector": selector}
        )

    def uncheck(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Uncheck a checkbox (no-op if already unchecked). Returns: {unchecked}."""
        return self._request(
            "POST", f"/api/page/{page_id}/uncheck", json_body={"selector": selector}
        )

    def fill(
        self, page_id: str, selector: str, value: str, timeout: Optional[int] = None
    ) -> Dict[str, Any]:
        """Clear and fill an input/textarea with `value` (fast, no per-key events).
        Returns: {filled}.
        """
        body: Dict[str, Any] = {"selector": selector, "value": value}
        if timeout is not None:
            body["timeout"] = timeout
        return self._request("POST", f"/api/page/{page_id}/fill", json_body=body)

    def type(
        self, page_id: str, selector: str, text: str, delay: int = 10
    ) -> Dict[str, Any]:
        """Type text into an input character-by-character (triggers key events; use for
        autocomplete/search boxes). Returns: {typed}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/type",
            json_body={"selector": selector, "text": text, "delay": delay},
        )

    def press(
        self, page_id: str, key: str, selector: Optional[str] = None
    ) -> Dict[str, Any]:
        """Press a keyboard key (e.g. 'Enter', 'Tab', 'ArrowDown'). If selector is given, the key
        is pressed on that element; otherwise on the page. Returns: {pressed}.
        """
        body: Dict[str, Any] = {"key": key}
        if selector:
            body["selector"] = selector
        return self._request("POST", f"/api/page/{page_id}/press", json_body=body)

    def keyboard_type(self, page_id: str, text: str, delay: int = 10) -> Dict[str, Any]:
        """Type text at the page level (into whatever currently has focus). Returns: {typed}."""
        return self._request(
            "POST",
            f"/api/page/{page_id}/keyboard-type",
            json_body={"text": text, "delay": delay},
        )

    def keyboard_press(self, page_id: str, key: str) -> Dict[str, Any]:
        """Press a key at the page level. Returns: {pressed}."""
        return self._request(
            "POST", f"/api/page/{page_id}/keyboard-press", json_body={"key": key}
        )

    def mouse_click(
        self, page_id: str, x: int, y: int, button: Optional[str] = None
    ) -> Dict[str, Any]:
        """Click at exact viewport coordinates. Returns: {clickedAt: {x, y}}."""
        body: Dict[str, Any] = {"x": x, "y": y}
        if button:
            body["button"] = button
        return self._request("POST", f"/api/page/{page_id}/mouse-click", json_body=body)

    def mouse_move(
        self, page_id: str, x: int, y: int, steps: Optional[int] = None
    ) -> Dict[str, Any]:
        """Move the mouse to viewport coordinates. Returns: {movedTo: {x, y}}."""
        body: Dict[str, Any] = {"x": x, "y": y}
        if steps is not None:
            body["steps"] = steps
        return self._request("POST", f"/api/page/{page_id}/mouse-move", json_body=body)

    def mouse_wheel(
        self, page_id: str, delta_x: int = 0, delta_y: int = 0
    ) -> Dict[str, Any]:
        """Scroll via the mouse wheel. Positive delta_y scrolls down. Returns: {scrolled}."""
        return self._request(
            "POST",
            f"/api/page/{page_id}/mouse-wheel",
            json_body={"deltaX": delta_x, "deltaY": delta_y},
        )

    def select_option(
        self, page_id: str, selector: str, values: List[str]
    ) -> Dict[str, Any]:
        """Select option(s) in a <select> by value(s). Returns: {selector, selected}."""
        return self._request(
            "POST",
            f"/api/page/{page_id}/select",
            json_body={"selector": selector, "values": values},
        )

    def set_input_files(
        self, page_id: str, selector: str, files: List[Any]
    ) -> Dict[str, Any]:
        """Attach file(s) to a file input. Each file is a server-side path string or an object
        {name, mimeType, base64}. Returns: {ok}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/set-input-files",
            json_body={"selector": selector, "files": files},
        )

    def drag_and_drop(self, page_id: str, source: str, target: str) -> Dict[str, Any]:
        """Drag the element matching `source` onto the element matching `target` (both CSS
        selectors). Returns: {dragged: {source, target}}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/drag",
            json_body={"source": source, "target": target},
        )

    def fill_by_label(
        self, page_id: str, label: str, value: str, exact: bool = False
    ) -> Dict[str, Any]:
        """Fill the form control associated with a given label text. Handy when selectors are
        unstable. Returns: {filledByLabel}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/fill-by-label",
            json_body={"label": label, "value": value, "exact": exact},
        )

    def select_by_label(
        self, page_id: str, label: str, values: List[str], exact: bool = False
    ) -> Dict[str, Any]:
        """Select option(s) in the <select> associated with a given label text.
        Returns: {selectedByLabel, selected}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/select-by-label",
            json_body={"label": label, "values": values, "exact": exact},
        )

    # ================================================================== #
    #  QUERIES                                                           #
    # ================================================================== #

    def get_element(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Get the first element matching a CSS selector: tag, text, value, attributes, bounding
        box, visibility. Returns {found: false} if absent.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/element", json_body={"selector": selector}
        )

    def get_elements(
        self, page_id: str, selector: str, limit: int = 100
    ) -> Dict[str, Any]:
        """Get all elements matching a CSS selector (up to limit). Returns: {count, elements}."""
        return self._request(
            "POST",
            f"/api/page/{page_id}/elements",
            json_body={"selector": selector, "limit": limit},
        )

    def count(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Count elements matching a CSS selector. Returns: {selector, count}."""
        return self._request(
            "POST", f"/api/page/{page_id}/count", json_body={"selector": selector}
        )

    def get_text(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Get the inner text of the first element matching a CSS selector (POST /text — distinct
        from the page-wide embedded get_text). Returns: {selector, text}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/text", json_body={"selector": selector}
        )

    def get_inner_html(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Get the innerHTML of the first element matching a CSS selector. Returns: {selector, html}."""
        return self._request(
            "POST", f"/api/page/{page_id}/inner-html", json_body={"selector": selector}
        )

    def get_attribute(
        self, page_id: str, selector: str, attribute: str
    ) -> Dict[str, Any]:
        """Get one attribute's value from the first element matching a CSS selector.
        Returns: {selector, attribute, value}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/attribute",
            json_body={"selector": selector, "attribute": attribute},
        )

    def get_value(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Get the current value of an input/textarea/select. Returns: {selector, value}."""
        return self._request(
            "POST", f"/api/page/{page_id}/value", json_body={"selector": selector}
        )

    def is_visible(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Check whether the first matching element is visible. Returns: {selector, visible}."""
        return self._request(
            "POST", f"/api/page/{page_id}/visible", json_body={"selector": selector}
        )

    def is_enabled(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Check whether the first matching element is enabled. Returns: {selector, enabled}."""
        return self._request(
            "POST", f"/api/page/{page_id}/enabled", json_body={"selector": selector}
        )

    def is_checked(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Check whether a checkbox/radio is checked. Returns: {selector, checked}."""
        return self._request(
            "POST", f"/api/page/{page_id}/checked", json_body={"selector": selector}
        )

    def get_bounding_box(self, page_id: str, selector: str) -> Dict[str, Any]:
        """Get the bounding box (x, y, width, height) of the first matching element.
        Returns: {selector, boundingBox}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/bounding-box",
            json_body={"selector": selector},
        )

    def extract(self, page_id: str, spec: Dict[str, Any]) -> Dict[str, Any]:
        """Extract structured data using a spec. Each key maps to {selector, all?, limit?,
        text?/html?/value?/attribute?/attributes?/boundingBox?}. Example:
        {"title": {"selector": "h1", "text": true},
         "links": {"selector": "a", "all": true, "limit": 20, "text": true, "attributes": ["href"]}}.
        Returns: {data}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/extract", json_body={"spec": spec}
        )

    # ================================================================== #
    #  EVALUATION                                                        #
    # ================================================================== #

    def evaluate(
        self,
        page_id: str,
        script: str,
        arg: Optional[Any] = None,
        mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run JavaScript in the page's main frame and return the result. Use mode='function' to
        treat script as a function receiving `arg`. Returns: {result}.
        """
        body: Dict[str, Any] = {"script": script}
        if arg is not None:
            body["arg"] = arg
        if mode:
            body["mode"] = mode
        return self._request("POST", f"/api/page/{page_id}/evaluate", json_body=body)

    def evaluate_in_frame(
        self,
        page_id: str,
        script: str,
        arg: Optional[Any] = None,
        index: Optional[int] = None,
        name: Optional[str] = None,
        url: Optional[str] = None,
        mode: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Run JavaScript inside a specific iframe, selected by index, name, or url pattern
        (defaults to the main frame). Returns: {result}.
        """
        body: Dict[str, Any] = {"script": script}
        if arg is not None:
            body["arg"] = arg
        if index is not None:
            body["index"] = index
        if name:
            body["name"] = name
        if url:
            body["url"] = url
        if mode:
            body["mode"] = mode
        return self._request(
            "POST", f"/api/page/{page_id}/evaluate-frame", json_body=body
        )

    # ================================================================== #
    #  COOKIES                                                           #
    # ================================================================== #

    def get_cookies(
        self, page_id: str, urls: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Get cookies for the page (or for specific urls if provided). Returns: {cookies}."""
        params = {"urls": ",".join(urls)} if urls else None
        return self._request("GET", f"/api/page/{page_id}/cookies", params=params)

    def set_cookies(
        self, page_id: str, cookies: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Add cookies to the page's context. Each cookie needs at least name, value, and
        url (or domain/path). Returns: {ok}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/cookies", json_body={"cookies": cookies}
        )

    def clear_cookies(self, page_id: str) -> Dict[str, Any]:
        """Clear all cookies in the page's context. Returns: {ok}."""
        return self._request("DELETE", f"/api/page/{page_id}/cookies")

    # ================================================================== #
    #  STORAGE                                                           #
    # ================================================================== #

    def get_storage(
        self, page_id: str, storage_type: str = "local", key: Optional[str] = None
    ) -> Dict[str, Any]:
        """Read localStorage or sessionStorage (storage_type='local'|'session'). If key is
        omitted, returns all entries. Returns: {value}.
        """
        params = {"key": key} if key else None
        return self._request(
            "GET", f"/api/page/{page_id}/storage/{storage_type}", params=params
        )

    def storage_operation(
        self,
        page_id: str,
        operation: str,
        storage_type: str = "local",
        key: Optional[str] = None,
        value: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Perform a storage operation: 'get', 'set', 'remove', or 'clear' on localStorage or
        sessionStorage. Returns the operation result.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/storage",
            json_body={
                "type": storage_type,
                "operation": operation,
                "key": key,
                "value": value,
            },
        )

    # ================================================================== #
    #  HEADERS                                                           #
    # ================================================================== #

    def set_extra_http_headers(
        self, page_id: str, headers: Dict[str, str]
    ) -> Dict[str, Any]:
        """Set extra HTTP headers sent with every request from this page (e.g. auth or locale
        headers). Returns: {ok}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/headers", json_body={"headers": headers}
        )

    # ================================================================== #
    #  NETWORK / LOGS                                                    #
    # ================================================================== #

    def get_console(self, page_id: str, limit: int = 100) -> Dict[str, Any]:
        """Get recent console messages and page errors. Returns: {console: [...]}."""
        return self._request(
            "GET", f"/api/page/{page_id}/console", params={"limit": limit}
        )

    def get_requests(self, page_id: str, limit: int = 100) -> Dict[str, Any]:
        """Get recent outgoing network requests. Returns: {requests: [...]}."""
        return self._request(
            "GET", f"/api/page/{page_id}/requests", params={"limit": limit}
        )

    def get_responses(self, page_id: str, limit: int = 100) -> Dict[str, Any]:
        """Get recent network responses. Returns: {responses: [...]}."""
        return self._request(
            "GET", f"/api/page/{page_id}/responses", params={"limit": limit}
        )

    def get_downloads(self, page_id: str, limit: int = 100) -> Dict[str, Any]:
        """Get recent download events (with saved path if auto-save is on). Returns: {downloads}."""
        return self._request(
            "GET", f"/api/page/{page_id}/downloads", params={"limit": limit}
        )

    def get_dialogs(self, page_id: str, limit: int = 100) -> Dict[str, Any]:
        """Get recent alert/confirm/prompt dialogs and how they were handled. Returns: {dialogs}."""
        return self._request(
            "GET", f"/api/page/{page_id}/dialogs", params={"limit": limit}
        )

    def clear_logs(self, page_id: str) -> Dict[str, Any]:
        """Clear all stored console/request/response/download/dialog logs for a page.
        Returns: {ok}.
        """
        return self._request("DELETE", f"/api/page/{page_id}/logs")

    def add_route_rule(self, page_id: str, rule: Dict[str, Any]) -> Dict[str, Any]:
        """Add a network interception rule. rule needs urlPattern and action ('abort'|'fulfill'|
        'continue'), plus optional resourceTypes, status, headers, contentType, bodyBase64,
        method, postData, errorCode. Returns: {count, rules}.
        """
        return self._request(
            "POST", f"/api/page/{page_id}/route/rule", json_body={"rule": rule}
        )

    def clear_route_rules(self, page_id: str) -> Dict[str, Any]:
        """Remove all network interception rules for a page. Returns: {ok}."""
        return self._request("DELETE", f"/api/page/{page_id}/route/rules")

    def block_resources(
        self, page_id: str, resource_types: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Block resource types from loading (default: image, stylesheet, font, media) to speed
        up pages. Returns: {blocked}.
        """
        body = {"resourceTypes": resource_types} if resource_types else {}
        return self._request(
            "POST", f"/api/page/{page_id}/block-resources", json_body=body
        )

    def unblock_resources(self, page_id: str) -> Dict[str, Any]:
        """Stop blocking all resource types. Returns: {blocked: []}."""
        return self._request(
            "POST", f"/api/page/{page_id}/unblock-resources", json_body={}
        )

    # ================================================================== #
    #  DIALOGS                                                           #
    # ================================================================== #

    def set_dialog_handler(
        self, page_id: str, action: str = "dismiss", prompt_text: str = ""
    ) -> Dict[str, Any]:
        """Set how future alert/confirm/prompt dialogs are handled: action='accept' or 'dismiss';
        prompt_text is used for prompts. Returns: {dialogHandler}.
        """
        return self._request(
            "POST",
            f"/api/page/{page_id}/dialog",
            json_body={"action": action, "promptText": prompt_text},
        )

    # ================================================================== #
    #  DOWNLOADS                                                         #
    # ================================================================== #

    def set_download_options(
        self, page_id: str, auto_save: bool = True, directory: Optional[str] = None
    ) -> Dict[str, Any]:
        """Configure automatic saving of downloads. If directory is omitted, a temp dir is used.
        Returns: {autoSaveDownloads, downloadDir}.
        """
        body: Dict[str, Any] = {"autoSave": auto_save}
        if directory:
            body["dir"] = directory
        return self._request(
            "POST", f"/api/page/{page_id}/download-options", json_body=body
        )

    # ================================================================== #
    #  CONVENIENCE COMPOSITES (not raw endpoints)                        #
    # ================================================================== #

    def open_url(
        self, url: str, headless: bool = True, wait_until: str = "load"
    ) -> Dict[str, Any]:
        """Convenience: create a browser, open a page, and navigate to `url` in one step.
        Returns {browser_id, page_id, url, title, status}. Use the returned page_id with all
        other tools.
        """
        browser = self.create_browser(headless=headless)
        if "error" in browser:
            return browser
        browser_id = browser.get("id")
        page = self.new_page(browser_id)
        if "error" in page:
            return page
        page_id = page.get("pageId")
        nav = self.goto(page_id, url, wait_until=wait_until)
        return {"browser_id": browser_id, "page_id": page_id, **nav}
