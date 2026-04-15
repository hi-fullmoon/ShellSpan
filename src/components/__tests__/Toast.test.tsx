// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toast } from "../Toast";

describe("Toast", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the message and optional action when opened", () => {
    const onClose = vi.fn();
    const onAction = vi.fn();

    render(
      <Toast
        action={{ label: "重试", onClick: onAction }}
        message="连接已断开"
        onClose={onClose}
        open
        tone="error"
      />,
    );

    expect(screen.getByText("连接已断开")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("auto closes after the configured duration", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    render(
      <Toast durationMs={1200} message="已保存" onClose={onClose} open tone="success" />,
    );

    vi.advanceTimersByTime(1199);
    expect(onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    render(<Toast message="不会显示" onClose={() => {}} open={false} />);

    expect(screen.queryByText("不会显示")).toBeNull();
  });
});
