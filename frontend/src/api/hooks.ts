import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api, asList } from "./client";
import type {
  AiStatus,
  AskAnswer,
  AuditEntry,
  CompanyRow,
  CreditMemo,
  DecisionRow,
  GenerateRequest,
  Job,
  JobRef,
  Model,
  ModelComparison,
  NodeRecords,
  Offer,
  OfferEvent,
  Overview,
  Page,
  PurgeEntry,
  Quote,
  Report,
  Run,
  SourceHealth,
  Terms,
  Top50Row,
  TreeNode,
  User,
  WhatIfParams,
  WhatIfResult,
} from "./types";

type MaybeList<T> = T[] | { items: T[] };

function qs(params: Record<string, string | number | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : "";
}

export const useMe = (enabled: boolean) =>
  useQuery({ queryKey: ["me"], queryFn: () => api<User>("/me"), enabled, retry: false });

export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/overview") });

export const useSources = () =>
  useQuery({
    queryKey: ["sources"],
    queryFn: async () => asList(await api<MaybeList<SourceHealth>>("/admin/sources")),
  });

export const useAudit = (limit = 100) =>
  useQuery({
    queryKey: ["audit", limit],
    queryFn: async () => asList(await api<MaybeList<AuditEntry>>(`/admin/audit${qs({ limit })}`)),
  });

export const usePurgeLog = () =>
  useQuery({
    queryKey: ["purge-log"],
    queryFn: async () => asList(await api<MaybeList<PurgeEntry>>("/admin/purge-log")),
  });

export const useJob = (jobId: string | null) =>
  useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api<Job>(`/jobs/${encodeURIComponent(jobId!)}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== "running" ? false : 900),
  });

export interface CompanyFilter {
  q?: string;
  stage?: string;
  decision?: string;
  page?: number;
  size?: number;
}

export const useCompanies = (f: CompanyFilter) =>
  useQuery({
    queryKey: ["companies", f],
    queryFn: () => api<Page<CompanyRow>>(`/companies${qs({ ...f })}`),
    placeholderData: keepPreviousData,
  });

export const useTree = (cif: string) =>
  useQuery({ queryKey: ["tree", cif], queryFn: () => api<TreeNode>(`/companies/${encodeURIComponent(cif)}/tree`) });

export const useNode = (nodeId: string | null) =>
  useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => api<NodeRecords>(`/nodes/${encodeURIComponent(nodeId!)}`),
    enabled: !!nodeId,
  });

export const useReport = (cif: string) =>
  useQuery({
    queryKey: ["report", cif],
    queryFn: () => api<Report>(`/companies/${encodeURIComponent(cif)}/report`),
    retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2,
  });

export const useRuns = (enabled = true) =>
  useQuery({ queryKey: ["runs"], queryFn: async () => asList(await api<MaybeList<Run>>("/runs")), enabled });

export const useDecisions = (f: { decision?: string; grade?: string; assigned?: string; page?: number }) =>
  useQuery({
    queryKey: ["decisions", f],
    queryFn: () => api<Page<DecisionRow>>(`/decisions${qs(f)}`),
    placeholderData: keepPreviousData,
  });

export const useTop50 = (runId = "") =>
  useQuery({
    queryKey: ["top50", runId],
    queryFn: async () =>
      asList(await api<MaybeList<Top50Row>>(runId ? `/top50?run_id=${encodeURIComponent(runId)}` : "/top50")),
  });

export const useModels = () =>
  useQuery({ queryKey: ["models"], queryFn: async () => asList(await api<MaybeList<Model>>("/ml/models")) });

/** Champion vs challenger; under the "models" key, so training and activating refresh it too. */
export const useModelCompare = () =>
  useQuery({ queryKey: ["models", "compare"], queryFn: () => api<ModelComparison>("/ml/compare") });

export const useOffers = (stage?: string) =>
  useQuery({
    queryKey: ["offers", stage ?? ""],
    queryFn: async () => asList(await api<MaybeList<Offer>>(`/offers${qs({ stage })}`)),
  });

export const useOfferEvents = (offerId: number | null) =>
  useQuery({
    queryKey: ["offer-events", offerId],
    queryFn: async () => asList(await api<MaybeList<OfferEvent>>(`/offers/${offerId}/events`)),
    enabled: offerId !== null,
  });

export const useAiStatus = () =>
  useQuery({ queryKey: ["ai-status"], queryFn: () => api<AiStatus>("/ai/status"), staleTime: 300_000 });

/** The latest stored credit memo for this company in the current run, or null when there is none. */
export const useCreditMemo = (cif: string, enabled = true) =>
  useQuery({
    queryKey: ["memo", cif],
    queryFn: async () => {
      try {
        return await api<CreditMemo>(`/companies/${encodeURIComponent(cif)}/memo`);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled,
  });

/* ---------- mutations ---------- */

export const useAsk = () =>
  useMutation({ mutationFn: (question: string) => api<AskAnswer>("/ai/ask", { body: { question } }) });

export const useGenerateMemo = (cif: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<CreditMemo>(`/companies/${encodeURIComponent(cif)}/memo`, { method: "POST", body: {} }),
    onSuccess: (m) => qc.setQueryData(["memo", cif], m),
  });
};

export const useStartGenerate = () =>
  useMutation({
    mutationFn: ({ seed, mode, companies }: GenerateRequest) =>
      api<JobRef>("/admin/generate", { body: { ...(seed === null ? {} : { seed }), mode, ...(mode === "append" ? { companies } : {}) } }),
  });

export const useStartAnalysis = () =>
  useMutation({ mutationFn: () => api<JobRef>("/analysis/run", { method: "POST", body: {} }) });

export const useStartTraining = () =>
  useMutation({ mutationFn: () => api<JobRef>("/ml/train", { method: "POST", body: {} }) });

// Activating a model is a request the admin approves: api/workflow.ts useRequestActivation.

export const useWhatIf = () =>
  useMutation({ mutationFn: (p: WhatIfParams) => api<WhatIfResult>("/whatif", { body: p }) });

export const quoteOffer = (offerId: number, t: Terms, signal?: AbortSignal) =>
  api<Quote>(`/offers/${offerId}/quote`, { body: t, signal });

export const useOfferAction = (offerId: number) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { action: "propose" | "verify" | "sanction" | "reject"; body: Record<string, unknown> }) =>
      api<Offer>(`/offers/${offerId}/${a.action}`, { body: a.body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["offers"] });
      qc.invalidateQueries({ queryKey: ["offer-events", offerId] });
      // A proposal can move the loan status to Negotiating, and the stage shows in the tracker and ranking.
      qc.invalidateQueries({ queryKey: ["loan-status"] });
      qc.invalidateQueries({ queryKey: ["top50"] });
    },
  });
};
