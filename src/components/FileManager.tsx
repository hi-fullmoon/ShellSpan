import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createPortal } from "react-dom";
import {
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isTauriRuntime } from "../lib/tauri";
import { cn, fileKindTone } from "../lib/ui";
import {
  ArrowUpIcon,
  DotsIcon,
  FileIcon,
  FolderIcon,
  LinkIcon,
  RefreshIcon,
} from "./Icons";
import { Toast, type ToastAction } from "./Toast";
import type {
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteFileKind,
  SessionState,
} from "../types";

interface FileManagerProps {
  session?: SessionState;
}

type EntryDialogMode = "newFile" | "newDirectory" | "rename";
type MenuTarget = "blank" | "entry";

interface EntryDialogState {
  mode: EntryDialogMode;
  value: string;
}

interface ClipboardState {
  sourcePath: string;
  sourceName: string;
  kind: RemoteFileKind;
}

interface PendingDeleteState {
  path: string;
  name: string;
  kind: RemoteFileKind;
}

interface PropertiesState {
  entry: RemoteFileEntry;
  directoryPath: string;
}

interface ToastState {
  action?: ToastAction;
  message: string;
  tone: "success" | "error" | "info";
}

interface ContextMenuState {
  x: number;
  y: number;
  target: MenuTarget;
  entry?: RemoteFileEntry;
}

function clampMenuPosition(x: number, y: number, width: number, height: number) {
  const edge = 8;
  return {
    x: Math.max(edge, Math.min(x, window.innerWidth - width - edge)),
    y: Math.max(edge, Math.min(y, window.innerHeight - height - edge)),
  };
}

function formatSize(size?: number) {
  if (size === undefined) {
    return "--";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatModified(modifiedAt?: number) {
  if (!modifiedAt) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(modifiedAt * 1000));
}

function formatFullModified(modifiedAt?: number) {
  if (!modifiedAt) {
    return "--";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(modifiedAt * 1000));
}

function localPathName(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function parentDirectoryPath(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);

  if (!parts.length) {
    return normalized.startsWith("/") ? "/" : ".";
  }

  parts.pop();
  if (!parts.length) {
    return normalized.startsWith("/") ? "/" : ".";
  }

  return `${normalized.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

function kindLabel(kind: RemoteFileKind) {
  switch (kind) {
    case "directory":
      return "目录";
    case "file":
      return "文件";
    case "symlink":
      return "链接";
    case "other":
      return "其他";
  }
}

function permissionTypePrefix(kind: RemoteFileKind) {
  switch (kind) {
    case "directory":
      return "d";
    case "symlink":
      return "l";
    case "file":
      return "-";
    case "other":
      return "?";
  }
}

function formatPermissionOctal(permissions?: number) {
  if (permissions === undefined) {
    return "--";
  }

  return `0${(permissions & 0o7777).toString(8).padStart(4, "0")}`;
}

function formatPermissionSymbolic(
  permissions: number | undefined,
  kind: RemoteFileKind,
) {
  if (permissions === undefined) {
    return "--";
  }

  const ownerExec = (permissions & 0o100) === 0o100;
  const groupExec = (permissions & 0o010) === 0o010;
  const otherExec = (permissions & 0o001) === 0o001;
  const symbolic = [
    (permissions & 0o400) === 0o400 ? "r" : "-",
    (permissions & 0o200) === 0o200 ? "w" : "-",
    (permissions & 0o4000) === 0o4000 ? (ownerExec ? "s" : "S") : ownerExec ? "x" : "-",
    (permissions & 0o040) === 0o040 ? "r" : "-",
    (permissions & 0o020) === 0o020 ? "w" : "-",
    (permissions & 0o2000) === 0o2000 ? (groupExec ? "s" : "S") : groupExec ? "x" : "-",
    (permissions & 0o004) === 0o004 ? "r" : "-",
    (permissions & 0o002) === 0o002 ? "w" : "-",
    (permissions & 0o1000) === 0o1000 ? (otherExec ? "t" : "T") : otherExec ? "x" : "-",
  ].join("");

  return `${permissionTypePrefix(kind)}${symbolic}`;
}

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function fileKindIcon(kind: RemoteFileKind) {
  switch (kind) {
    case "directory":
      return <FolderIcon />;
    case "file":
      return <FileIcon />;
    case "symlink":
      return <LinkIcon />;
    case "other":
      return <DotsIcon />;
  }
}

function FileRow({
  entry,
  selected,
  onOpen,
  onSelect,
  onContextMenu,
}: {
  entry: RemoteFileEntry;
  selected: boolean;
  onOpen: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>, entry: RemoteFileEntry) => void;
}) {
  const directory = entry.kind === "directory";

  return (
    <div
      className={cn(
        "grid select-none grid-cols-[minmax(0,1fr)_52px_64px] items-center gap-1 rounded-lg border px-2 py-1 transition",
        selected
          ? "border-cyan-400/50 bg-slate-900"
          : "border-transparent bg-slate-900/70 hover:border-slate-700 hover:bg-slate-900",
      )}
      onMouseDown={(event) => {
        if (event.button === 2) {
          event.preventDefault();
        }
      }}
      onContextMenu={(event) => onContextMenu(event, entry)}
    >
      <button
        className="flex min-w-0 items-center gap-2 text-left"
        onClick={() => onSelect(entry.path)}
        onDoubleClick={() => directory && onOpen(entry.path)}
        type="button"
      >
        <span
          className={cn(
            "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            fileKindTone(entry.kind),
          )}
          title={kindLabel(entry.kind)}
        >
          {fileKindIcon(entry.kind)}
        </span>
        <span className="truncate text-[13px] font-medium leading-5 tracking-[0.01em] text-slate-100">
          {entry.name}
        </span>
      </button>

      <span className="truncate text-right text-[11px] leading-5 text-slate-400">
        {entry.kind === "directory" ? "--" : formatSize(entry.size)}
      </span>
      <span className="truncate text-right text-[11px] leading-5 text-slate-500">
        {formatModified(entry.modifiedAt)}
      </span>
    </div>
  );
}

function MenuButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="rounded-md px-2 py-1 text-left text-[12px] font-medium text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div className="my-1 h-px bg-slate-800/90" />;
}

function PropertyRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-2">
      <span className="text-[11px] font-medium tracking-[0.02em] text-slate-500">{label}</span>
      <span className="break-all text-[12px] leading-5 text-slate-200">{value}</span>
    </div>
  );
}

export function FileManager({ session }: FileManagerProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [listing, setListing] = useState<RemoteDirectoryListing>();
  const [pathInput, setPathInput] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [clipboard, setClipboard] = useState<ClipboardState>();
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteState>();
  const [properties, setProperties] = useState<PropertiesState>();
  const [dialog, setDialog] = useState<EntryDialogState>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string>();
  const [toast, setToast] = useState<ToastState>();

  const connection = useMemo(() => {
    if (!session) {
      return undefined;
    }

    return {
      host: session.host,
      port: session.port,
      username: session.username,
      authMethod: session.profile.authMethod,
      password: session.profile.password || undefined,
      privateKeyPath: session.profile.privateKeyPath?.trim() || undefined,
      passphrase: session.profile.passphrase || undefined,
    };
  }, [session]);

  const selectedEntry = useMemo(
    () => listing?.entries.find((entry) => entry.path === selectedPath),
    [listing, selectedPath],
  );

  const ready = !!session && session.status === "connected" && !!connection;
  const currentPath = listing?.path;

  const loadDirectory = async (targetPath?: string) => {
    if (!connection) {
      return;
    }

    setLoading(true);
    setError(undefined);
    setContextMenu(undefined);

    try {
      const nextListing = await invoke<RemoteDirectoryListing>("list_remote_directory", {
        request: {
          ...connection,
          path: targetPath,
        },
      });
      setListing(nextListing);
      setPathInput(nextListing.path);
      setSelectedPath((current) =>
        current && nextListing.entries.some((entry) => entry.path === current)
          ? current
          : undefined,
      );
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setLoading(false);
    }
  };

  const runFileAction = async (
    task: () => Promise<unknown>,
    successMessage?: string,
  ) => {
    setWorking(true);
    setError(undefined);
    setToast(undefined);
    setContextMenu(undefined);

    try {
      await task();
      setDialog(undefined);
      setProperties(undefined);
      await loadDirectory(currentPath);
      if (successMessage) {
        setToast({
          message: successMessage,
          tone: "success",
        });
      }
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: "error",
      });
    } finally {
      setWorking(false);
    }
  };

  const handleUploadPaths = async (paths: string[]) => {
    if (!connection || !currentPath) {
      return;
    }

    const nextPaths = [...new Set(paths)].filter(Boolean);
    if (!nextPaths.length) {
      return;
    }

    await runFileAction(
      () =>
        invoke("upload_local_paths", {
          request: {
            ...connection,
            destinationDirectory: currentPath,
            localPaths: nextPaths,
          },
        }),
      nextPaths.length === 1
        ? `已上传 ${localPathName(nextPaths[0])}`
        : `已上传 ${nextPaths.length} 项`,
    );
  };

  useEffect(() => {
    setListing(undefined);
    setPathInput("");
    setSelectedPath(undefined);
    setClipboard(undefined);
    setPendingDelete(undefined);
    setProperties(undefined);
    setDialog(undefined);
    setContextMenu(undefined);
    setError(undefined);
    setToast(undefined);
    setDragActive(false);

    if (!ready) {
      return;
    }

    void loadDirectory();
  }, [ready, session?.sessionId]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(undefined);
    window.addEventListener("click", closeMenu);

    return () => {
      window.removeEventListener("click", closeMenu);
    };
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) {
      return;
    }

    const rect = menuRef.current.getBoundingClientRect();
    const nextPosition = clampMenuPosition(
      contextMenu.x,
      contextMenu.y,
      rect.width,
      rect.height,
    );

    if (nextPosition.x === contextMenu.x && nextPosition.y === contextMenu.y) {
      return;
    }

    setContextMenu((current) =>
      current
        ? {
            ...current,
            x: nextPosition.x,
            y: nextPosition.y,
          }
        : current,
    );
  }, [contextMenu]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let dispose: (() => void) | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
        if (!ready || !currentPath) {
          setDragActive(false);
          return;
        }

        switch (event.payload.type) {
          case "enter":
          case "over":
            setDragActive(true);
            break;
          case "leave":
            setDragActive(false);
            break;
          case "drop":
            setDragActive(false);
            void handleUploadPaths(event.payload.paths);
            break;
        }
      });

      if (cancelled) {
        unlisten();
        return;
      }

      dispose = unlisten;
    };

    void attach();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [ready, currentPath]);

  const submitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!dialog || !connection || !currentPath) {
      return;
    }

    if (dialog.mode === "rename") {
      if (!selectedEntry) {
        return;
      }

      await runFileAction(
        () =>
          invoke("rename_remote_path", {
            request: {
              ...connection,
              path: selectedEntry.path,
              newName: dialog.value,
            },
          }),
        "重命名成功",
      );
      return;
    }

    await runFileAction(
      () =>
        invoke("create_remote_entry", {
          request: {
            ...connection,
            parentPath: currentPath,
            name: dialog.value,
            kind: dialog.mode === "newFile" ? "file" : "directory",
          },
        }),
      dialog.mode === "newFile" ? "文件已创建" : "文件夹已创建",
    );
  };

  const openRenameDialog = (entry?: RemoteFileEntry) => {
    const target = entry ?? selectedEntry;
    if (!target) {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setDialog({
      mode: "rename",
      value: target.name,
    });
  };

  const openProperties = (entry?: RemoteFileEntry) => {
    const target = entry ?? selectedEntry;
    if (!target) {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setProperties({
      entry: target,
      directoryPath:
        target.kind === "directory"
          ? target.path
          : parentDirectoryPath(target.path),
    });
  };

  const handleDelete = (entry?: RemoteFileEntry) => {
    const target = entry ?? selectedEntry;
    if (!target || !connection) {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setPendingDelete({
      path: target.path,
      name: target.name,
      kind: target.kind,
    });
  };

  const handleCopy = (entry?: RemoteFileEntry) => {
    const target = entry ?? selectedEntry;
    if (!target) {
      return;
    }

    setSelectedPath(target.path);
    setClipboard({
      sourcePath: target.path,
      sourceName: target.name,
      kind: target.kind,
    });
    setToast({
      message: `已复制 ${target.name}`,
      tone: "success",
      action: {
        label: "清除",
        onClick: () => {
          setClipboard(undefined);
          setToast(undefined);
        },
      },
    });
    setError(undefined);
    setContextMenu(undefined);
  };

  const handleCopyText = async (label: string, value: string) => {
    setContextMenu(undefined);

    try {
      await writeClipboardText(value);
      setToast({
        message: `${label}已复制`,
        tone: "success",
      });
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: "error",
      });
    }
  };

  const clearClipboardNotice = () => {
    setClipboard(undefined);
    setToast(undefined);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || !connection) {
      return;
    }

    const targetPath = pendingDelete.path;
    await runFileAction(
      () =>
        invoke("delete_remote_path", {
          request: {
            ...connection,
            path: targetPath,
          },
        }),
      "删除成功",
    );
    setPendingDelete(undefined);
    setSelectedPath(undefined);
  };

  const handlePaste = async () => {
    if (!clipboard || !connection || !currentPath) {
      return;
    }

    await runFileAction(
      () =>
        invoke("copy_remote_path", {
          request: {
            ...connection,
            sourcePath: clipboard.sourcePath,
            destinationDirectory: currentPath,
          },
        }),
      `已粘贴 ${clipboard.sourceName}`,
    );
  };

  const handleOpenWithDefaultEditor = async (entry?: RemoteFileEntry) => {
    const target = entry ?? selectedEntry;
    if (!target || !connection || target.kind === "directory") {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setWorking(true);
    setToast(undefined);

    try {
      await invoke("open_remote_file", {
        request: {
          ...connection,
          path: target.path,
        },
      });
      setToast({
        message: `已使用默认应用打开 ${target.name}`,
        tone: "success",
      });
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: "error",
      });
    } finally {
      setWorking(false);
    }
  };

  const handlePathSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPath = pathInput.trim();
    if (!nextPath) {
      return;
    }
    await loadDirectory(nextPath);
  };

  const openBlankMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: "blank",
    });
  };

  const openEntryMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: RemoteFileEntry,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedPath(entry.path);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: "entry",
      entry,
    });
  };

  return (
    <aside className="surface relative flex min-h-0 flex-col overflow-hidden font-['PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei_UI','Noto_Sans_SC','Source_Han_Sans_SC',sans-serif]">
          <div className="surface-header">
            <div className="min-w-0">
              <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">文件</p>
              <h3 className="truncate text-[15px] font-semibold tracking-[0.01em] text-slate-100">
                {session ? "远程文件管理器" : "未激活会话"}
              </h3>
            </div>
            <div className="flex items-center gap-1">
              <span className="rounded-md bg-slate-950/70 px-2 py-1 text-[10px] text-slate-400">
                {listing?.entries.length ?? 0}
              </span>
            </div>
          </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 p-1">
        {!session ? (
          <div className="surface-muted flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
            先打开一个 SSH 会话，左侧会显示远程目录。
          </div>
        ) : session.status !== "connected" ? (
          <div className="surface-muted flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
            会话连接成功后，文件管理器会自动加载远程目录。
          </div>
        ) : (
          <>
            <form className="surface-muted flex items-center gap-1 px-2 py-2" onSubmit={(event) => void handlePathSubmit(event)}>
              <button
                className="icon-btn h-7 w-7 px-0"
                disabled={!ready || loading || working}
                onClick={() => void loadDirectory(currentPath)}
                title="刷新"
                type="button"
              >
                <RefreshIcon />
              </button>
              <input
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px] leading-5 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                onChange={(event) => setPathInput(event.target.value)}
                placeholder="输入远程路径并回车"
                value={pathInput}
              />
              <button
                className="icon-btn h-7 w-7 px-0"
                disabled={!listing?.parentPath || loading || working}
                onClick={() => listing?.parentPath && void loadDirectory(listing.parentPath)}
                title="返回上级目录"
                type="button"
              >
                <ArrowUpIcon />
              </button>
            </form>

            {error ? (
              <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-2 py-2 text-xs text-rose-300">
                {error}
              </div>
            ) : null}

            <div className="grid grid-cols-[minmax(0,1fr)_52px_64px] gap-1 px-2 py-1 text-[11px] font-medium tracking-[0.04em] text-slate-500">
              <span>名称</span>
              <span className="text-right">大小</span>
              <span className="text-right">时间</span>
            </div>

            <div
              className="min-h-0 flex-1 overflow-auto rounded-lg"
              onMouseDown={(event) => {
                if (event.button === 2) {
                  event.preventDefault();
                }
              }}
              onContextMenu={openBlankMenu}
            >
              <div className="flex min-h-full flex-col gap-1">
                {loading && !listing ? (
                  <div className="surface-muted px-2 py-2 text-xs text-slate-400">
                    正在加载远程目录...
                  </div>
                ) : listing?.entries.length ? (
                  listing.entries.map((entry) => (
                    <FileRow
                      entry={entry}
                      key={entry.path}
                      onContextMenu={openEntryMenu}
                      onOpen={(path) => void loadDirectory(path)}
                      onSelect={setSelectedPath}
                      selected={entry.path === selectedPath}
                    />
                  ))
                ) : (
                  <div className="surface-muted px-2 py-2 text-xs text-slate-400">
                    当前目录没有可显示的文件。
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {contextMenu
        ? createPortal(
            <div
              className="fixed z-50 min-w-[132px] rounded-lg border border-slate-800 bg-slate-950/95 p-1 shadow-[0_12px_36px_rgba(2,6,23,0.45)] backdrop-blur"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onMouseDown={(event) => {
                if (event.button === 2) {
                  event.preventDefault();
                }
              }}
              ref={menuRef}
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              {contextMenu.target === "blank" ? (
                <div className="flex flex-col">
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件"
                    onClick={() => {
                      setDialog({ mode: "newFile", value: "" });
                      setContextMenu(undefined);
                    }}
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件夹"
                    onClick={() => {
                      setDialog({ mode: "newDirectory", value: "" });
                      setContextMenu(undefined);
                    }}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={!clipboard || loading || working}
                    label="粘贴"
                    onClick={() => void handlePaste()}
                  />
                  <MenuButton
                    disabled={!currentPath || loading || working}
                    label="复制当前目录路径"
                    onClick={() => void handleCopyText("当前目录路径", currentPath ?? "")}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={loading || working}
                    label="刷新"
                    onClick={() => void loadDirectory(currentPath)}
                  />
                </div>
              ) : (
                <div className="flex flex-col">
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件"
                    onClick={() => {
                      setDialog({ mode: "newFile", value: "" });
                      setContextMenu(undefined);
                    }}
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件夹"
                    onClick={() => {
                      setDialog({ mode: "newDirectory", value: "" });
                      setContextMenu(undefined);
                    }}
                  />
                  {contextMenu.entry?.kind === "directory" ? (
                    <MenuButton
                      disabled={loading || working}
                      label="打开"
                      onClick={() => {
                        if (contextMenu.entry) {
                          void loadDirectory(contextMenu.entry.path);
                        }
                      }}
                    />
                  ) : null}
                  {contextMenu.entry && contextMenu.entry.kind !== "directory" ? (
                    <MenuButton
                      disabled={loading || working}
                      label="默认编辑器打开"
                      onClick={() => void handleOpenWithDefaultEditor(contextMenu.entry)}
                    />
                  ) : null}
                  <MenuDivider />
                  <MenuButton
                    disabled={loading || working}
                    label="重命名"
                    onClick={() => openRenameDialog(contextMenu.entry)}
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="复制"
                    onClick={() => handleCopy(contextMenu.entry)}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={loading || working}
                    label="复制名称"
                    onClick={() =>
                      void handleCopyText("名称", contextMenu.entry?.name ?? "")
                    }
                  />
                  <MenuButton
                    disabled={loading || working}
                    label={
                      contextMenu.entry?.kind === "directory"
                        ? "复制目录路径"
                        : "复制文件路径"
                    }
                    onClick={() =>
                      void handleCopyText(
                        contextMenu.entry?.kind === "directory" ? "目录路径" : "文件路径",
                        contextMenu.entry?.path ?? "",
                      )
                    }
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="复制所在目录"
                    onClick={() =>
                      void handleCopyText(
                        "目录路径",
                        contextMenu.entry
                          ? contextMenu.entry.kind === "directory"
                            ? contextMenu.entry.path
                            : parentDirectoryPath(contextMenu.entry.path)
                          : currentPath ?? "",
                      )
                    }
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={loading || working}
                    label="属性"
                    onClick={() => openProperties(contextMenu.entry)}
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="刷新"
                    onClick={() => void loadDirectory(currentPath)}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={loading || working}
                    label="删除"
                    onClick={() => handleDelete(contextMenu.entry)}
                  />
                </div>
              )}
            </div>,
            document.body,
          )
        : null}

      {properties ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm">
          <div className="surface flex w-full max-w-md flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">属性</p>
                <h4 className="mt-1 text-[15px] font-semibold tracking-[0.01em] text-slate-100">
                  {properties.entry.name}
                </h4>
              </div>
              <button
                className="icon-btn"
                onClick={() => setProperties(undefined)}
                type="button"
              >
                关闭
              </button>
            </div>

            <div className="grid gap-1">
              <PropertyRow label="名称" value={properties.entry.name} />
              <PropertyRow label="路径" value={properties.entry.path} />
              <PropertyRow label="所在目录" value={properties.directoryPath} />
              <PropertyRow label="类型" value={kindLabel(properties.entry.kind)} />
              <PropertyRow
                label="大小"
                value={
                  properties.entry.kind === "directory"
                    ? "--"
                    : formatSize(properties.entry.size)
                }
              />
              <PropertyRow
                label="修改时间"
                value={formatFullModified(properties.entry.modifiedAt)}
              />
              <PropertyRow
                label="所有者"
                value={
                  properties.entry.ownerUid !== undefined
                    ? `UID ${properties.entry.ownerUid}`
                    : "--"
                }
              />
              <PropertyRow
                label="分组"
                value={
                  properties.entry.groupGid !== undefined
                    ? `GID ${properties.entry.groupGid}`
                    : "--"
                }
              />
              <PropertyRow
                label="权限"
                value={formatPermissionOctal(properties.entry.permissions)}
              />
              <PropertyRow
                label="权限详情"
                value={formatPermissionSymbolic(
                  properties.entry.permissions,
                  properties.entry.kind,
                )}
              />
            </div>
          </div>
        </div>
      ) : null}

      {dragActive && ready ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/80 p-2 backdrop-blur-sm">
          <div className="surface flex max-w-xs flex-col gap-1 p-3 text-center">
            <span className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">上传</span>
            <strong className="text-[15px] font-semibold tracking-[0.01em] text-slate-100">释放鼠标以上传到当前目录</strong>
            <span className="text-xs text-slate-400">
              支持拖入文件或整个文件夹。
            </span>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm">
          <form className="surface flex w-full max-w-xs flex-col gap-2 p-3" onSubmit={(event) => void submitDialog(event)}>
            <div>
              <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">
                {dialog.mode === "rename" ? "重命名" : "新建"}
              </p>
              <h4 className="mt-1 text-[15px] font-semibold tracking-[0.01em] text-slate-100">
                {dialog.mode === "newFile"
                  ? "新建空文件"
                  : dialog.mode === "newDirectory"
                    ? "新建文件夹"
                    : "修改名称"}
              </h4>
            </div>

            <input
              autoFocus
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-[13px] leading-5 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
              onChange={(event) =>
                setDialog((current) =>
                  current ? { ...current, value: event.target.value } : current,
                )
              }
              placeholder={
                dialog.mode === "newFile"
                  ? "example.txt"
                  : dialog.mode === "newDirectory"
                    ? "新建文件夹"
                    : "输入新名称"
              }
              value={dialog.value}
            />

            <div className="flex gap-1">
              <button
                className="primary-btn flex-1"
                disabled={!dialog.value.trim() || working}
                type="submit"
              >
                {dialog.mode === "rename" ? "保存" : "确定"}
              </button>
              <button
                className="icon-btn"
                onClick={() => setDialog(undefined)}
                type="button"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm">
          <div className="surface flex w-full max-w-sm flex-col gap-2 p-3">
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">删除确认</p>
              <h4 className="text-[15px] font-semibold tracking-[0.01em] text-slate-100">
                {pendingDelete.kind === "directory" ? "删除目录" : "删除文件"}
              </h4>
              <p className="text-xs text-slate-400">
                {pendingDelete.kind === "directory"
                  ? `确认删除“${pendingDelete.name}”及其内容吗？`
                  : `确认删除“${pendingDelete.name}”吗？`}
              </p>
            </div>

            <div className="flex justify-end gap-1">
              <button
                className="icon-btn"
                onClick={() => setPendingDelete(undefined)}
                type="button"
              >
                取消
              </button>
              <button
                className="inline-flex items-center justify-center rounded-lg bg-rose-400 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-300"
                onClick={() => void confirmDelete()}
                type="button"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <Toast
        action={toast?.action}
        message={toast?.message ?? ""}
        onClose={() => {
          if (clipboard && toast?.action) {
            clearClipboardNotice();
            return;
          }
          setToast(undefined);
        }}
        open={!!toast}
        tone={toast?.tone ?? "info"}
      />
    </aside>
  );
}
