// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateRestartDialog } from "../UpdateRestartDialog";

describe("UpdateRestartDialog", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing when open is false", () => {
    render(
      <UpdateRestartDialog
        hasActiveSessions={false}
        onInstallNow={vi.fn()}
        onLater={vi.fn()}
        open={false}
        version="0.2.0"
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
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

  it("calls onInstallNow and onLater callbacks", () => {
    const onInstallNow = vi.fn();
    const onLater = vi.fn();

    render(
      <UpdateRestartDialog
        hasActiveSessions={false}
        onInstallNow={onInstallNow}
        onLater={onLater}
        open
        version="0.2.0"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "稍后" }));
    fireEvent.click(screen.getByRole("button", { name: "立即重启安装" }));

    expect(onLater).toHaveBeenCalledTimes(1);
    expect(onInstallNow).toHaveBeenCalledTimes(1);
  });

  it("renders progress text when downloadProgress is provided", () => {
    render(
      <UpdateRestartDialog
        hasActiveSessions={false}
        downloadProgress={48}
        onInstallNow={vi.fn()}
        onLater={vi.fn()}
        open
        version="0.2.0"
      />,
    );

    expect(screen.getByText("下载进度：48%")).toBeTruthy();
  });
});
