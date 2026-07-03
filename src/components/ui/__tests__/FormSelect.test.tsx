// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FormSelect } from "../FormSelect";
import { ChakraProvider } from "../ChakraProvider";
import { Dialog, DialogPanel } from "../Dialog";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ChakraProvider>{children}</ChakraProvider>
);

describe("FormSelect", () => {
  beforeAll(() => {
    class MockResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as any).ResizeObserver = MockResizeObserver;
    (Element.prototype as any).scrollTo = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("calls onChange when selecting an option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <FormSelect
        value="a"
        onChange={onChange}
        options={[
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
        ]}
      />,
      { wrapper }
    );

    const trigger = screen.getByRole("combobox");
    await user.click(trigger);

    await user.click(screen.getByRole("option", { name: "Option B" }));

    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("calls onChange when selecting an option inside a dialog", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onClose = vi.fn();

    render(
      <Dialog open onClose={onClose}>
        <DialogPanel ariaLabel="Test dialog">
          <FormSelect
            value="a"
            onChange={onChange}
            options={[
              { label: "Option A", value: "a" },
              { label: "Option B", value: "b" },
            ]}
          />
        </DialogPanel>
      </Dialog>,
      { wrapper }
    );

    const trigger = screen.getByRole("combobox");
    await user.click(trigger);

    await user.click(screen.getByRole("option", { name: "Option B" }));

    expect(onChange).toHaveBeenCalledWith("b");
    expect(onClose).not.toHaveBeenCalled();
  });
});
