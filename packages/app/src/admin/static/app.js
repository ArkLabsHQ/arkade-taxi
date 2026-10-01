"use strict";

const STATES = [
    "quoted",
    "locking",
    "recovering",
    "locked",
    "recycled",
    "purchased",
    "refunded",
    "recovered",
    "expired",
];

const SATS_FIELDS = ["maxOutstandingSats", "maxPerPaymentTopupSats"];
const INT_FIELDS = [
    "maxConcurrentAdvances",
    "locktimeMarginBlocks",
    "locktimeMarginSeconds",
    "quoteTtlSeconds",
];

const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);

const view = {
    status: null,
    policy: null,
    offline: false,
    advances: [],
    nextAdvanceOffset: null,
    advanceSnapshot: null,
    advanceFilter: "",
    advanceGeneration: 0,
};

// Sats arrive as decimal strings and can exceed 2^53, so nothing here parses
// them as a number.
function group(digits) {
    let out = "";
    for (let i = 0; i < digits.length; i++) {
        if (i > 0 && (digits.length - i) % 3 === 0) out += " ";
        out += digits[i];
    }
    return out;
}

function duration(ms) {
    if (ms === null || ms === undefined) return "never";
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    if (h < 48) return h + "h " + (m % 60) + "m";
    return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

const stamp = (ms) => (ms === null || ms === undefined ? "" : new Date(ms).toISOString());

async function api(path, options) {
    const res = await fetch(path, options);
    const body = await res.text();
    let parsed = null;
    if (body !== "") {
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            throw new Error("malformed response from " + path);
        }
    }
    if (!res.ok) {
        const error = new Error((parsed && parsed.error) || res.status + " " + res.statusText);
        error.code = parsed && parsed.code;
        throw error;
    }
    return parsed;
}

function gateActions() {
    for (const id of ["apply", "pause", "resume", "rescan"]) $(id).disabled = false;
}

function setNote(id, text, isError) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("is-error", Boolean(isError));
}

function renderAlarm() {
    const alarm = $("alarm");
    const sweeper = view.status && view.status.sweeper;
    let title = null;
    let detail = "";

    if (view.offline) {
        title = "Console cannot reach the service";
        detail = "the numbers below are stale";
    } else if (sweeper && !sweeper.healthy) {
        title = sweeper.running ? "Sweeper is not sweeping" : "Sweeper is not running";
        detail =
            "last tick " +
            duration(sweeper.sinceLastTickMs) +
            " ago, stale after " +
            duration(sweeper.staleAfterMs) +
            (sweeper.lastError ? " — " + sweeper.lastError : "") +
            " — recovery is what bounds exposure";
    }

    alarm.hidden = title === null;
    document.body.classList.toggle("is-alarm", title !== null);
    if (title !== null) {
        $("alarm-title").textContent = title;
        $("alarm-detail").textContent = detail;
    }
    document.title = (title === null ? "" : "ALARM · ") + "arkade-taxi operator console";
}

function renderStates(counts) {
    const host = $("states");
    host.textContent = "";
    for (const state of STATES) {
        const n = counts[state] || 0;
        const wrap = document.createElement("div");
        if (n > 0) wrap.className = "is-live";
        const dt = document.createElement("dt");
        dt.textContent = state;
        const dd = document.createElement("dd");
        dd.textContent = String(n);
        wrap.append(dt, dd);
        host.append(wrap);
    }
}

function renderExposure(status) {
    const outstanding = status.exposure.outstandingSats;
    $("outstanding").firstChild.nodeValue = group(outstanding);
    $("locked-count").textContent = String(status.exposure.activeCount);
    const oldest = status.exposure.oldestUnsweptLocktime;
    $("oldest-locktime").textContent =
        oldest.height === null && oldest.time === null
            ? "none active"
            : `${oldest.height === null ? "—" : group(oldest.height)} / ${
                  oldest.time === null ? "—" : group(oldest.time)
              }`;

    const cap = view.policy ? BigInt(view.policy.maxOutstandingSats) : null;
    $("cap").textContent = cap === null ? "—" : group(cap.toString());

    const fill = $("gauge");
    if (cap === null || cap === 0n) {
        $("cap-used").textContent = cap === 0n ? "no cap set" : "—";
        fill.style.width = "0";
        fill.classList.remove("is-high");
        return;
    }
    const pct = Number((BigInt(outstanding) * 10000n) / cap) / 100;
    $("cap-used").textContent = pct.toFixed(1) + "%";
    fill.style.width = Math.min(100, pct) + "%";
    fill.classList.toggle("is-high", pct >= 90);
}

function renderSweeper(sweeper) {
    const tick = $("sweeper-tick");
    tick.textContent = sweeper.lastTickAt === null ? "never" : duration(sweeper.sinceLastTickMs);
    tick.title = stamp(sweeper.lastTickAt);
    tick.classList.toggle("tick--stale", !sweeper.healthy);

    const label = $("sweeper-state");
    label.textContent = sweeper.healthy ? "healthy" : sweeper.running ? "stale" : "stopped";
    label.classList.toggle("is-bad", !sweeper.healthy);

    $("sweeper-meta").textContent =
        "interval " +
        duration(sweeper.intervalMs) +
        " · stale after " +
        duration(sweeper.staleAfterMs) +
        " · height " +
        (sweeper.lastHeight === null ? "unknown" : group(sweeper.lastHeight)) +
        " · recovery submissions " +
        sweeper.recoverySubmittedTotal;

    const err = $("sweeper-error");
    err.hidden = !sweeper.lastError;
    err.textContent = sweeper.lastError || "";
}

function renderOperational(readiness) {
    const runtime = readiness.runtime || {};
    const inventory = runtime.inventory || {};
    const provider = runtime.provider || {};
    const deadlines = readiness.sweeper.nearestDeadline;
    $("readiness-state").textContent = readiness.status;
    $("startup-phase").textContent = readiness.startup ? readiness.startup.phase : "legacy";
    $("usable-inventory").textContent =
        inventory.usableSats === undefined
            ? "unknown"
            : group(inventory.usableSats) + " sats / " + inventory.usableVtxos + " vtxos";
    $("reserved-inventory").textContent =
        inventory.reservedSats === undefined
            ? "unknown"
            : group(inventory.reservedSats) + " sats / " + inventory.reservedVtxos + " vtxos";
    $("provider-network").textContent =
        (provider.network || "unknown") + (provider.identityOk ? " / verified" : " / blocked");
    $("height-expiry").textContent = deadlines.height
        ? deadlines.height.remaining + " blocks / " + deadlines.height.severity
        : "none";
    $("time-expiry").textContent = deadlines.time
        ? deadlines.time.remaining + " seconds / " + deadlines.time.severity
        : "none";
    $("readiness-blockers").textContent = readiness.blockers.length
        ? "Blockers: " + readiness.blockers.join(", ")
        : "No operational blockers.";
}

function renderFunding(funding) {
    const sats = (value) => (value === null ? "unknown" : group(value) + " sats");
    $("funding-address").textContent = funding.arkAddress;
    $("funding-copy").disabled = false;
    $("funding-usable").textContent = sats(funding.usableSats);
    $("funding-reserved").textContent = sats(funding.reservedSats);
    $("funding-threshold").textContent = sats(funding.minReserveSats);
    $("funding-state").textContent =
        funding.usableSats === null
            ? "inventory unknown"
            : BigInt(funding.usableSats) < BigInt(funding.minReserveSats)
              ? "below reserve"
              : "reserve met";
    const body = $("funding-assets");
    body.textContent = "";
    for (const a of funding.assets) {
        const tr = document.createElement("tr");
        const id = document.createElement("td");
        id.append(cell("span", a.assetId.txid, "trunc"));
        id.title = a.assetId.txid;
        tr.append(
            id,
            cell("td", String(a.assetId.groupIndex), "n"),
            cell("td", group(a.amount), "n"),
        );
        body.append(tr);
    }
    $("funding-assets-empty").hidden = funding.assets.length > 0;
}

function renderAdvances(rows) {
    const body = $("advances-body");
    body.textContent = "";
    const height =
        view.status && view.status.sweeper.lastHeight !== null
            ? BigInt(view.status.sweeper.lastHeight)
            : null;
    for (const a of rows) {
        const tr = document.createElement("tr");
        const due = a.state === "locked" && height !== null && BigInt(a.locktime) <= height;

        const id = document.createElement("th");
        id.scope = "row";
        id.append(cell("span", a.id, "trunc"));
        id.title = a.id;

        const state = document.createElement("td");
        const tag = cell("span", a.state, "state-tag" + (a.state === "locked" ? " is-locked" : ""));
        state.append(tag);
        if (due) state.append(" ", cell("span", "due", "due"));

        tr.append(
            id,
            state,
            cell("td", group(a.topup), "n"),
            cell("td", group(a.fare.units), "n dim"),
            cell("td", group(a.locktime), due ? "n due" : "n"),
            cell("td", duration(a.ageSeconds * 1000), "n dim"),
            cell("td", a.recoveryPhase || a.submissionPhase || "observing", "dim"),
        );

        const action = document.createElement("td");
        const retry =
            a.state === "locking"
                ? "retry-submission"
                : a.state === "recovering" && a.recoveryPhase === "prepared"
                  ? "retry-recovery"
                  : null;
        if (retry) {
            const button = cell("button", retry.replace("retry-", "retry "));
            button.type = "button";
            button.addEventListener("click", () =>
                mutate(
                    () =>
                        postAction("/admin/api/advances/" + encodeURIComponent(a.id) + "/" + retry),
                    "switch-note",
                ),
            );
            action.append(button);
        }
        tr.append(action);

        const addr = document.createElement("td");
        addr.className = "dim";
        addr.append(cell("span", a.covenantAddress, "trunc"));
        addr.title = a.covenantAddress;
        tr.append(addr);

        body.append(tr);
    }

    $("advances-empty").hidden = rows.length > 0;
}

function cell(tag, text, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    return el;
}

function renderHistory(rows) {
    const body = $("history-body");
    body.textContent = "";
    for (const r of rows) {
        const tr = document.createElement("tr");
        const when = cell("td", duration(Date.now() - r.changedAt) + " ago", "dim");
        when.title = stamp(r.changedAt);
        tr.append(
            when,
            cell("td", r.field),
            cell("td", r.oldValue, "dim"),
            cell("td", r.newValue),
            cell("td", r.actor),
        );
        body.append(tr);
    }
    $("history-empty").hidden = rows.length > 0;
}

// The wire spells a fare's currency as its bare kind, a token's assetId beside
// it; PATCH wants { kind, assetId }. unclaimedMode is output-only.
function editableRules(rules) {
    return rules.map(({ unclaimedMode, ...rule }) => ({
        ...rule,
        fares: rule.fares.map(({ id, currency, assetId, ...fare }) => ({
            id,
            currency: currency === "token" ? { kind: currency, assetId } : { kind: currency },
            ...fare,
        })),
    }));
}

function fillPolicyForm(policy) {
    for (const f of SATS_FIELDS.concat(INT_FIELDS)) $(f).value = policy[f];
    $("assetRules").value = JSON.stringify(editableRules(policy.assetRules), null, 2);
    $("policy-loaded").textContent = "loaded " + new Date().toLocaleTimeString();
}

function renderServiceState(paused) {
    const pill = $("service-state");
    pill.textContent = paused ? "paused" : "quoting";
    pill.classList.toggle("pill--attention", paused);
}

function policyPatch(rules) {
    const patch = {};
    for (const f of SATS_FIELDS) {
        const v = $(f).value.trim();
        if (v !== view.policy[f]) patch[f] = v;
    }
    for (const f of INT_FIELDS) {
        const v = Number($(f).value);
        if (v !== view.policy[f]) patch[f] = v;
    }
    if (JSON.stringify(rules) !== JSON.stringify(editableRules(view.policy.assetRules))) {
        patch.assetRules = rules;
    }
    return patch;
}

async function loadStatus() {
    const status = await api("/admin/api/status");
    view.status = status;
    renderExposure(status);
    renderStates(status.counts);
    renderSweeper(status.sweeper);
    renderOperational(status.readiness);
    renderServiceState(status.paused);
    $("updated").textContent = "updated " + new Date().toLocaleTimeString();
}

async function loadAdvances(append) {
    const state = $("state-filter").value;
    let generation;
    let expectedSnapshot = null;
    let offset = null;
    if (append) {
        generation = view.advanceGeneration;
        expectedSnapshot = view.advanceSnapshot;
        offset = view.nextAdvanceOffset;
        if (expectedSnapshot === null || offset === null) return;
    } else {
        generation = ++view.advanceGeneration;
        const changedFilter = view.advanceFilter !== state;
        view.advanceFilter = state;
        view.advanceSnapshot = null;
        view.nextAdvanceOffset = null;
        $("advances-more").hidden = true;
        $("advances-more").disabled = false;
        if (changedFilter) {
            view.advances = [];
            renderAdvances([]);
        }
    }
    const params = new URLSearchParams();
    if (state) params.set("state", state);
    if (offset !== null) {
        params.set("offset", String(offset));
        params.set("snapshot", expectedSnapshot);
    }
    const query = params.toString();
    let result;
    try {
        result = await api("/admin/api/advances" + (query ? "?" + query : ""));
    } catch (error) {
        const current =
            generation === view.advanceGeneration &&
            state === view.advanceFilter &&
            state === $("state-filter").value &&
            (!append || expectedSnapshot === view.advanceSnapshot);
        if (!current) return;
        if (append && error.code === "snapshot_changed") {
            view.advanceGeneration++;
            view.advanceSnapshot = null;
            view.nextAdvanceOffset = null;
            view.advances = [];
            renderAdvances([]);
            $("advances-count").textContent = "snapshot changed · reloading";
            $("advances-more").hidden = true;
            setNote(
                "advances-note",
                "Advance urgency changed. Reloading the first page before reporting completeness.",
                true,
            );
            await loadAdvances(false);
            return;
        }
        throw error;
    }
    const current =
        generation === view.advanceGeneration &&
        state === view.advanceFilter &&
        state === $("state-filter").value &&
        (!append || expectedSnapshot === view.advanceSnapshot);
    if (!current) return;
    if (append) {
        const byId = new Map();
        for (const row of view.advances.concat(result.advances)) byId.set(row.id, row);
        view.advances = Array.from(byId.values());
    } else {
        view.advances = result.advances;
    }
    view.nextAdvanceOffset = result.nextOffset;
    view.advanceSnapshot = result.snapshotToken;
    renderAdvances(view.advances);
    $("advances-count").textContent =
        view.advances.length + " loaded · " + result.total + " in current snapshot";
    const more = $("advances-more");
    more.hidden = !result.hasMore;
    more.disabled = false;
    if (result.hiddenUrgentCount > 0) {
        setNote(
            "advances-note",
            "URGENT: " +
                result.hiddenUrgentCount +
                " expired/critical advance(s) remain on later current snapshot pages. Load more now; refresh restarts pagination.",
            true,
        );
    } else if (result.hasMore) {
        setNote(
            "advances-note",
            "More advances remain on later current snapshot pages. Refresh restarts pagination.",
            false,
        );
    } else {
        setNote("advances-note", "Current snapshot loaded. Refresh restarts pagination.", false);
    }
}

async function loadPolicy() {
    view.policy = await api("/admin/api/policy");
    fillPolicyForm(view.policy);
    if (view.status) renderExposure(view.status);
}

async function loadHistory() {
    renderHistory((await api("/admin/api/policy/history?limit=50")).history);
}

// Funding 503s while the wallet is down but the service is up, so its failure
// stays in this card instead of raising the console-unreachable alarm.
async function loadFunding() {
    try {
        renderFunding(await api("/admin/api/funding"));
    } catch (e) {
        $("funding-state").textContent = "unavailable: " + e.message;
    }
}

async function refresh() {
    try {
        await Promise.all([loadStatus(), loadAdvances(), loadFunding()]);
        view.offline = false;
    } catch (e) {
        view.offline = true;
        $("updated").textContent = "unreachable: " + e.message;
    }
    renderAlarm();
}

async function mutate(run, noteId) {
    try {
        await run();
        setNote(noteId, "request accepted", false);
        await Promise.all([loadPolicy(), loadHistory(), loadStatus()]);
        renderAlarm();
    } catch (e) {
        setNote(noteId, e.message, true);
    }
}

const postAction = (path) =>
    api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });

function wire() {
    const filter = $("state-filter");
    for (const s of STATES) {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        filter.append(opt);
    }

    filter.addEventListener("change", () => {
        loadAdvances(false).catch((e) => setNote("advances-note", e.message, true));
    });

    $("advances-more").addEventListener("click", async () => {
        const button = $("advances-more");
        const generation = view.advanceGeneration;
        button.disabled = true;
        try {
            await loadAdvances(true);
        } catch (e) {
            if (generation === view.advanceGeneration) setNote("advances-note", e.message, true);
        } finally {
            if (generation === view.advanceGeneration) button.disabled = false;
        }
    });

    $("refresh").addEventListener("click", refresh);
    $("revert").addEventListener("click", () => {
        if (view.policy) fillPolicyForm(view.policy);
        setNote("policy-note", "", false);
    });

    $("pause").addEventListener("click", () =>
        mutate(() => postAction("/admin/api/policy/pause"), "switch-note"),
    );
    $("resume").addEventListener("click", () =>
        mutate(() => postAction("/admin/api/policy/resume"), "switch-note"),
    );
    $("rescan").addEventListener("click", () =>
        mutate(() => postAction("/admin/api/rescan"), "switch-note"),
    );
    $("funding-copy").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("funding-address").textContent);
            $("funding-state").textContent = "address copied";
        } catch (e) {
            $("funding-state").textContent = "copy failed: select the address instead";
        }
    });

    $("policy-form").addEventListener("submit", (e) => {
        e.preventDefault();
        let rules;
        try {
            rules = JSON.parse($("assetRules").value);
        } catch (err) {
            setNote("policy-note", "Asset rules: " + err.message, true);
            return;
        }
        const patch = policyPatch(rules);
        if (Object.keys(patch).length === 0) {
            setNote("policy-note", "nothing changed", false);
            return;
        }
        mutate(
            () =>
                api("/admin/api/policy", {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(patch),
                }),
            "policy-note",
        );
    });

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refresh();
    });

    gateActions();
}

wire();
loadPolicy().catch((e) => setNote("policy-note", e.message, true));
loadHistory().catch(() => {});
refresh();
window.setInterval(refresh, POLL_MS);
