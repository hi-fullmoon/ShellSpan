// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { forwardRef } from "react";
import { cleanup, fireEvent, render, screen } from "../../test-utils";
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
      onSelectionChanged,
    }: {
      rowData?: Array<{ path: string; name: string; kind: string }>;
      onCellContextMenu?: (event: { data: { path: string; name: string; kind: string }; event: MouseEvent }) => void;
      onRowClicked?: (event: { data: { path: string; name: string; kind: string } }) => void;
      onSelectionChanged?: (event: { api: { getSelectedRows: () => Array<{ path: string }> } }) => void;
    },
    _ref,
  ) {
    return (
      <div data-testid="file-grid">
        {rowData?.map((entry) => (
          <button
            key={entry.path}
            onClick={() => {
              onRowClicked?.({ data: entry });
              onSelectionChanged?.({ api: { getSelectedRows: () => [entry] } });
            }}
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
    expect(screen.getByText((content) => content.includes("终端已断开"))).toBeInTheDocument();
  });

  it("uses theme-aware classes for the subtitle, breadcrumb, and file name", () => {
    const { container } = render(<FileManager session={disconnectedSession} />);

    expect(screen.getByText("文件")).toHaveClass("label");
    expect(screen.getByText("远程文件管理器")).toHaveClass("themed-heading");
    expect(screen.getByRole("button", { name: "根目录" })).toBeInTheDocument();
    expect(screen.getByText("var")).toBeInTheDocument();
    expect(screen.getByText("www")).toBeInTheDocument();
    expect(screen.getByText("keep.txt")).toHaveClass("file-entry-name");
    expect(container.querySelector(".scroll-area")).toBeTruthy();
  });

  it("opens the create file dialog from blank context menu", () => {
    render(<FileManager session={connectedSession} />);

    fireEvent.contextMenu(screen.getByTestId("file-grid"));

    const buttons = screen.getAllByRole("button", { name: "新建文件" });
    fireEvent.click(buttons[buttons.length - 1]);

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

  it("renders breadcrumb segments for the current path", () => {
    render(<FileManager session={connectedSession} />);

    expect(screen.getByRole("button", { name: "根目录" })).toBeInTheDocument();
    expect(screen.getByText("var")).toBeInTheDocument();
    expect(screen.getByText("www")).toBeInTheDocument();
  });

  it("shows batch toolbar when multiple rows are selected", () => {
    useFileManagerStore.setState({
      sessions: {
        "session-1": {
          pathInput: "/var/www",
          selectedPaths: ["/var/www/keep.txt", "/var/www/other.txt"],
          listing: {
            path: "/var/www",
            parentPath: "/var",
            entries: [
              { path: "/var/www/keep.txt", name: "keep.txt", kind: "file", permissions: 420 },
              { path: "/var/www/other.txt", name: "other.txt", kind: "file", permissions: 420 },
            ],
          },
        },
      },
    });

    render(<FileManager session={connectedSession} />);

    expect(screen.getByText("已选择 2 项")).toBeInTheDocument();
    const downloadButtons = screen.getAllByRole("button", { name: "下载" });
    expect(downloadButtons.length).toBeGreaterThanOrEqual(1);
    const deleteButtons = screen.getAllByRole("button", { name: "删除" });
    expect(deleteButtons.length).toBeGreaterThanOrEqual(1);
  });

  it("renders operation log panel when logs exist", () => {
    useFileManagerStore.setState({
      sessions: {
        "session-1": {
          pathInput: "/var/www",
          operationLogs: [
            { id: "log-1", type: "upload", status: "completed", message: "Uploaded keep.txt", timestamp: Date.now() },
          ],
          listing: {
            path: "/var/www",
            parentPath: "/var",
            entries: [],
          },
        },
      },
    });

    render(<FileManager session={connectedSession} />);

    expect(screen.getByText("Uploaded keep.txt")).toBeInTheDocument();
  });
});
