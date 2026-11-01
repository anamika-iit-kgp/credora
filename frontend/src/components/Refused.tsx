import { Lock } from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import { Explain } from "../explain/Explain";

/**
 * Exasol said no. The same block the control room shows for a refused section, so a refusal reads the same on every
 * screen. The message is Exasol's own text, and the refused SQL shows when the API passes it along.
 */
export function Refused({ who, what, message, sql }: { who?: string | null; what: string; message: string; sql?: string }) {
  return (
    <div className="cr-refused">
      <span className="cr-refused-mark" aria-hidden="true">
        <Lock />
      </span>
      <div>
        <p className="cr-refused-title">
          Exasol refused {what} for {who ? <code>{who}</code> : "your role"}
          <Explain id="grant" />
        </p>
        <p className="cr-refused-msg">
          <code>{message}</code>
        </p>
        {sql && <CodeBlock code={sql} lang="sql" />}
        <p className="muted small">The database said no, not the app. Your role holds no grant on this object, so the same query from any tool would fail the same way.</p>
      </div>
    </div>
  );
}
