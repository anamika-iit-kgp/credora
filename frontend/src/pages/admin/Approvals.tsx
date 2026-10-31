import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { usePendingApprovals } from "../../api/workflow";
import { PageHeader, Segmented } from "../../components/ui";
import { ActivationSection } from "../models/ActivationParts";
import { PolicyProposalsSection, type Tab } from "./PolicyApprovals";

type Area = "policy" | "models";

/** The admin approves what the data scientist proposes: policy changes and risk-model activations. */
export function ApprovalsPage() {
  const [sp, setSp] = useSearchParams();
  const area: Area = sp.get("area") === "models" ? "models" : "policy";
  const [tab, setTab] = useState<Tab>("pending");
  const counts = usePendingApprovals();
  const n = counts.data ?? { policy: 0, models: 0 };
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Administration" }, { label: "Approvals" }]}
        title="Approvals"
        lede="Maker-checker for the bank manager. The data scientist proposes, and you approve or reject with a note. Nobody decides their own request, and decided requests are read-only."
        actions={
          <Segmented
            label="Status"
            value={tab}
            onChange={setTab}
            options={[
              { value: "pending", label: "Pending" },
              { value: "decided", label: "Decided" },
            ]}
          />
        }
      >
        <div className="approvals-tabs">
          <Segmented
            label="Approvals"
            value={area}
            onChange={(v) => setSp(v === "policy" ? {} : { area: v }, { replace: true })}
            options={[
              { value: "policy", label: <>Policy proposals {n.policy > 0 && <span className="nav-badge num">{n.policy}</span>}</> },
              { value: "models", label: <>Model activations {n.models > 0 && <span className="nav-badge num">{n.models}</span>}</> },
            ]}
          />
        </div>
      </PageHeader>
      {area === "policy" ? <PolicyProposalsSection tab={tab} onApproved={() => setTab("decided")} /> : <ActivationSection tab={tab} />}
    </div>
  );
}
