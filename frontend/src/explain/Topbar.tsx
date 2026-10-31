import { Link } from "react-router-dom";
import { BookOpen, SquareTerminal } from "lucide-react";
import { useExplain } from "./ExplainContext";
import { Explain } from "./Explain";
import { unreadCount, useConsoleFeed } from "./ExasolConsole";

/** The slim bar above every screen: the Explain mode switch and, with it on, the Exasol console. */
export function Topbar() {
  const { on, setOn, consoleOpen, setConsoleOpen, exasolUser } = useExplain();
  const feed = useConsoleFeed();
  const unread = consoleOpen ? 0 : unreadCount(feed);
  return (
    <div className={`topbar ${on ? "is-explain" : ""}`}>
      <p className="topbar-who">
        {on && exasolUser && (
          <>
            <span className="topbar-who-label">Signed in to Exasol as</span>
            <code>{exasolUser}</code>
            <Explain id="current-user" label="the Exasol user you read as" />
          </>
        )}
      </p>
      <div className="topbar-tools">
        {on && (
          <>
            <Link to="/glossary" className="topbar-btn">
              <BookOpen aria-hidden="true" />
              <span className="topbar-btn-text">Glossary</span>
            </Link>
            <button
              type="button"
              className={`topbar-btn ${consoleOpen ? "is-on" : ""}`}
              aria-pressed={consoleOpen}
              onClick={() => setConsoleOpen(!consoleOpen)}
            >
              <SquareTerminal aria-hidden="true" />
              <span className="topbar-btn-text">Exasol console</span>
              {unread > 0 && (
                <span className="topbar-count num" aria-label={`${unread} new statements`}>
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
          </>
        )}
        <button type="button" role="switch" aria-checked={on} className="xswitch" onClick={() => setOn(!on)}>
          <span className="xswitch-track" aria-hidden="true">
            <span className="xswitch-thumb" />
          </span>
          Explain mode
        </button>
      </div>
    </div>
  );
}
