import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useAuth } from "./auth";

type Listener = (e: any) => void;
const Ctx = createContext<{ subscribe: (fn: Listener) => () => void; connected: boolean }>({ subscribe: () => () => {}, connected: false });

/** WebSocket connection to the workspace event stream; invalidates queries on server events. */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { workspace } = useAuth();
  const qc = useQueryClient();
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!workspace) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    let timer: any;
    const invalidate = (keys: string[]) => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/events?workspace=${workspace.id}`);
      ws.onopen = () => { setConnected(true); retry = 1000; };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(connect, (retry = Math.min(retry * 2, 15000)));
      };
      ws.onmessage = (m) => {
        let e: any;
        try { e = JSON.parse(m.data); } catch { return; }
        listeners.current.forEach((fn) => fn(e));
        switch (e.type) {
          case "job": if (["completed", "failed", "cancelled"].includes(e.status)) invalidate(["jobs", "repos", "repo", "dashboard", "findings", "scans"]); else invalidate(["jobs"]); break;
          case "scan": invalidate(["scans", "findings", "dashboard"]); break;
          case "repository": invalidate(["repos", "repo"]); break;
          case "agent_run": case "agent_step": invalidate(["agent-runs", "agent-run", "agents"]); break;
          case "test_run": invalidate(["tests", "test"]); break;
          case "review": invalidate(["reviews", "review"]); break;
          case "investigation": invalidate(["investigations", "investigation"]); break;
          case "workflow_execution": invalidate(["workflow-execution", "workflows", "approvals"]); break;
          case "notification": invalidate(["notifications"]); toast(e.title); break;
          case "activity": invalidate(["activity"]); break;
        }
      };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [workspace?.id]);
  return <Ctx.Provider value={{ connected, subscribe: (fn) => { listeners.current.add(fn); return () => listeners.current.delete(fn); } }}>{children}</Ctx.Provider>;
}

export const useRealtime = () => useContext(Ctx);
export function useEvent(fn: Listener, deps: unknown[] = []) {
  const { subscribe } = useRealtime();
  useEffect(() => subscribe(fn), deps);
}
