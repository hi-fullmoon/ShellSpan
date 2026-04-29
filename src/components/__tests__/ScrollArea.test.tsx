// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollArea } from "../ScrollArea";

describe("ScrollArea", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses vertical scrolling by default", () => {
    render(<ScrollArea data-testid="scroll-area">content</ScrollArea>);

    expect(screen.getByTestId("scroll-area")).toHaveClass("scroll-area", "relative", "min-h-0", "overflow-hidden");
    expect(screen.getByTestId("scroll-area").firstElementChild).toHaveClass("scroll-area-viewport", "overflow-x-hidden", "overflow-y-auto");
  });

  it("supports horizontal orientation", () => {
    render(<ScrollArea data-testid="scroll-area" orientation="horizontal">content</ScrollArea>);

    expect(screen.getByTestId("scroll-area").firstElementChild).toHaveClass("overflow-x-auto", "overflow-y-hidden");
  });

  it("supports both orientations", () => {
    render(<ScrollArea data-testid="scroll-area" orientation="both">content</ScrollArea>);

    expect(screen.getByTestId("scroll-area").firstElementChild).toHaveClass("overflow-auto");
  });

  it("calls onScroll when viewport scrolls", () => {
    const onScroll = vi.fn();
    render(
      <ScrollArea data-testid="scroll-area" onScroll={onScroll}>
        <div style={{ height: "2000px" }}>tall content</div>
      </ScrollArea>,
    );

    const viewport = screen.getByTestId("scroll-area").firstElementChild as HTMLElement;
    fireEvent.scroll(viewport, { target: { scrollTop: 100 } });

    expect(onScroll).toHaveBeenCalledTimes(1);
  });

  it("shows scrollbar on hover when scrollbar=hover", () => {
    render(
      <ScrollArea data-testid="scroll-area" scrollbar="hover">
        <div style={{ height: "2000px" }}>tall content</div>
      </ScrollArea>,
    );

    const scrollArea = screen.getByTestId("scroll-area");
    expect(scrollArea).toHaveClass("scroll-area-scrollbar-hover");
    expect(scrollArea).not.toHaveClass("scroll-area-scrollbar-visible");

    fireEvent.mouseEnter(scrollArea);
    expect(scrollArea).toHaveClass("scroll-area-scrollbar-visible");

    fireEvent.mouseLeave(scrollArea);
    expect(scrollArea).not.toHaveClass("scroll-area-scrollbar-visible");
  });

  it("does not hide scrollbar on mouse leave while dragging", () => {
    render(
      <ScrollArea data-testid="scroll-area" scrollbar="hover">
        <div style={{ height: "2000px" }}>tall content</div>
      </ScrollArea>,
    );

    const scrollArea = screen.getByTestId("scroll-area");
    fireEvent.mouseEnter(scrollArea);

    const thumb = scrollArea.querySelector(".scroll-area-thumb");
    if (thumb) {
      fireEvent.pointerDown(thumb);
      fireEvent.mouseLeave(scrollArea);
      expect(scrollArea).toHaveClass("scroll-area-scrollbar-visible");
    }
  });

  it("applies custom scrollbar size", () => {
    render(
      <ScrollArea data-testid="scroll-area" scrollbarSize={12}>
        <div style={{ height: "2000px" }}>tall content</div>
      </ScrollArea>,
    );

    expect(screen.getByTestId("scroll-area")).toHaveStyle("--scroll-area-size: 12px");
  });
});
