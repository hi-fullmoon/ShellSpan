// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    cleanup();
  });

  it("renders saved profiles and forwards button actions", () => {
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
        runtimeLabel="Desktop"
        savedProfiles={profiles}
      />,
    );

    expect(screen.getByText("Desktop")).toBeTruthy();
    expect(screen.getAllByText("3")).toHaveLength(2);
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "新建连接" }));
    fireEvent.click(screen.getByRole("button", { name: /Beta deploy@beta\.example\.com:22/i }));

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
        runtimeLabel="Desktop"
        savedProfiles={[]}
      />,
    );

    expect(screen.getByText("还没有保存的连接配置。")).toBeTruthy();
  });
});
