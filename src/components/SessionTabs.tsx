import { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "./Icons";
import { cn, sessionStatusDot, sessionStatusTone } from "../lib/ui";
import type { SessionState } from "../types";

interface SessionTabsProps {
  sessions: SessionState[];
  activeSessionId?: string;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
}

function statusLabel(status: SessionState["status"]) {
  switch (status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "error":
      return "错误";
    case "disconnected":
      return "已断开";
  }
}

export function SessionTabs({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
}: SessionTabsProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const updateScrollButtons = () => {
      const maxScrollLeft = container.scrollWidth - container.clientWidth;
      setCanScrollLeft(container.scrollLeft > 4);
      setCanScrollRight(maxScrollLeft - container.scrollLeft > 4);
    };

    updateScrollButtons();

    const observer = new ResizeObserver(updateScrollButtons);
    observer.observe(container);
    container.addEventListener("scroll", updateScrollButtons);
    window.addEventListener("resize", updateScrollButtons);

    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", updateScrollButtons);
      window.removeEventListener("resize", updateScrollButtons);
    };
  }, [sessions.length]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeSessionId) {
      return;
    }

    const target = container.querySelector<HTMLElement>(
      `[data-session-tab="${activeSessionId}"]`,
    );
    target?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeSessionId, sessions.length]);

  const scrollTabs = (direction: "left" | "right") => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const amount = Math.max(180, Math.floor(container.clientWidth * 0.65));
    container.scrollBy({
      left: direction === "left" ? -amount : amount,
      behavior: "smooth",
    });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    const hasHorizontalOverflow = container.scrollWidth > container.clientWidth + 4;
    if (!hasHorizontalOverflow) {
      return;
    }

    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }

    container.scrollBy({
      left: event.deltaY,
      behavior: "auto",
    });
    event.preventDefault();
  };

  if (sessions.length === 0) {
    return (
      <div className="surface flex items-center gap-2 px-2 py-1.5 text-xs text-slate-400">
        <span className="label">会话</span>
        <span>打开一个主机连接后，这里会出现标签页。</span>
      </div>
    );
  }

  return (
    <div className="surface min-w-0 flex flex-col gap-1 p-1">
      <span className="label px-1.5 pt-0.5">会话</span>
      <div className="flex min-w-0 items-center gap-1 pb-0.5">
        {canScrollLeft ? (
          <button
            className="icon-btn h-[38px] w-7 shrink-0 px-0"
            onClick={() => scrollTabs("left")}
            title="向左查看会话"
            type="button"
          >
            <ArrowLeftIcon />
          </button>
        ) : null}

        <div
          className="session-tabs-scroll min-w-0 max-w-full flex-1 overflow-x-auto overflow-y-hidden"
          onWheel={handleWheel}
          ref={scrollRef}
        >
          <div className="flex w-max min-w-full gap-1 pr-0.5">
            {sessions.map((session) => {
              const active = session.sessionId === activeSessionId;
              return (
                <div
                  className={cn(
                    "flex min-w-[150px] max-w-[220px] shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-left transition",
                    active
                      ? "border-cyan-400/50 bg-slate-800 text-slate-50"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900",
                  )}
                  data-session-tab={session.sessionId}
                  key={session.sessionId}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2"
                    onClick={() => onSelect(session.sessionId)}
                    type="button"
                  >
                    <span className={cn("h-2 w-2 rounded-full", sessionStatusDot(session.status))} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-xs">{session.title}</strong>
                      <small className="block truncate text-[11px] text-slate-400">
                        {session.username}@{session.host}
                      </small>
                    </span>
                  </button>
                  <span className={cn("shrink-0 rounded-md px-2 py-1 text-[10px]", sessionStatusTone(session.status))}>
                    {statusLabel(session.status)}
                  </span>
                  <button
                    className="icon-btn px-1.5 py-0.5"
                    onClick={() => onClose(session.sessionId)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {canScrollRight ? (
          <button
            className="icon-btn h-[38px] w-7 shrink-0 px-0"
            onClick={() => scrollTabs("right")}
            title="向右查看会话"
            type="button"
          >
            <ArrowRightIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}
