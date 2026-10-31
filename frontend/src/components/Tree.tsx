import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight } from "lucide-react";
import type { TreeNode } from "../api/types";
import { sourceMeta } from "../lib/sources";
import { SourceGlyph, SourceTag } from "./SourceTag";

interface Flat {
  node: TreeNode;
  depth: number;
  parent: string | null;
  last: boolean;
}

function defaultOpen(root: TreeNode): Set<string> {
  const s = new Set<string>([root.id]);
  for (const c of root.children) if (c.kind === "partner" || c.kind === "account") s.add(c.id);
  return s;
}

/** Provenance tree: each row carries a rail in its source's colour and shape, plus a source tag. Implements the ARIA tree pattern. */
export function ProvenanceTree({
  root,
  selected,
  onSelect,
}: {
  root: TreeNode;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(() => defaultOpen(root));
  const [focusId, setFocusId] = useState<string>(selected ?? root.id);
  const refs = useRef(new Map<string, HTMLDivElement>());

  const flat = useMemo(() => {
    const out: Flat[] = [];
    const walk = (n: TreeNode, depth: number, parent: string | null, last: boolean) => {
      out.push({ node: n, depth, parent, last });
      if (open.has(n.id)) n.children.forEach((c, i) => walk(c, depth + 1, n.id, i === n.children.length - 1));
    };
    walk(root, 0, null, true);
    return out;
  }, [root, open]);

  const toggle = useCallback((id: string, to?: boolean) => {
    setOpen((s) => {
      const n = new Set(s);
      const want = to ?? !n.has(id);
      if (want) n.add(id);
      else n.delete(id);
      return n;
    });
  }, []);

  const focus = (id: string) => {
    setFocusId(id);
    refs.current.get(id)?.focus();
  };

  function onKey(e: KeyboardEvent, f: Flat) {
    const i = flat.findIndex((x) => x.node.id === f.node.id);
    const has = f.node.children.length > 0;
    switch (e.key) {
      case "ArrowDown":
        if (i < flat.length - 1) focus(flat[i + 1].node.id);
        break;
      case "ArrowUp":
        if (i > 0) focus(flat[i - 1].node.id);
        break;
      case "ArrowRight":
        if (has && !open.has(f.node.id)) toggle(f.node.id, true);
        else if (has) focus(f.node.children[0].id);
        break;
      case "ArrowLeft":
        if (has && open.has(f.node.id)) toggle(f.node.id, false);
        else if (f.parent) focus(f.parent);
        break;
      case "Home":
        focus(flat[0].node.id);
        break;
      case "End":
        focus(flat[flat.length - 1].node.id);
        break;
      case "Enter":
      case " ":
        onSelect(f.node.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div role="tree" aria-label={`Data held on ${root.label}`} className="ptree">
      {flat.map((f, idx) => {
        const m = sourceMeta(f.node.source);
        const has = f.node.children.length > 0;
        const isOpen = open.has(f.node.id);
        return (
          <div
            key={f.node.id}
            ref={(el) => {
              if (el) refs.current.set(f.node.id, el);
              else refs.current.delete(f.node.id);
            }}
            role="treeitem"
            aria-level={f.depth + 1}
            aria-expanded={has ? isOpen : undefined}
            aria-selected={selected === f.node.id}
            tabIndex={focusId === f.node.id ? 0 : -1}
            className={`pnode pk-${m?.kind ?? "none"} ${selected === f.node.id ? "is-selected" : ""} ${f.depth === 0 ? "is-root" : ""}`}
            style={{ ["--depth" as string]: f.depth, ["--i" as string]: idx }}
            onClick={() => {
              setFocusId(f.node.id);
              onSelect(f.node.id);
            }}
            onKeyDown={(e) => onKey(e, f)}
          >
            <span className="pnode-indent" aria-hidden="true" />
            {has ? (
              <button
                className={`pnode-caret ${isOpen ? "is-open" : ""}`}
                tabIndex={-1}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(f.node.id);
                }}
              >
                <ChevronRight />
              </button>
            ) : (
              <span className="pnode-caret is-leaf" aria-hidden="true" />
            )}
            <span className="pnode-rail" aria-hidden="true">
              {m && <SourceGlyph kind={m.kind} />}
            </span>
            <span className="pnode-text">
              <span className="pnode-label">{f.node.label}</span>
              {f.node.sublabel && <span className="pnode-sub">{f.node.sublabel}</span>}
            </span>
            {f.node.source && <SourceTag source={f.node.source} compact className="pnode-tag" />}
          </div>
        );
      })}
    </div>
  );
}
