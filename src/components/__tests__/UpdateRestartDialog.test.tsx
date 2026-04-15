// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateRestartDialog } from "../UpdateRestartDialog";

describe("UpdateRestartDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows active-session warning when hasActiveSessions is true", () => {
    render(
      <UpdateRestartDialog
        hasActiveSessions
        onInstallNow={vi.fn()}
        onLater={vi.fn()}
        open
        version="0.2.0"
      />,
    );

    expect(screen.getByText(/重启会中断当前 SSH 会话/)).toBeTruthy();
  });
});
