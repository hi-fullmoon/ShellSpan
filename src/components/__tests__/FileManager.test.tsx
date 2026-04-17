// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { forwardRef } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../../types";

vi.mock("ag-grid-community", () => ({
  AllCommunityModule: {},
  ModuleRegistry: {
    registerModules: vi.fn(),
  },
}));

vi.mock("ag-grid-react", () => ({
  AgGridReact: forwardRef(function AgGridReact(
    { rowData }: { rowData?: Array<{ path: string; name: string }> },
    _ref,
  ) {
    return (
      <div data-testid="file-grid">
        {rowData?.map((entry) => (
          <div key={entry.path}>{entry.name}</div>
        ))}
      </div>
    );
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn(async () => vi.fn()),
  }),
}));

vi.mock("../../lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../../lib/tauri", () => ({
  isTauriRuntime: () => false,
}));

import { FileManager } from "../FileManager";
import { useFileManagerStore } from "../../stores/fileManagerStore";

const disconnectedSession: SessionState = {
  sessionId: "session-1",
  title: "Demo",
  host: "demo.example.com",
  port: 22,
  username: "root",
  status: "disconnected",
  createdAt: Date.now(),
  profile: {
    id: "profile-1",
    name: "Demo",
    host: "demo.example.com",
    port: 22,
    username: "root",
    authMethod: "password",
  },
};

describe("FileManager", () => {
  beforeEach(() => {
    useFileManagerStore.setState({
      sessions: {
        "session-1": {
          pathInput: "/var/www",
          listing: {
            path: "/var/www",
            parentPath: "/var",
            entries: [
              {
                path: "/var/www/keep.txt",
                name: "keep.txt",
                kind: "file",
              },
            ],
          },
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    useFileManagerStore.setState({ sessions: {} });
  });

  it("keeps the current listing visible but switches to read-only when the session disconnects", () => {
    render(<FileManager session={disconnectedSession} />);

    expect(screen.getByText("keep.txt")).toBeInTheDocument();
    expect(screen.getByText("终端已断开，文件管理器当前仅支持查看。")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("输入远程路径并回车")).toBeDisabled();
    expect(screen.getByTitle("返回上级目录")).toBeDisabled();
    expect(screen.getByTitle("刷新")).toBeDisabled();
    expect(screen.getByTitle("更多操作")).toBeDisabled();
  });
});
