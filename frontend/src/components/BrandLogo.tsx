import { BadgeIndianRupee, Gauge, Landmark } from "lucide-react";
import exasolOnDark from "../assets/logos/Exasol_Logo_2025_Bright.svg";
import exasolOnLight from "../assets/logos/Exasol_Logo_2025_Dark.svg";
import { MYSQL, ORACLE, POSTGRES } from "../assets/logos/paths";

/** The official Exasol logo; the light/dark variant follows the theme (see .brand-exasol in components.css). */
export function ExasolLogo({ height = 22 }: { height?: number }) {
  return (
    <span className="brand-exasol" style={{ height }}>
      <img className="on-dark" src={exasolOnDark} alt="Exasol" height={height} />
      <img className="on-light" src={exasolOnLight} alt="Exasol" height={height} />
    </span>
  );
}

function Mark({ m, size, label }: { m: { path: string; hex: string; viewBox: string }; size: number; label: string }) {
  const wide = m.viewBox !== "0 0 24 24";
  return (
    <svg
      className="brand-mark"
      role="img"
      aria-label={label}
      viewBox={m.viewBox}
      height={wide ? size * 0.55 : size}
      width={wide ? size * 2.6 : size}
      fill={m.hex}
    >
      <path d={m.path} />
    </svg>
  );
}

/**
 * The technology behind a source: real database brands for Sapphire Bank's systems and Exasol,
 * neutral icons for the mock external APIs (they imitate CIBIL, GSTN and the Account Aggregator,
 * so they deliberately do not wear those organisations' logos).
 */
export function BrandLogo({ source, size = 22 }: { source: string; size?: number }) {
  switch (source) {
    case "bank.oracle":
      return <Mark m={ORACLE} size={size} label="Oracle" />;
    case "bank.mysql":
      return <Mark m={MYSQL} size={size} label="MySQL" />;
    case "bank.postgres":
      return <Mark m={POSTGRES} size={size} label="PostgreSQL" />;
    case "api.cibil":
      return <Gauge className="brand-icon" size={size} aria-label="Credit bureau (mock)" />;
    case "api.gstn":
      return <BadgeIndianRupee className="brand-icon" size={size} aria-label="GST network (mock)" />;
    case "api.aa":
      return <Landmark className="brand-icon" size={size} aria-label="Account Aggregator (mock)" />;
    case "exasol":
      return <ExasolLogo height={size} />;
    default:
      return null;
  }
}
