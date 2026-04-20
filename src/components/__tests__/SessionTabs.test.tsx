// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../../types";
import { SessionTabs } from "../SessionTabs";

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    isDragging: false,
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

const sessions: SessionState[] = [
  {
    sessionId: "session-1",
    title: "Production",
    host: "prod.example.com",
    port: 22,
    username: "root",
    profile: {
      id: "profile-1",
      name: "Production",
      host: "prod.example.com",
      port: 22,
      username: "root",
      authMethod: "password",
    },
    status: "connected",
    createdAt: 1,
  },
  {
    sessionId: "session-2",
    title: "Staging",
    host: "staging.example.com",
    port: 22,
    username: "deploy",
    profile: {
      id: "profile-2",
      name: "Staging",
      host: "staging.example.com",
      port: 22,
      username: "deploy",
      authMethod: "key",
    },
    status: "connecting",
    createdAt: 2,
  },
];

describe("SessionTabs", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows the empty state when there are no sessions", () => {
    render(
      <SessionTabs
        activeSessionId={undefined}
        onClose={vi.fn()}
        onDragStateChange={vi.fn()}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        sessions={[]}
      />,
    );

    expect(screen.getByText("打开一个主机连接后，这里会出现标签页。")).toBeTruthy();
  });

  it("selects and closes sessions through the tab controls", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <SessionTabs
        activeSessionId="session-1"
        onClose={onClose}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={onSelect}
        sessions={sessions}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Stagingdeploy@staging\.example\.com/i }),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "关闭会话标签" })[1]!);

    expect(onSelect).toHaveBeenCalledWith("session-2");
    expect(onClose).toHaveBeenCalledWith("session-2");
  });

  it("renames a session after a double click and enter commit", () => {
    const onRename = vi.fn();

    render(
      <SessionTabs
        activeSessionId="session-1"
        onClose={vi.fn()}
        onRename={onRename}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        sessions={sessions}
      />,
    );

    fireEvent.doubleClick(screen.getByText("Production"));

    const input = screen.getByDisplayValue("Production");
    fireEvent.change(input, { target: { value: "  Production API  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("session-1", "Production API");
  });

  it("uses theme-aware classes for tab surfaces and subtitles", () => {
    render(
      <SessionTabs
        activeSessionId="session-1"
        onClose={vi.fn()}
        onRename={vi.fn()}
        onReorder={vi.fn()}
        onSelect={vi.fn()}
        sessions={sessions}
      />,
    );

    expect(screen.getByText("Production").closest("[data-session-tab]")).toHaveClass("session-tab");
    expect(screen.getByText("root@prod.example.com")).toHaveClass("session-tab-subtitle");
  });
});
