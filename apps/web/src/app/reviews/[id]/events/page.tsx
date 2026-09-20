'use client';

// Live tail of the review's SSE stream.
//
// EventSource cannot set request headers on the *first* connection, so the
// stored Last-Event-ID is replayed through the API's `after` query parameter;
// on automatic reconnects the browser sends the header itself. The newest id
// is persisted to localStorage so a page reload continues where it left off.

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, reviewEventsUrl } from '@/lib/api';
import { REVIEW_EVENT_TYPES, type ReviewEventPayload } from '@/lib/types';
import {
  Card,
  PageHeader,
  SecondaryButton,
  Shell,
} from '@/components/layout';

interface LogEntry {
  id: string;
  event: ReviewEventPayload | null;
  raw: string;
  comment: string | null;
}

type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

const MAX_ENTRIES = 500;

function storageKey(runId: string): string {
  return `acr:last-event-id:${runId}`;
}

export default function ReviewEventsPage() {
  return (
    <Shell>
      <ReviewEventsView />
    </Shell>
  );
}

function ReviewEventsView() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [followTail, setFollowTail] = useState(true);
  const [runFinished, setRunFinished] = useState(false);
  const [lastSeenId, setLastSeenId] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const [connectNonce, setConnectNonce] = useState(0);

  const append = useCallback((entry: LogEntry) => {
    setEntries((current) => {
      if (current.some((existing) => existing.id === entry.id)) {
        return current;
      }
      const next = [...current, entry];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }, []);

  useEffect(() => {
    if (API_BASE.length === 0) {
      setConnection('closed');
      return;
    }
    let after: string | null = null;
    try {
      after = window.localStorage.getItem(storageKey(id));
    } catch {
      after = null;
    }

    const source = new EventSource(reviewEventsUrl(id, after), { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      setConnection('open');
    };
    source.onerror = () => {
      // EventSource retries on its own; only a closed readyState is terminal.
      setConnection(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };

    const handleEvent = (message: MessageEvent<string>) => {
      let payload: ReviewEventPayload | null = null;
      try {
        payload = JSON.parse(message.data) as ReviewEventPayload;
      } catch {
        payload = null;
      }
      const eventId = message.lastEventId.length > 0 ? message.lastEventId : `anon-${Date.now()}`;
      if (message.lastEventId.length > 0) {
        setLastSeenId(message.lastEventId);
        try {
          window.localStorage.setItem(storageKey(id), message.lastEventId);
        } catch {
          // Storage disabled (private mode): the stream still works in-page.
        }
      }
      append({
        id: eventId,
        event: payload,
        raw: message.data,
        comment: payload === null ? 'unparseable frame' : null,
      });
      if (payload !== null && (payload.type === 'run.completed' || payload.type === 'run.failed')) {
        setRunFinished(true);
      }
    };

    for (const type of REVIEW_EVENT_TYPES) {
      source.addEventListener(type, handleEvent);
    }

    return () => {
      for (const type of REVIEW_EVENT_TYPES) {
        source.removeEventListener(type, handleEvent);
      }
      source.close();
      sourceRef.current = null;
    };
  }, [id, append, connectNonce]);

  // Keep the log pinned to the bottom while the user is following.
  useEffect(() => {
    if (!followTail) {
      return;
    }
    const node = logRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries, followTail]);

  function disconnect() {
    sourceRef.current?.close();
    sourceRef.current = null;
    setConnection('closed');
  }

  function clearLog() {
    setEntries([]);
    setLastSeenId(null);
    try {
      window.localStorage.removeItem(storageKey(id));
    } catch {
      // Nothing to clean when storage is unavailable.
    }
  }

  const connectionTone =
    connection === 'open'
      ? 'text-status-success'
      : connection === 'connecting' || connection === 'reconnecting'
        ? 'text-status-neutral'
        : 'text-ink-faint';

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col">
      <PageHeader
        title="Live review events"
        description={`Streaming every event the run emits, with replay from the last seen id.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href={`/reviews/${id}`}
              className="inline-flex items-center rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-muted hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Back to run
            </Link>
            <SecondaryButton onClick={clearLog} title="Clear the log and forget the replay point">
              Clear &amp; reset cursor
            </SecondaryButton>
            {connection !== 'closed' ? (
              <SecondaryButton onClick={disconnect}>Disconnect</SecondaryButton>
            ) : (
              <SecondaryButton
                onClick={() => {
                  setConnection('connecting');
                  setConnectNonce((current) => current + 1);
                }}
                title="Reopen the stream, replaying from the stored event id"
              >
                Reconnect
              </SecondaryButton>
            )}
          </div>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
        <p className={`flex items-center gap-2 font-medium ${connectionTone}`} role="status">
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${
              connection === 'open'
                ? 'bg-status-success'
                : connection === 'closed'
                  ? 'bg-ink-faint'
                  : 'animate-pulse bg-status-neutral'
            }`}
          />
          {connection === 'open'
            ? 'Stream connected'
            : connection === 'connecting'
              ? 'Connecting…'
              : connection === 'reconnecting'
                ? 'Reconnecting…'
                : 'Disconnected'}
        </p>
        {runFinished && (
          <span className="text-status-success">Run finished — all events delivered.</span>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-ink-muted">
          <input
            type="checkbox"
            checked={followTail}
            onChange={(event) => {
              setFollowTail(event.target.checked);
            }}
            className="h-4 w-4 rounded border-border-strong bg-surface-raised"
          />
          Follow tail
        </label>
        {lastSeenId !== null && (
          <span className="font-mono text-xs text-ink-faint">last id {lastSeenId}</span>
        )}
      </div>

      <Card className="flex min-h-96 flex-1 flex-col">
        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-label="Review event stream"
          tabIndex={0}
          className="h-96 overflow-y-auto rounded-lg bg-canvas p-3 font-mono text-xs"
        >
          {entries.length === 0 ? (
            <p className="text-ink-faint">
              Waiting for events… (the stream replays the full history first, then tails live.)
            </p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <EventLine key={entry.id} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function EventLine({ entry }: { entry: LogEntry }) {
  if (entry.event === null) {
    return (
      <li className="text-ink-faint">
        <span aria-hidden="true">·</span> {entry.comment ?? entry.raw}
      </li>
    );
  }
  const event = entry.event;
  const tone =
    event.type === 'error'
      ? 'text-status-failure'
      : event.type === 'warning'
        ? 'text-status-neutral'
        : event.type === 'run.completed'
          ? 'text-status-success'
          : event.type === 'run.failed'
            ? 'text-status-failure'
            : event.type.startsWith('node.') || event.type.startsWith('tool.')
              ? 'text-accent'
              : 'text-ink-muted';
  return (
    <li className="flex flex-wrap gap-x-2">
      <span className="text-ink-faint">{event.at.slice(11, 19)}</span>
      <span className={`w-32 shrink-0 font-semibold ${tone}`}>{event.type}</span>
      {event.node !== undefined && <span className="text-ink-faint">[{event.node}]</span>}
      {event.tool !== undefined && <span className="text-ink-faint">[tool:{event.tool}]</span>}
      <span className="min-w-0 flex-1 break-words text-ink-muted">{event.message}</span>
    </li>
  );
}
