/**
 * The Reef web surface. Start a governed session, watch its tamper-evident
 * evidence stream arrive live, and read the proof block the moment it seals.
 * The point Reef makes over a closed agentic IDE: governance you can *see* and
 * *verify*, not a badge you're asked to trust.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ReefEvent,
  SessionSnapshot,
  VerifyResult,
} from "@octopus-reef/protocol";
import {
  createSession,
  subscribeEvents,
  type ServerEvent,
  type Subscription,
} from "./api.js";

// Same-origin in dev (Vite proxies /sessions to the daemon) and in the Docker
// image (the daemon serves the built assets); override for a remote daemon.
const BASE = import.meta.env.VITE_REEF_SERVER ?? "";

type Phase = "idle" | "running" | "sealed" | "error";

const KIND_LABEL: Record<string, string> = {
  "session.created": "session",
  "work.transition": "work",
  observation: "observe",
  "action.executed": "action",
  "action.denied": "denied",
  message: "message",
  "session.sealed": "sealed",
};

export function App(): JSX.Element {
  const [task, setTask] = useState("add rate limiting to the login endpoint");
  const [phase, setPhase] = useState<Phase>("idle");
  const [events, setEvents] = useState<ReefEvent[]>([]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sub = useRef<Subscription | null>(null);

  const onFrame = useCallback((frame: ServerEvent) => {
    if (frame.type === "event") {
      setEvents((prev) => [...prev, frame.event]);
    } else if (frame.type === "sealed") {
      setSnapshot(frame.snapshot);
      setVerify(frame.verify);
      setPhase("sealed");
    }
  }, []);

  const start = useCallback(async () => {
    sub.current?.close();
    setEvents([]);
    setSnapshot(null);
    setVerify(null);
    setError(null);
    setPhase("running");
    try {
      const id = await createSession(BASE, task.trim());
      sub.current = subscribeEvents(
        BASE,
        id,
        onFrame,
        () => setPhase((p) => (p === "running" ? "sealed" : p)),
        (reason) => {
          setPhase((p) => (p === "sealed" ? p : "error"));
          setError(reason);
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [task, onFrame]);

  const proven = verify?.ok === true;

  return (
    <main className="reef">
      <header className="masthead">
        <div className="wordmark">
          <span className="glyph">▚</span> reef
        </div>
        <p className="tagline">
          Governed agentic sessions you can <em>verify</em>, not just trust.
        </p>
      </header>

      <section className="composer">
        <input
          className="task"
          value={task}
          spellCheck={false}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && phase !== "running") void start();
          }}
          placeholder="Describe a task…"
          aria-label="Task"
        />
        <button
          className="run"
          disabled={phase === "running" || task.trim() === ""}
          onClick={() => void start()}
        >
          {phase === "running" ? "running…" : "run session"}
        </button>
      </section>

      {error !== null && <div className="banner error">⨯ {error}</div>}

      <section className="stream" aria-live="polite">
        {events.length === 0 && phase === "idle" && (
          <p className="hint">
            Every step becomes a tamper-evident evidence link over a governed
            work spine. Run a session to watch the chain form.
          </p>
        )}
        <ol className="timeline">
          {events.map((e) => (
            <EventRow key={e.seq} event={e} />
          ))}
        </ol>
      </section>

      {snapshot !== null && verify !== null && (
        <ProofBlock snapshot={snapshot} verify={verify} proven={proven} />
      )}
    </main>
  );
}

function EventRow({ event }: { event: ReefEvent }): JSX.Element {
  const label = KIND_LABEL[event.kind] ?? event.kind;
  const denied = event.kind === "action.denied";
  return (
    <li className={`row${denied ? " denied" : ""}`}>
      <span className="seq">{String(event.seq).padStart(2, "0")}</span>
      <span className={`kind kind-${event.kind.replace(".", "-")}`}>
        {label}
      </span>
      <span className="summary">{event.summary}</span>
      <span className="evid" title={event.evidenceId}>
        {event.evidenceId.slice(0, 10)}
      </span>
    </li>
  );
}

function ProofBlock({
  snapshot,
  verify,
  proven,
}: {
  snapshot: SessionSnapshot;
  verify: VerifyResult;
  proven: boolean;
}): JSX.Element {
  const checks = useMemo(
    () => [
      { label: "work spine", value: verify.work },
      { label: "evidence log", value: verify.log },
      { label: "cross-binding", value: verify.binding },
    ],
    [verify],
  );
  return (
    <section className={`proof${proven ? " proven" : " broken"}`}>
      <div className="verdict">
        <span className="seal">{proven ? "✓ VERIFIED" : "⨯ UNVERIFIED"}</span>
        <span className="outcome">{snapshot.outcome}</span>
      </div>
      <dl className="checks">
        {checks.map((c) => (
          <div key={c.label} className="check">
            <dt>{c.label}</dt>
            <dd className={okish(c.value) ? "ok" : "bad"}>{c.value}</dd>
          </div>
        ))}
      </dl>
      <div className="chains">
        <span>{snapshot.workChainLength} work links</span>
        <span>{snapshot.logChainLength} evidence links</span>
        <span>{snapshot.actionsExecuted} executed</span>
        <span>{snapshot.actionsDenied} denied</span>
      </div>
      <code className="head" title="evidence-log head">
        {snapshot.logHead.slice(0, 24)}…
      </code>
    </section>
  );
}

function okish(v: string): boolean {
  return v === "intact" || v === "bound";
}
