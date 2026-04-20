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

    const { container } = render(
      <Toast
        action={{ label: "重试", onClick: onAction }}
        message="连接已断开"
        onClose={onClose}
        open
        tone="error"
      />,
    );

    expect(screen.getByText("连接已断开")).toBeTruthy();
    expect(container.ownerDocument.body.lastElementChild?.className).toContain("left-1/2");
    expect(container.ownerDocument.body.lastElementChild?.className).toContain("-translate-x-1/2");
    expect(container.ownerDocument.body.lastElementChild?.className).toContain("top-2");
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

  it("does not auto close while hovered", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();

    render(
      <Toast durationMs={1200} message="已保存" onClose={onClose} open tone="success" />,
    );

    const toast = screen.getByRole("status");
    vi.advanceTimersByTime(700);
    fireEvent.mouseEnter(toast);

    vi.advanceTimersByTime(2000);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseLeave(toast);
    vi.advanceTimersByTime(499);
    expect(onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    render(<Toast message="不会显示" onClose={() => {}} open={false} />);

    expect(screen.queryByText("不会显示")).toBeNull();
  });
});
