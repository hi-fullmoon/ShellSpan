interface UpdateRestartDialogProps {
  open: boolean;
  version: string;
  hasActiveSessions: boolean;
  downloadProgress?: number;
  onInstallNow: () => void;
  onLater: () => void;
}

export function UpdateRestartDialog({
  open,
  version,
  hasActiveSessions,
  downloadProgress,
  onInstallNow,
  onLater,
}: UpdateRestartDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-slate-950/70 p-1 backdrop-blur md:p-2"
      onClick={onLater}
      role="presentation"
    >
      <div
        className="surface w-full max-w-md p-3"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="更新已准备完成"
      >
        <div className="flex flex-col gap-1">
          <p className="label">应用更新</p>
          <h3 className="text-sm font-semibold text-slate-100">新版本已下载完成</h3>
          <p className="text-xs text-slate-400">版本 {version} 已准备就绪，重启应用后即可完成安装。</p>
          {typeof downloadProgress === "number" ? (
            <p className="text-xs text-cyan-300">下载进度：{Math.max(0, Math.min(100, downloadProgress))}%</p>
          ) : null}
        </div>

        {hasActiveSessions ? (
          <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
            重启会中断当前 SSH 会话，请先确认远程任务可以安全中断。
          </div>
        ) : null}

        <div className="mt-3 flex justify-end gap-1">
          <button className="icon-btn" onClick={onLater} type="button">
            稍后
          </button>
          <button className="primary-btn px-3 py-2 text-xs" onClick={onInstallNow} type="button">
            立即重启安装
          </button>
        </div>
      </div>
    </div>
  );
}
