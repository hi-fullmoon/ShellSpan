// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useLocalStorage } from "../useLocalStorage";

describe("useLocalStorage", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("hydrates from the current storage key", () => {
    window.localStorage.setItem("termbridge.theme", JSON.stringify("light"));

    const { result } = renderHook(() =>
      useLocalStorage("termbridge.theme", "dark"),
    );

    expect(result.current[0]).toBe("light");
  });

  it("falls back to the first legacy key with a stored value", () => {
    window.localStorage.setItem("legacy.theme", JSON.stringify("light"));

    const { result } = renderHook(() =>
      useLocalStorage("termbridge.theme", "dark", ["older.theme", "legacy.theme"]),
    );

    expect(result.current[0]).toBe("light");
  });

  it("uses the initial value when storage contains invalid json", () => {
    window.localStorage.setItem("termbridge.theme", "{not-valid-json");

    const { result } = renderHook(() =>
      useLocalStorage("termbridge.theme", "dark"),
    );

    expect(result.current[0]).toBe("dark");
  });

  it("persists updates back to localStorage", async () => {
    const { result } = renderHook(() =>
      useLocalStorage("termbridge.theme", "dark"),
    );

    act(() => {
      result.current[1]("light");
    });

    await waitFor(() => {
      expect(window.localStorage.getItem("termbridge.theme")).toBe(
        JSON.stringify("light"),
      );
    });
  });
});
