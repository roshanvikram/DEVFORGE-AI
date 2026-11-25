import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { get } from "./api";
import { useAuth } from "./auth";

export interface Repo {
  id: string; name: string; source_type: string; source_url: string | null; default_branch: string | null; status: string; error: string | null;
  languages: Record<string, { files: number; loc: number }>; frameworks: string[]; last_analyzed_at: string | null; created_at: string; commit: string | null;
  stats: any; health: { score: number | null; breakdown: Record<string, number> };
}

const Ctx = createContext<{ repos: Repo[] | undefined; repo: Repo | null; setRepoId: (id: string) => void; loading: boolean; error: unknown }>(null as any);

/** Workspace repositories + the globally selected repository (persisted; overridable via ?repo=). */
export function RepoProvider({ children }: { children: ReactNode }) {
  const { workspace } = useAuth();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: ["repos", workspace?.id], queryFn: () => get<Repo[]>("/repositories"), enabled: !!workspace, refetchInterval: (query) => ((query.state.data as Repo[] | undefined)?.some((r) => ["pending", "importing", "indexing"].includes(r.status)) ? 3000 : false) });
  const [repoId, setRepoIdState] = useState<string | null>(params.get("repo") ?? localStorage.getItem("df.repo"));
  useEffect(() => {
    const p = params.get("repo");
    if (p && p !== repoId) setRepoIdState(p);
  }, [params]);
  useEffect(() => {
    if (!q.data) return;
    if (!q.data.some((r) => r.id === repoId)) setRepoIdState(q.data[0]?.id ?? null);
  }, [q.data]);
  const setRepoId = (id: string) => {
    localStorage.setItem("df.repo", id);
    setRepoIdState(id);
  };
  const repo = q.data?.find((r) => r.id === repoId) ?? null;
  return <Ctx.Provider value={{ repos: q.data, repo, setRepoId, loading: q.isLoading, error: q.error }}>{children}</Ctx.Provider>;
}
export const useRepo = () => useContext(Ctx);
