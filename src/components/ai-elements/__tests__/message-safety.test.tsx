// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { KATEX_SAFE_OPTIONS, MessageResponse } from "../message";

afterEach(() => cleanup());

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const html = (md: string) => {
  const { container } = render(<MessageResponse>{md}</MessageResponse>);
  return container;
};

function assertNoActiveContent(c: HTMLElement) {
  expect(c.querySelector("script, iframe, object, embed")).toBeNull();
  for (const el of Array.from(c.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      expect(a.name.startsWith("on"), `${el.tagName} ${a.name}`).toBe(false);
      if (["href", "src", "xlink:href", "action", "formaction"].includes(a.name))
        expect(a.value.trim().toLowerCase()).not.toMatch(/^(javascript|vbscript|data:text\/html)/);
    }
  }
}

describe("assistant message rendering safety (synthetic, no network)", () => {
  it("javascript: markdown links are not clickable script URLs", () => {
    assertNoActiveContent(html("[click](javascript:alert(1)) and [x](JaVaScRiPt:alert(1))"));
  });

  it("raw HTML script / event handlers are stripped", () => {
    assertNoActiveContent(
      html('<script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:1">a</a>'),
    );
  });

  it("KaTeX \\href with javascript: is not trusted", () => {
    const c = html("$$\\href{javascript:alert(1)}{click}$$");
    assertNoActiveContent(c);
    expect(c.querySelector("a")).toBeNull();
  });

  it("KaTeX \\htmlId/\\htmlData are refused without trust", () => {
    const c = html("$$\\htmlId{x}{a}\\htmlData{foo=bar}{b}$$");
    expect(c.querySelector("#x")).toBeNull();
    expect(c.querySelector("[data-foo]")).toBeNull();
  });

  it("renderer options are own, frozen properties with trust false", () => {
    expect(Object.prototype.hasOwnProperty.call(KATEX_SAFE_OPTIONS, "trust")).toBe(true);
    expect(KATEX_SAFE_OPTIONS.trust).toBe(false);
    expect(Object.isFrozen(KATEX_SAFE_OPTIONS)).toBe(true);
  });
});
