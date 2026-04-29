// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollArea } from "../ScrollArea";

describe("ScrollArea", () => {
  afterEach(() => {
    cleanup();
  });

  it("uses vertical scrolling by default", () => {
    render(<ScrollArea data-testid="scroll-area">content</ScrollArea>);

    expect(screen.getByTestId("scroll-area")).toHaveClass("relative", "min-h-0", "overflow-hidden");
    expect(screen.getByTestId("scroll-area").firstElementChild).toHaveClass("overflow-x-hidden", "overflow-y-auto");
  });

  it("supports horizontal orientation", () => {
    render(<ScrollArea data-testid="scroll-area" orientation="horizontal">content</ScrollArea>);

    expect(screen.getByTestId("scroll-area").firstElementChild).toHaveClass("overflow-x-auto", "overflow-y-hidden");
  });

  it("supports both orientations", () => {
    render(<ScrollArea data-testid="scroll-area" orientation="both">content</ScrollArea>);

    expect(screen.getByTestId("scroll-area").firstElementChild).toHaveClass("overflow-auto");
  });
});
