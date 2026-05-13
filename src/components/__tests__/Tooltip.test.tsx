// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipProvider } from "../Tooltip";

describe("Tooltip", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows the tooltip when mouse move follows mouse enter before it appears", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      window.clearTimeout(handle);
    });

    render(
      <TooltipProvider>
        <Tooltip content="Open details">
          <button type="button">Open</button>
        </Tooltip>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.mouseEnter(trigger, { clientX: 40, clientY: 50 });
    fireEvent.mouseMove(trigger, { clientX: 42, clientY: 52 });

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      vi.advanceTimersByTime(32);
    });

    expect(screen.getByText("Open details")).toHaveStyle({ opacity: "1" });
  });
});
