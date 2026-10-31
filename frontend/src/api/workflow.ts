// Hand-offs between the roles: publish (datasci -> loan operations), model activation (datasci -> admin),
// assignments (loan operations -> relationship managers) and loan status (relationship manager -> everyone).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, asList } from "./client";
import type {
  ActivationRequest,
  Assignment,
  AssignResult,
  LoanStatus,
  LoanStatusEvent,
  LoanStatusRow,
  PendingApprovals,
  RmInfo,
} from "./types";

type MaybeList<T> = T[] | { items: T[] };

/* ------------------------------ publish ------------------------------ */

export const usePublishRun = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ runId, note }: { runId: string; note: string }) =>
      api<{ run_id: string; published: boolean }>(`/runs/${encodeURIComponent(runId)}/publish`, { body: { note } }),
    onSuccess: () => qc.invalidateQueries(),
  });
};

/* ------------------------------ model activation ------------------------------ */

export const useActivationRequests = (enabled = true) =>
  useQuery({
    queryKey: ["activation-requests"],
    queryFn: async () => asList(await api<MaybeList<ActivationRequest>>("/ml/activation-requests")),
    enabled,
    refetchInterval: 30_000,
  });

export const useRequestActivation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { version: string; note: string }) => api<ActivationRequest>("/ml/activation-requests", { body: b }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["activation-requests"] }),
  });
};

export const useDecideActivation = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: number; action: "approve" | "reject"; note: string }) =>
      api<ActivationRequest>(`/ml/activation-requests/${id}/${action}`, { body: { note } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activation-requests"] });
      qc.invalidateQueries({ queryKey: ["approvals-pending"] });
      qc.invalidateQueries({ queryKey: ["models"] });
    },
  });
};

/** The admin's pending counts, for the Approvals badge in the menu. */
export const usePendingApprovals = (enabled = true) =>
  useQuery({
    queryKey: ["approvals-pending"],
    queryFn: () => api<PendingApprovals>("/approvals/pending"),
    enabled,
    refetchInterval: 30_000,
  });

/* ------------------------------ assignments ------------------------------ */

export const useRms = (enabled = true) =>
  useQuery({ queryKey: ["rms"], queryFn: async () => asList(await api<MaybeList<RmInfo>>("/rms")), enabled });

export const useAssignments = (enabled = true) =>
  useQuery({ queryKey: ["assignments"], queryFn: async () => asList(await api<MaybeList<Assignment>>("/assignments")), enabled });

export const useAssign = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { cif_ids: string[]; rm_id: string }) => api<AssignResult>("/assignments", { body: b }),
    onSuccess: () => {
      for (const k of ["assignments", "rms", "decisions", "top50", "loan-status"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
};

/* ------------------------------ loan status ------------------------------ */

export const useLoanStatus = () =>
  useQuery({ queryKey: ["loan-status"], queryFn: async () => asList(await api<MaybeList<LoanStatusRow>>("/loan-status")) });

export const useLogStatus = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ cif, status, note }: { cif: string; status: LoanStatus; note: string }) =>
      api<LoanStatusEvent>(`/loan-status/${encodeURIComponent(cif)}`, { body: { status, note } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["loan-status"] }),
  });
};

export const LOAN_STATUS_LABEL: Record<LoanStatus, string> = {
  ASSIGNED: "Assigned",
  CONTACTED: "Contacted",
  NEGOTIATING: "Negotiating",
  LOAN_TAKEN: "Loan taken",
  IN_PROGRESS: "In progress",
  DISBURSED: "Disbursed",
  NOT_INTERESTED: "Not interested",
};

/** The statuses a relationship manager can log, in the order a loan moves. */
/** The loan status state machine (backend app/rmbook.py NEXT). Disbursed is final. */
export const NEXT_STATUS: Record<LoanStatus, LoanStatus[]> = {
  ASSIGNED: ["CONTACTED", "NOT_INTERESTED"],
  CONTACTED: ["NEGOTIATING", "NOT_INTERESTED"],
  NEGOTIATING: ["LOAN_TAKEN", "NOT_INTERESTED"],
  LOAN_TAKEN: ["IN_PROGRESS", "NOT_INTERESTED"],
  IN_PROGRESS: ["DISBURSED", "NOT_INTERESTED"],
  NOT_INTERESTED: ["CONTACTED"],
  DISBURSED: [],
};
export const NEEDS_AGREED_OFFER: LoanStatus[] = ["LOAN_TAKEN", "IN_PROGRESS", "DISBURSED"];

export const RM_STATUSES: LoanStatus[] = ["CONTACTED", "NEGOTIATING", "LOAN_TAKEN", "IN_PROGRESS", "DISBURSED", "NOT_INTERESTED"];
