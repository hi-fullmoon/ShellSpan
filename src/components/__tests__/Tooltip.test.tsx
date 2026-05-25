// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "../../test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip, TooltipProvider } from "../Tooltip";

describe("Tooltip", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the trigger children", () => {
    render(
      <TooltipProvider>
        <Tooltip content="Open details">
          <button type="button">Open</button>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  });
});
