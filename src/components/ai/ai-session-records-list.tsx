import { useCallback, useRef, useState, type ReactNode } from 'react';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';

import { ScrollArea, ScrollAreaContent } from '@/components/ui/scroll-area';
import type { AgentSessionListItem } from '@/types/agent-session';

// Small lists do not benefit from measurement or scroll subscriptions.
const VIRTUALIZE_AFTER = 20;

export function AiSessionRecordsList({ records, notices, renderRecord }: {
  readonly records: readonly AgentSessionListItem[];
  readonly notices: readonly ReactNode[];
  readonly renderRecord: (record: AgentSessionListItem) => ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const virtual = records.length > VIRTUALIZE_AFTER;
  const noticeCount = notices.length > 0 ? 1 : 0;
  const focusedIndex = focusedId === null ? -1
    : records.findIndex((record) => record.header.sessionId === focusedId);
  const getItemKey = useCallback((index: number) => index < noticeCount
    ? 'notice' : `record:${records[index - noticeCount].header.sessionId}`, [noticeCount, records]);
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    // Keep focus mounted, together with its neighbours so Tab can cross the
    // rendered range in either direction using the browser's normal tab order.
    if (focusedIndex >= 0) {
      const index = focusedIndex + noticeCount;
      for (let next = Math.max(noticeCount, index - 1); next <= Math.min(range.count - 1, index + 1); next++) {
        indexes.push(next);
      }
    }
    return [...new Set(indexes)].sort((left, right) => left - right);
  }, [focusedIndex, noticeCount]);
  const virtualizer = useVirtualizer({
    count: records.length + noticeCount,
    getScrollElement: () => viewportRef.current,
    getItemKey,
    estimateSize: () => 54,
    gap: 8,
    paddingStart: 16,
    paddingEnd: 16,
    overscan: 5,
    enabled: virtual,
    rangeExtractor,
  });
  const notice = notices.length > 0 ? <div className="flex flex-col gap-2">{notices}</div> : null;

  return (
    <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
      <ScrollAreaContent
        className={virtual ? 'px-4' : 'flex flex-col gap-2 p-4'}
        style={{ minWidth: 0 }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(null);
        }}
      >
        {virtual ? (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const record = row.index < noticeCount ? null : records[row.index - noticeCount];
              return (
                <div
                  key={row.key}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${row.start}px)` }}
                  onFocusCapture={() => setFocusedId(record?.header.sessionId ?? null)}
                >
                  {record ? renderRecord(record) : notice}
                </div>
              );
            })}
          </div>
        ) : <>{notice}{records.map((record) => (
          <div key={record.header.sessionId}>{renderRecord(record)}</div>
        ))}</>}
      </ScrollAreaContent>
    </ScrollArea>
  );
}
