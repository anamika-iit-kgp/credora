// Policy maker-checker: saved what-if runs (datasci) and policy proposals (datasci proposes, admin decides).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, asList } from "./client";
import type { ApproveResult, PolicyProposal, WhatIfParams, WhatIfRun } from "./types";

type MaybeList<T> = T[] | { items: T[] };

export const useWhatIfRuns = (enabled = true) =>
  useQuery({
    queryKey: ["whatif-runs"],
    queryFn: async () => asList(await api<MaybeList<WhatIfRun>>("/whatif/runs")),
    enabled,
  });

export const useSaveWhatIfRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: WhatIfParams) => api<WhatIfRun>("/whatif/runs", { body: p }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatif-runs"] }),
  });
};

/** Admin: every proposal. Data scientist: their own. Polled so the admin's badge stays current. */
export const useProposals = (enabled = true) =>
  useQuery({
    queryKey: ["policy-proposals"],
    queryFn: async () => asList(await api<MaybeList<PolicyProposal>>("/policy/proposals")),
    enabled,
    refetchInterval: 30_000,
  });

export const useCreateProposal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { run_id: string; note: string }) => api<PolicyProposal>("/policy/proposals", { body: b }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policy-proposals"] });
      qc.invalidateQueries({ queryKey: ["whatif-runs"] });
    },
  });
};

export const useDecideProposal = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: number; action: "approve" | "reject"; note: string }) =>
      api<ApproveResult | PolicyProposal>(`/policy/proposals/${id}/${action}`, { body: { note } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["policy-proposals"] });
      qc.invalidateQueries({ queryKey: ["whatif-runs"] });
      qc.invalidateQueries({ queryKey: ["approvals-pending"] });
    },
  });
};
