// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { forwardRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    {
      rowData,
      onCellContextMenu,
      onRowClicked,
    }: {
      rowData?: Array<{ path: string; name: string; kind: string }>;
      onCellContextMenu?: (event: { data: { path: string; name: string; kind: string }; event: MouseEvent }) => void;
      onRowClicked?: (event: { data: { path: string; name: string; kind: string } }) => void;
    },
    _ref,
  ) {
    return (
      <div data-testid="file-grid">
        {rowData?.map((entry) => (
          <button
            key={entry.path}
            onClick={() => onRowClicked?.({ data: entry })}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCellContextMenu?.({
                data: entry,
                event: event.nativeEvent,
              });
            }}
            type="button"
          >
            <span className="file-entry-name">{entry.name}</span>
          </button>
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

const connectedSession: SessionState = {
  ...disconnectedSession,
  status: "connected",
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
                permissions: 420,
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

  it("uses theme-aware classes for the subtitle, path input, and file name", () => {
    const { container } = render(<FileManager session={disconnectedSession} />);

    expect(screen.getByText("文件")).toHaveClass("label");
    expect(screen.getByText("远程文件管理器")).toHaveClass("themed-heading");
    expect(screen.getByText("1")).toHaveClass("file-manager-count");
    expect(screen.getByPlaceholderText("输入远程路径并回车")).toHaveClass("themed-input");
    expect(screen.getByText("keep.txt")).toHaveClass("file-entry-name");
    expect(container.querySelector(".scroll-area")).toBeTruthy();
  });

  it("uses theme-aware classes for the file context menu and entry dialogs", () => {
    render(<FileManager session={connectedSession} />);

    fireEvent.contextMenu(screen.getByText("keep.txt"));

    const createFileMenuItem = screen.getByRole("button", { name: "新建文件" });
    expect(createFileMenuItem.closest(".themed-menu")).toHaveClass("themed-menu");
    expect(createFileMenuItem).toHaveClass("themed-menu-item");

    fireEvent.click(screen.getByRole("button", { name: "属性" }));
    expect(screen.getByText("属性")).toHaveClass("dialog-kicker");
    expect(screen.getByText("名称").closest("div")).toHaveClass("themed-property-row");

    fireEvent.click(screen.getByRole("button", { name: "关闭属性弹框" }));
    fireEvent.contextMenu(screen.getByTestId("file-grid"));
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));

    expect(screen.getByText("新建")).toHaveClass("dialog-kicker");
    expect(screen.getByPlaceholderText("example.txt")).toHaveClass("themed-input");
  });

  it("shows permission edit controls in the properties panel", () => {
    render(<FileManager session={connectedSession} />);

    fireEvent.contextMenu(screen.getByText("keep.txt"));
    fireEvent.click(screen.getByRole("button", { name: "属性" }));

    expect(screen.getByRole("button", { name: "修改权限" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "修改权限" }));
    expect(screen.getByPlaceholderText("0755")).toBeInTheDocument();
  });

  it("shows a warning banner when navigating to a sensitive path", () => {
    useFileManagerStore.setState({
      sessions: {
        "session-1": {
          pathInput: "/etc",
          listing: {
            path: "/etc",
            parentPath: "/",
            entries: [
              {
                path: "/etc/nginx",
                name: "nginx",
                kind: "directory",
              },
            ],
          },
        },
      },
    });

    render(<FileManager session={connectedSession} />);
    expect(screen.getByText(/系统敏感目录/)).toBeInTheDocument();
  });
});
