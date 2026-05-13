// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initI18n } from "../../lib/i18n";
import type { ConnectionProfile } from "../../types";
import {
  Sidebar,
  countFavoriteProfiles,
  sortSavedProfiles,
} from "../Sidebar";

const profiles: ConnectionProfile[] = [
  {
    id: "profile-1",
    name: "Alpha",
    host: "alpha.example.com",
    port: 22,
    username: "root",
    authMethod: "password",
    pinned: false,
    favorite: true,
  },
  {
    id: "profile-2",
    name: "Beta",
    host: "beta.example.com",
    port: 22,
    username: "deploy",
    authMethod: "key",
    pinned: true,
    favorite: false,
  },
  {
    id: "profile-3",
    name: "Gamma",
    host: "gamma.example.com",
    port: 22,
    username: "ops",
    authMethod: "password",
    pinned: false,
    favorite: false,
  },
];

describe("sortSavedProfiles", () => {
  it("sorts pinned profiles first, then favorites", () => {
    expect(sortSavedProfiles(profiles).map((profile) => profile.id)).toEqual([
      "profile-2",
      "profile-1",
      "profile-3",
    ]);
  });
});

describe("countFavoriteProfiles", () => {
  it("counts only favorite profiles", () => {
    expect(countFavoriteProfiles(profiles)).toBe(1);
  });
});

describe("Sidebar", () => {
  beforeAll(async () => {
    await initI18n("zh-CN");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders saved profiles and forwards button actions", () => {
    vi.useFakeTimers();
    const onOpenConnect = vi.fn();
    const onReuseProfile = vi.fn();

    render(
      <Sidebar
        connectedCount={2}
        onDeleteProfile={vi.fn()}
        onOpenConnect={onOpenConnect}
        onRenameProfile={vi.fn()}
        onReuseProfile={onReuseProfile}
        onToggleFavoriteProfile={vi.fn()}
        onTogglePinnedProfile={vi.fn()}
        onSetProfileColor={vi.fn()}
        runtimeLabel="Desktop"
        savedProfiles={profiles}
      />,
    );

    expect(screen.getByText("Desktop")).toBeTruthy();
    expect(screen.getAllByText("3")).toHaveLength(2);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开设置" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新建连接" }));
    fireEvent.click(screen.getByRole("button", { name: /Beta deploy@beta\.example\.com:22/i }));
    vi.advanceTimersByTime(220);

    expect(onOpenConnect).toHaveBeenCalledTimes(1);
    expect(onReuseProfile).toHaveBeenCalledWith(profiles[1]);
  });

  it("shows the empty history state when no profiles are saved", () => {
    render(
      <Sidebar
        connectedCount={0}
        onDeleteProfile={vi.fn()}
        onOpenConnect={vi.fn()}
        onRenameProfile={vi.fn()}
        onReuseProfile={vi.fn()}
        onToggleFavoriteProfile={vi.fn()}
        onTogglePinnedProfile={vi.fn()}
        onSetProfileColor={vi.fn()}
        runtimeLabel="Desktop"
        savedProfiles={[]}
      />,
    );

    expect(screen.getByText("还没有保存的连接配置。")).toBeTruthy();
  });

  it("wraps the history list with the shared scroll area", () => {
    const { container } = render(
      <Sidebar
        connectedCount={2}
        onDeleteProfile={vi.fn()}
        onOpenConnect={vi.fn()}
        onRenameProfile={vi.fn()}
        onReuseProfile={vi.fn()}
        onToggleFavoriteProfile={vi.fn()}
        onTogglePinnedProfile={vi.fn()}
        onSetProfileColor={vi.fn()}
        runtimeLabel="Desktop"
        savedProfiles={profiles}
      />,
    );

    expect(container.querySelector(".scroll-area")).toBeTruthy();
  });

  it("opens the rename dialog on double click without reusing the profile", () => {
    vi.useFakeTimers();
    const onReuseProfile = vi.fn();

    render(
      <Sidebar
        connectedCount={2}
        onDeleteProfile={vi.fn()}
        onOpenConnect={vi.fn()}
        onRenameProfile={vi.fn()}
        onReuseProfile={onReuseProfile}
        onToggleFavoriteProfile={vi.fn()}
        onTogglePinnedProfile={vi.fn()}
        onSetProfileColor={vi.fn()}
        runtimeLabel="Desktop"
        savedProfiles={profiles}
      />,
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: /Beta deploy@beta\.example\.com:22/i }));

    expect(screen.getByRole("dialog", { name: "重命名历史连接" })).toBeTruthy();
    expect(screen.getByDisplayValue("Beta")).toBeTruthy();
    expect(onReuseProfile).not.toHaveBeenCalled();
  });

  it("uses theme-aware classes for the history context menu and rename dialog", () => {
    render(
      <Sidebar
        connectedCount={2}
        onDeleteProfile={vi.fn()}
        onOpenConnect={vi.fn()}
        onRenameProfile={vi.fn()}
        onReuseProfile={vi.fn()}
        onToggleFavoriteProfile={vi.fn()}
        onTogglePinnedProfile={vi.fn()}
        onSetProfileColor={vi.fn()}
        runtimeLabel="Desktop"
        savedProfiles={profiles}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /Beta deploy@beta\.example\.com:22/i }));

    expect(screen.getByRole("button", { name: "重命名" }).parentElement).toHaveClass("themed-menu");
    expect(screen.getByRole("button", { name: "重命名" })).toHaveClass("themed-menu-item");

    fireEvent.click(screen.getByRole("button", { name: "重命名" }));

    expect(screen.getByText("修改历史连接名称")).toHaveClass("themed-heading");
    expect(screen.getByPlaceholderText("输入连接名称")).toHaveClass("themed-input");
  });

});
