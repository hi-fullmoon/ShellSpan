// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getThumbMetrics, ScrollArea } from "../ScrollArea";
import styles from "../../styles.css?raw";

describe("ScrollArea", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "MutationObserver",
      class MutationObserver {
        observe() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses vertical scrolling by default", () => {
    render(<ScrollArea data-testid="scroll-area">content</ScrollArea>);

    expect(screen.getByTestId("scroll-area")).toHaveClass("scroll-area", "min-h-0", "overflow-hidden");
    expect(screen.getByTestId("scroll-area").querySelector(".scroll-area-viewport")).toHaveClass("overflow-x-hidden", "overflow-y-auto");
  });

  it("uses a viewport div and hover scrollbar mode", () => {
    render(
      <ScrollArea data-testid="scroll-area" orientation="horizontal" scrollbar="hover">
        content
      </ScrollArea>,
    );

    expect(screen.getByTestId("scroll-area")).toHaveClass(
      "scroll-area",
      "scroll-area-scrollbar-hover",
    );
    expect(screen.getByTestId("scroll-area").querySelector(".scroll-area-viewport")).toHaveClass("overflow-x-auto", "overflow-y-hidden");
  });

  it("keeps hover scrollbars visible until the pointer leaves", () => {
    render(
      <ScrollArea data-testid="scroll-area" orientation="horizontal" scrollbar="hover">
        content
      </ScrollArea>,
    );

    const area = screen.getByTestId("scroll-area");

    fireEvent.mouseEnter(area);
    expect(area).toHaveClass("scroll-area-scrollbar-visible");

    fireEvent.mouseLeave(area);
    expect(area).not.toHaveClass("scroll-area-scrollbar-visible");
  });

  it("maps horizontal thumb metrics to the actual track width", () => {
    expect(getThumbMetrics(200, 100, 100, 88)).toEqual({
      hasOverflow: true,
      offset: 44,
      size: 44,
    });
  });

  it("supports overriding the custom scrollbar thickness", () => {
    render(
      <ScrollArea data-testid="scroll-area" scrollbarSize={4}>
        content
      </ScrollArea>,
    );

    expect(screen.getByTestId("scroll-area")).toHaveStyle("--scroll-area-size: 4px");
  });

  it("does not keep hover scrollbars visible via focus-within styles", () => {
    expect(styles).not.toContain(".scroll-area-scrollbar-hover:focus-within .scroll-area-track");
  });

  it("keeps the hover scrollbar visible while dragging even after leaving the area", () => {
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList.contains("scroll-area-viewport") ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("scroll-area-viewport") ? 40 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        return this.classList.contains("scroll-area-viewport") ? 200 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("scroll-area-viewport") ? 40 : 0;
      },
    });

    try {
      render(
        <ScrollArea data-testid="scroll-area" orientation="horizontal" scrollbar="hover">
          content
        </ScrollArea>,
      );

      const area = screen.getByTestId("scroll-area");
      const thumb = area.querySelector(".scroll-area-thumb-horizontal");
      expect(thumb).toBeTruthy();

      fireEvent.mouseEnter(area);
      fireEvent.pointerDown(thumb!, { clientX: 10 });
      fireEvent.mouseLeave(area);
      expect(area).toHaveClass("scroll-area-scrollbar-visible");

      fireEvent.pointerUp(window);
      expect(area).not.toHaveClass("scroll-area-scrollbar-visible");
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
      }
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      }
      if (originalScrollWidth) {
        Object.defineProperty(HTMLElement.prototype, "scrollWidth", originalScrollWidth);
      }
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      }
    }
  });
});
