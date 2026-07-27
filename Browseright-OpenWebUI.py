"""
title: Browseright: Browser Agent
author: Tbvns
version: 0.0.2
license: MIT
description: Minimal browser automation tool. Patchright remains vanilla. All content
processing happens server-side outside the browser. The agent cannot control contexts,
choose IDs, or fetch raw full-page content. Large pages are forced through the embedded
smart-context pipeline.
"""

import requests
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


class Tools:
    class Valves(BaseModel):
        BASE_URL: str = Field(
            default="http://localhost:3000",
            description="Base URL of the hardened browse-embedded server.",
        )
        API_KEY: str = Field(
            default="",
            description="Optional Bearer token if the server is behind auth.",
        )
        REQUEST_TIMEOUT_SECONDS: int = Field(
            default=90,
            description="HTTP timeout for requests to the browser server.",
        )
        DEFAULT_CONTENT_LIMIT: int = Field(
            default=20000,
            description="Maximum characters returned directly. Larger pages are embedded/reranked.",
        )
        DEFAULT_RERANK_TOP_K: int = Field(
            default=6,
            description="Number of final reranked chunks to return for large pages.",
        )
        DEFAULT_CANDIDATE_K: int = Field(
            default=24,
            description="Candidate chunks considered before reranking.",
        )
        DEFAULT_WAIT_TIMEOUT_MS: int = Field(
            default=30000,
            description="Default browser wait/action timeout in milliseconds.",
        )
        VERIFY_SSL: bool = Field(
            default=True,
            description="Verify TLS certificates.",
        )

    def __init__(self):
        self.valves = self.Valves(
            **{
                "BASE_URL": "http://localhost:3000",
                "API_KEY": "",
                "REQUEST_TIMEOUT_SECONDS": 90,
                "DEFAULT_CONTENT_LIMIT": 20000,
                "DEFAULT_RERANK_TOP_K": 6,
                "DEFAULT_CANDIDATE_K": 24,
                "DEFAULT_WAIT_TIMEOUT_MS": 30000,
                "VERIFY_SSL": True,
            }
        )

        self._default_browser_id = None
        self._default_page_id = None

    # ------------------------------------------------------------------
    # Internal helpers. These are not agent tools.
    # ------------------------------------------------------------------

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

            if resp.status_code == 204:
                return {}

            resp.raise_for_status()
            return resp.json()

        except requests.exceptions.HTTPError as e:
            try:
                detail = e.response.json()
            except Exception:
                detail = e.response.text

            return {"error": f"HTTP {e.response.status_code}", "detail": detail}

        except Exception as e:
            return {"error": str(e)}

    def _embedded_params(self, query: Optional[str] = None) -> Dict[str, Any]:
        params: Dict[str, Any] = {
            "limit": self.valves.DEFAULT_CONTENT_LIMIT,
            "topK": self.valves.DEFAULT_RERANK_TOP_K,
            "candidateK": self.valves.DEFAULT_CANDIDATE_K,
        }

        if query:
            params["query"] = query

        return params

    def _ensure_browser(self) -> Any:
        if self._default_browser_id:
            info = self._request("GET", f"/api/browser/{self._default_browser_id}")

            if (
                isinstance(info, dict)
                and not info.get("error")
                and info.get("connected")
            ):
                return self._default_browser_id

        resp = self._request("POST", "/api/browser", json_body={})

        if isinstance(resp, dict) and resp.get("error"):
            return resp

        self._default_browser_id = resp.get("id")
        return self._default_browser_id

    def _clean_pages(self, pages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        cleaned = []

        for p in pages or []:
            cleaned.append(
                {
                    "pageId": p.get("id"),
                    "browserId": p.get("browserId"),
                    "url": p.get("url"),
                    "closed": p.get("closed"),
                }
            )

        return cleaned

    # ------------------------------------------------------------------
    # Agent tools. Keep this list under 15.
    # ------------------------------------------------------------------

    def create_browser(self) -> Dict[str, Any]:
        """
        Create or reuse a managed browser instance.
        The agent cannot choose the browser ID.
        Returns: {browserId}
        """
        result = self._ensure_browser()

        if isinstance(result, dict):
            return result

        return {"browserId": result}

    def open_page(self, url: str, browser_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Open a URL in a new managed page.
        If browser_id is omitted, the default managed browser is used.
        The agent cannot choose the page ID.
        Returns: {browserId, pageId, url, title, status}
        """
        if not url:
            return {"error": "url is required"}

        if not browser_id:
            browser_id = self._default_browser_id

        if not browser_id:
            created = self._ensure_browser()
            if isinstance(created, dict):
                return created
            browser_id = created

        page_resp = self._request(
            "POST",
            f"/api/browser/{browser_id}/page",
            json_body={},
        )

        if isinstance(page_resp, dict) and page_resp.get("error"):
            return page_resp

        page_id = page_resp.get("pageId")

        if not page_id:
            return {"error": "Server did not return pageId", "detail": page_resp}

        self._default_page_id = page_id

        nav = self._request(
            "POST",
            f"/api/page/{page_id}/goto",
            json_body={
                "url": url,
                "waitUntil": "load",
                "timeout": self.valves.DEFAULT_WAIT_TIMEOUT_MS,
            },
        )

        return {
            "browserId": browser_id,
            "pageId": page_id,
            **(nav if isinstance(nav, dict) else {}),
        }

    def list_pages(self, browser_id: Optional[str] = None) -> Dict[str, Any]:
        """
        List open pages.
        Returns: {pages: [{pageId, browserId, url, closed}]}
        """
        if not browser_id:
            browser_id = self._default_browser_id

        if browser_id:
            resp = self._request("GET", f"/api/browser/{browser_id}/pages")
        else:
            resp = self._request("GET", "/api/pages")

        if isinstance(resp, dict) and resp.get("error"):
            return resp

        return {"pages": self._clean_pages(resp.get("pages", []))}

    def navigate(
        self,
        page_id: str,
        url: Optional[str] = None,
        action: str = "goto",
        wait_until: str = "load",
    ) -> Dict[str, Any]:
        """
        Navigate a page.
        action: goto | back | forward | reload
        For goto, url is required.
        """
        if not page_id:
            return {"error": "page_id is required"}

        action = (action or "goto").lower()

        if action == "goto":
            if not url:
                return {"error": "url is required for action=goto"}

            return self._request(
                "POST",
                f"/api/page/{page_id}/goto",
                json_body={
                    "url": url,
                    "waitUntil": wait_until,
                    "timeout": self.valves.DEFAULT_WAIT_TIMEOUT_MS,
                },
            )

        if action == "back":
            return self._request(
                "POST",
                f"/api/page/{page_id}/back",
                json_body={"waitUntil": wait_until},
            )

        if action == "forward":
            return self._request(
                "POST",
                f"/api/page/{page_id}/forward",
                json_body={"waitUntil": wait_until},
            )

        if action == "reload":
            return self._request(
                "POST",
                f"/api/page/{page_id}/reload",
                json_body={"waitUntil": wait_until},
            )

        return {"error": "action must be goto, back, forward, or reload"}

    def read_page(
        self,
        page_id: str,
        query: Optional[str] = None,
        view: str = "markdown",
    ) -> Dict[str, Any]:
        """
        Read page content through the embedded smart-context pipeline only.
        Large pages are never returned raw; they are chunked and reranked.

        view:
          - markdown: cleaned markdown
          - text: plain text
          - html: cleaned HTML
          - context: full smart-context object
        """
        if not page_id:
            return {"error": "page_id is required"}

        view = (view or "markdown").lower()

        if view not in {"markdown", "text", "html", "context"}:
            return {"error": "view must be markdown, text, html, or context"}

        params = self._embedded_params(query)

        if view == "context":
            return self._request("GET", f"/api/page/{page_id}/context", params=params)

        if view == "markdown":
            return self._request("GET", f"/api/page/{page_id}/markdown", params=params)

        if view == "text":
            return self._request("GET", f"/api/page/{page_id}/text", params=params)

        return self._request("GET", f"/api/page/{page_id}/content", params=params)

    def inspect_page(
        self,
        page_id: str,
        query: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Inspect the page surface: title, URL, visible text, links, inputs, buttons,
        and embedded smart context.
        Use this before clicking or filling forms.
        """
        if not page_id:
            return {"error": "page_id is required"}

        params: Dict[str, Any] = {}

        if query:
            params["query"] = query

        return self._request("GET", f"/api/page/{page_id}/snapshot", params=params)

    def click(
        self,
        page_id: str,
        selector: Optional[str] = None,
        text: Optional[str] = None,
        role: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Click an element.

        Provide one of:
          - selector: CSS selector
          - text: visible text
          - role: ARIA role, optionally with name via text
        """
        if not page_id:
            return {"error": "page_id is required"}

        timeout = self.valves.DEFAULT_WAIT_TIMEOUT_MS

        if selector:
            return self._request(
                "POST",
                f"/api/page/{page_id}/click",
                json_body={"selector": selector, "timeout": timeout},
            )

        if text:
            return self._request(
                "POST",
                f"/api/page/{page_id}/click-text",
                json_body={"text": text, "timeout": timeout},
            )

        if role:
            return self._request(
                "POST",
                f"/api/page/{page_id}/click-role",
                json_body={"role": role, "name": text, "timeout": timeout},
            )

        return {"error": "selector, text, or role is required"}

    def fill(
        self,
        page_id: str,
        value: str,
        selector: Optional[str] = None,
        label: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Fill an input or textarea.

        Provide one of:
          - selector: CSS selector
          - label: label text
        """
        if not page_id:
            return {"error": "page_id is required"}

        timeout = self.valves.DEFAULT_WAIT_TIMEOUT_MS
        value = "" if value is None else str(value)

        if selector:
            return self._request(
                "POST",
                f"/api/page/{page_id}/fill",
                json_body={"selector": selector, "value": value, "timeout": timeout},
            )

        if label:
            return self._request(
                "POST",
                f"/api/page/{page_id}/fill-by-label",
                json_body={"label": label, "value": value, "timeout": timeout},
            )

        return {"error": "selector or label is required"}

    def press(
        self,
        page_id: str,
        key: str,
        selector: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Press a keyboard key, for example Enter, Tab, ArrowDown.
        If selector is provided, press on that element; otherwise press on the page.
        """
        if not page_id:
            return {"error": "page_id is required"}

        if not key:
            return {"error": "key is required"}

        body: Dict[str, Any] = {
            "key": key,
            "timeout": self.valves.DEFAULT_WAIT_TIMEOUT_MS,
        }

        if selector:
            body["selector"] = selector

        return self._request("POST", f"/api/page/{page_id}/press", json_body=body)

    def choose(
        self,
        page_id: str,
        values: List[Any],
        selector: Optional[str] = None,
        label: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Select option values in a <select> element.

        Provide one of:
          - selector: CSS selector
          - label: label text
        """
        if not page_id:
            return {"error": "page_id is required"}

        if isinstance(values, str):
            values = [values]

        values = list(values or [])

        timeout = self.valves.DEFAULT_WAIT_TIMEOUT_MS

        if selector:
            return self._request(
                "POST",
                f"/api/page/{page_id}/select",
                json_body={"selector": selector, "values": values, "timeout": timeout},
            )

        if label:
            return self._request(
                "POST",
                f"/api/page/{page_id}/select-by-label",
                json_body={"label": label, "values": values, "timeout": timeout},
            )

        return {"error": "selector or label is required"}

    def wait_for(
        self,
        page_id: str,
        selector: Optional[str] = None,
        url: Optional[str] = None,
        load_state: Optional[str] = None,
        timeout_ms: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Wait for one of:
          - selector
          - url
          - load_state: load | domcontentloaded | networkidle

        If none are provided, waits for network idle.
        """
        if not page_id:
            return {"error": "page_id is required"}

        timeout = timeout_ms or self.valves.DEFAULT_WAIT_TIMEOUT_MS

        if selector:
            return self._request(
                "POST",
                f"/api/page/{page_id}/wait/selector",
                json_body={"selector": selector, "state": "visible", "timeout": timeout},
            )

        if url:
            return self._request(
                "POST",
                f"/api/page/{page_id}/wait/url",
                json_body={"url": url, "waitUntil": "load", "timeout": timeout},
            )

        if load_state:
            return self._request(
                "POST",
                f"/api/page/{page_id}/wait/load-state",
                json_body={"state": load_state, "timeout": timeout},
            )

        return self._request(
            "POST",
            f"/api/page/{page_id}/wait/network-idle",
            json_body={"timeout": timeout},
        )

    def extract(self, page_id: str, spec: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract structured data using a spec.

        Example:
        {
          "title": {"selector": "h1", "text": true},
          "links": {
            "selector": "a",
            "all": true,
            "limit": 20,
            "text": true,
            "attributes": ["href"]
          }
        }
        """
        if not page_id:
            return {"error": "page_id is required"}

        if not spec or not isinstance(spec, dict):
            return {"error": "spec must be an object"}

        return self._request("POST", f"/api/page/{page_id}/extract", json_body={"spec": spec})

    def close_page(self, page_id: str) -> Dict[str, Any]:
        """
        Close a page.
        """
        if not page_id:
            return {"error": "page_id is required"}

        resp = self._request("DELETE", f"/api/page/{page_id}")

        if self._default_page_id == page_id:
            self._default_page_id = None

        return resp

    def close_browser(self, browser_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Close a browser. If browser_id is omitted, closes the default managed browser.
        """
        if not browser_id:
            browser_id = self._default_browser_id

        if not browser_id:
            return {"error": "No browser to close"}

        resp = self._request("DELETE", f"/api/browser/{browser_id}")

        if self._default_browser_id == browser_id:
            self._default_browser_id = None
            self._default_page_id = None

        return resp