import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { get, post, setWorkspaceId, getWorkspaceId } from "./api";

export interface Workspace { id: string; name: string; slug: string; role: string; org_name: string; org_id: string; permissions: string[] }
export interface Me {
  user: { id: string; email: string; name: string; email_verified_at: string | null; avatar_url: string | null; has_password: boolean; providers: string[] };
  workspaces: Workspace[];
  onboarding: { step: number; data: Record<string, any>; completed: boolean };
  activeWorkspaceId: string | null;
}

interface AuthCtx {
  me: Me | null | undefined; // undefined = loading
  workspace: Workspace | null;
  can: (perm: string) => boolean;
  authError: unknown;
  retryAuth: () => void;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>(null as any);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await get<Me>("/auth/me");
      } catch (e: any) {
        if (e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    // A restarting or unreachable server is not a logout: retry network failures quietly.
    retry: (n, e: any) => e?.status === 0 && n < 8,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 8000),
  });
  // undefined = still resolving (or server unreachable); null = definitively signed out (401).
  const me = q.data !== undefined ? q.data : undefined;
  const [wsId, setWs] = useState<string | null>(getWorkspaceId());
  useEffect(() => {
    if (!me) return;
    const valid = me.workspaces.some((w) => w.id === wsId);
    const next = valid ? wsId : (me.activeWorkspaceId && me.workspaces.some((w) => w.id === me.activeWorkspaceId) ? me.activeWorkspaceId : me.workspaces[0]?.id ?? null);
    if (next !== wsId) setWs(next);
    setWorkspaceId(next);
  }, [me, wsId]);
  const workspace = me?.workspaces.find((w) => w.id === wsId) ?? null;
  const value: AuthCtx = {
    me,
    authError: q.data === undefined && q.isError ? q.error : null,
    retryAuth: () => q.refetch(),
    workspace,
    can: (p) => !!workspace?.permissions.includes(p),
    refresh: async () => { await qc.invalidateQueries({ queryKey: ["me"] }); },
    switchWorkspace: async (id) => {
      await post("/auth/active-workspace", { workspaceId: id });
      setWorkspaceId(id);
      setWs(id);
      localStorage.removeItem("df.repo");
      qc.clear();
      await qc.invalidateQueries();
    },
    logout: async () => {
      await post("/auth/logout").catch(() => {});
      setWorkspaceId(null);
      localStorage.removeItem("df.repo");
      qc.clear();
      window.location.href = "/";
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
