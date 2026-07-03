// @vitest-environment jsdom

import { cleanup, render } from "../../../test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toast } from "../Toast";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@chakra-ui/react", async () => {
  const actual = await vi.importActual("@chakra-ui/react");
  return {
    ...(actual as object),
    createToaster: () => mocks,
  };
});

describe("Toast", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("calls toaster.create when opened", () => {
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

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "连接已断开",
        type: "error",
        action: { label: "重试", onClick: onAction },
      }),
    );
  });

  it("does not call toaster.create when closed", () => {
    render(
      <Toast
        message="不会显示"
        onClose={() => {}}
        open={false}
      />,
    );

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("auto closes after the configured duration", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    mocks.create.mockReturnValue("toast-id");

    render(
      <Toast
        durationMs={1200}
        message="已保存"
        onClose={onClose}
        open
        tone="success"
      />,
    );

    vi.advanceTimersByTime(1199);
    expect(onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses the toast on unmount", () => {
    mocks.create.mockReturnValue("toast-id");
    const onClose = vi.fn();

    const { unmount } = render(
      <Toast
        message="已保存"
        onClose={onClose}
        open
        tone="success"
      />,
    );

    unmount();
    expect(mocks.dismiss).toHaveBeenCalledWith("toast-id");
  });
});
