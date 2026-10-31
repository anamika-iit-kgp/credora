-- Semantic SQL through the preprocessor framework.
--
-- Exasol has one sql_preprocessor_script slot. PREPROC_RT.MASTER (exasol-labs/preprocessor-framework)
-- owns it and runs, for each user, the modules that the rules in PREPROC.CONFIG give that user.
-- exasol-labs/exasol-semantic-views ships its own preprocessor, SEMANTIC_ADMIN.SEMANTIC_PREPROCESSOR,
-- written to own the slot itself; neither project ships a module that joins the two. So this file
-- does what the framework's "Bring your own preprocessor" contract asks for: a module script whose
-- function takes the statement text and returns the rewritten text, or nil for "not mine".
--
-- The module makes the same decisions as SEMANTIC_ADMIN.SEMANTIC_PREPROCESSOR and calls the same
-- runtimes. Two differences:
--   * It finds out whether a statement reads a published semantic schema by looking up that
--     schema's SEMANTIC_DISCOVERY table in SYS.EXA_ALL_TABLES (one query for all candidate
--     schemas), so an ordinary statement from a role user costs about a millisecond, never loads
--     the ~500 kB compiler, and leaves no failed statement in Exasol's audit log.
--   * The framework skips a module that raises (fail-open). A semantic query the layer refuses
--     (an unknown metric, a dimension the model will not group that metric by) must still fail
--     with the layer's own message, not run unrewritten. So the module returns a statement that
--     fails with that message, through PREPROC_RT.SEMANTIC_VIEWS_REFUSE_V1.
--
-- Exasol's Lua import() only binds its alias at a script's top level, not inside a function of
-- an imported module. The runtimes are therefore imported at the top level, which runs each time
-- MASTER imports this module, and only when the statement could need them.
--
-- Rules: the roles that may query the semantic model (see 12_credora_model.sql). R_SVC has no
-- rule: the web app's service sessions see no change, and with self-disable on, MASTER clears
-- their session preprocessor after their first statement.

--/
CREATE OR REPLACE LUA SCALAR SCRIPT PREPROC_RT.SEMANTIC_VIEWS_REFUSE_V1(message VARCHAR(2000000))
RETURNS VARCHAR(2000000) AS
function run(ctx)
    error(ctx.message, 0)
end
/

--/
CREATE OR REPLACE LUA SCRIPT PREPROC_RT.SEMANTIC_VIEWS_V1() AS
-- Statement shapes semantic_definition.preprocess_sql handles: one of these words, naming SEMANTIC.
local COMMAND_WORDS = {ALTER = true, SHOW = true, DESCRIBE = true, EXPLAIN = true, EXPORT = true}

local function head_of(text)
    if type(text) ~= "string" then return "" end
    return (string.gsub(string.upper(text), "^%s+", ""))
end

local function is_definition(head)
    return COMMAND_WORDS[string.match(head, "^(%a+)") or ""] ~= nil
        and string.find(head, "SEMANTIC", 1, true) ~= nil
end

local function is_query(head)
    return string.find(head, "SELECT", 1, true) ~= nil and string.find(head, "FROM", 1, true) ~= nil
end

-- Does the statement read from a published semantic schema the caller may read? Every published
-- schema holds one table, SEMANTIC_DISCOVERY, and SYS.EXA_ALL_TABLES lists only the tables the
-- caller may access, so one lookup answers both questions in about a millisecond. (Selecting from
-- <schema>.SEMANTIC_DISCOVERY directly would answer too, but every miss is a failed statement in
-- EXA_DBA_AUDIT_SQL.) Only relations after FROM or JOIN are candidates: that is where a semantic
-- view has to appear to be rewritten. Names are identifiers ([A-Z_][A-Z0-9_]*), safe to quote.
local function names_published_schema(head)
    local seen, candidates = {}, {}
    for _, keyword in ipairs({"FROM", "JOIN"}) do
        for name in string.gmatch(head, keyword .. '%s+"?([%a_][%w_]*)"?%s*%.') do
            if not seen[name] and #candidates < 4 then
                seen[name] = true
                candidates[#candidates + 1] = "'" .. name .. "'"
            end
        end
    end
    if #candidates == 0 then return false end
    local ok, rows = pcall(query, "SELECT 1 FROM SYS.EXA_ALL_TABLES WHERE TABLE_NAME = 'SEMANTIC_DISCOVERY'"
        .. " AND TABLE_SCHEMA IN (" .. table.concat(candidates, ", ") .. ")")
    return ok and #rows > 0
end

local head = head_of(sqlparsing.getsqltext())
if is_definition(head) then
    pcall(import, "SEMANTIC_ADMIN.SEMANTIC_DEFINITION_RUNTIME", "semantic_definition")
end
if is_query(head) and names_published_schema(head) then
    pcall(import, "SEMANTIC_ADMIN.COMPILER_RUNTIME", "compiler")
end

local function refuse(code, message)
    local text = tostring(code or "SEMANTIC_QUERY_999") .. ": "
        .. tostring(message or "Semantic SQL preprocessing failed.")
    text = (string.gsub(text, "'", "''"))
    return "SELECT PREPROC_RT.SEMANTIC_VIEWS_REFUSE_V1('" .. text .. "') AS SEMANTIC_ERROR FROM DUAL"
end

local function outcome(ok, result)
    if not ok then return refuse("SEMANTIC_QUERY_999", result) end
    if type(result) ~= "table" or result.status == "UNCHANGED" then return nil end
    if result.status == "OK" then return result.generated_sql end
    return refuse(result.error_code, result.error_message)
end

function semantic_views(sqltext)
    local h = head_of(sqltext)
    if semantic_definition ~= nil and is_definition(h) then
        local answer = outcome(pcall(semantic_definition.preprocess_sql, sqltext))
        if answer ~= nil then return answer end
    end
    if compiler ~= nil and is_query(h) then
        return outcome(pcall(compiler.compile_sql_for_preprocessor, sqltext))
    end
    return nil
end
/

-- Provenance: PREPROC_RT.INSTALLED_MODULES lists the module with the semantic-views release it fronts.
EXECUTE SCRIPT PREPROC.MODULE_REGISTER('semantic_views', 1, 'exasol-labs/exasol-semantic-views', '${SEMVIEWS_VERSION}',
  NULL, 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', 'EXPAND', 'self-deployed', NULL, NULL, NULL);

EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_MCP', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_ADMIN', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_DATASCI', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_LOANOPS', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);
EXECUTE SCRIPT PREPROC.RULE_ENSURE('ROLE', 'R_RM', 'EXPAND', 'PREPROC_RT.SEMANTIC_VIEWS_V1', 'semantic_views', NULL, TRUE);

-- Sessions without a rule (the web app's service account, CREDORA_SVC) stop paying the per-statement
-- lookup after their first statement.
EXECUTE SCRIPT PREPROC.SET_SELF_DISABLE(TRUE);

-- Resolve rules against the current role grants (needed again whenever grants change).
EXECUTE SCRIPT PREPROC.REFRESH;
