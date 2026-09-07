"use strict";

const STATES = [
    "quoted",
    "locking",
    "locked",
    "recycled",
    "purchased",
    "refunded",
    "recovered",
    "expired",
];

const SATS_FIELDS = ["feeFlatSats", "maxOutstandingSats", "maxPerPaymentTopupSats"];
const INT_FIELDS = ["feeBps", "maxConcurrentAdvances", "locktimeMarginBlocks", "quoteTtlSeconds"];

const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);

const view = { status: null, policy: null, offline: false };

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
    if (!res.ok) throw new Error((parsed && parsed.error) || res.status + " " + res.statusText);
    return parsed;
}

const actor = () => $("actor").value.trim();

function gateActions() {
    const missing = actor() === "";
    for (const id of ["apply", "pause", "resume"]) $(id).disabled = missing;
    $("switch-note").textContent = missing ? "Name an actor to change policy." : "";
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
    $("locked-count").textContent = String(status.exposure.lockedCount);
    $("oldest-locktime").textContent =
        status.exposure.oldestUnsweptLocktime === null
            ? "none locked"
            : group(status.exposure.oldestUnsweptLocktime);

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
        " · swept " +
        sweeper.sweptCount;

    const err = $("sweeper-error");
    err.hidden = !sweeper.lastError;
    err.textContent = sweeper.lastError || "";
}

function renderAdvances(rows) {
    const body = $("advances-body");
    body.textContent = "";
    const height =
        view.status && view.status.sweeper.lastHeight !== null
            ? BigInt(view.status.sweeper.lastHeight)
            : null;
    const now = Date.now();

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
            cell("td", group(a.feeSats), "n dim"),
            cell("td", group(a.locktime), due ? "n due" : "n"),
            cell("td", duration(now - a.createdAt), "n dim"),
        );

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

function fillPolicyForm(policy) {
    for (const f of SATS_FIELDS.concat(INT_FIELDS)) $(f).value = policy[f];
    $("allowAnyAsset").checked = policy.assetAllowlist === null;
    $("assetAllowlist").value =
        policy.assetAllowlist === null ? "" : policy.assetAllowlist.join(", ");
    $("assetAllowlist").disabled = policy.assetAllowlist === null;
    $("policy-loaded").textContent = "loaded " + new Date().toLocaleTimeString();
}

function renderServiceState(paused) {
    const pill = $("service-state");
    pill.textContent = paused ? "paused" : "quoting";
    pill.classList.toggle("pill--attention", paused);
    $("pause").disabled = actor() === "";
    $("resume").disabled = actor() === "";
}

function policyPatch() {
    const patch = {};
    for (const f of SATS_FIELDS) {
        const v = $(f).value.trim();
        if (v !== view.policy[f]) patch[f] = v;
    }
    for (const f of INT_FIELDS) {
        const v = Number($(f).value);
        if (v !== view.policy[f]) patch[f] = v;
    }
    const allow = $("allowAnyAsset").checked
        ? null
        : $("assetAllowlist")
              .value.split(",")
              .map((s) => s.trim())
              .filter((s) => s !== "");
    if (JSON.stringify(allow) !== JSON.stringify(view.policy.assetAllowlist)) {
        patch.assetAllowlist = allow;
    }
    return patch;
}

async function loadStatus() {
    const status = await api("/admin/api/status");
    view.status = status;
    renderExposure(status);
    renderStates(status.counts);
    renderSweeper(status.sweeper);
    renderServiceState(status.paused);
    $("updated").textContent = "updated " + new Date().toLocaleTimeString();
}

async function loadAdvances() {
    const state = $("state-filter").value;
    const result = await api("/admin/api/advances" + (state ? "?state=" + state : ""));
    renderAdvances(result.advances);
    $("advances-count").textContent = result.advances.length + " of " + result.total;
}

async function loadPolicy() {
    view.policy = await api("/admin/api/policy");
    fillPolicyForm(view.policy);
    if (view.status) renderExposure(view.status);
}

async function loadHistory() {
    renderHistory((await api("/admin/api/policy/history?limit=50")).history);
}

async function refresh() {
    try {
        await Promise.all([loadStatus(), loadAdvances()]);
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
        setNote(noteId, "applied by " + actor(), false);
        await Promise.all([loadPolicy(), loadHistory(), loadStatus()]);
        renderAlarm();
    } catch (e) {
        setNote(noteId, e.message, true);
    }
}

const postActor = (path) =>
    api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: actor() }),
    });

function wire() {
    const filter = $("state-filter");
    for (const s of STATES) {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        filter.append(opt);
    }

    const saved = window.localStorage.getItem("arkade-taxi.actor");
    if (saved) $("actor").value = saved;

    $("actor").addEventListener("input", () => {
        window.localStorage.setItem("arkade-taxi.actor", $("actor").value);
        gateActions();
    });

    $("allowAnyAsset").addEventListener("change", (e) => {
        $("assetAllowlist").disabled = e.target.checked;
    });

    filter.addEventListener("change", () => {
        loadAdvances().catch((e) => setNote("policy-note", e.message, true));
    });

    $("refresh").addEventListener("click", refresh);
    $("revert").addEventListener("click", () => {
        if (view.policy) fillPolicyForm(view.policy);
        setNote("policy-note", "", false);
    });

    $("pause").addEventListener("click", () =>
        mutate(() => postActor("/admin/api/pause"), "switch-note"),
    );
    $("resume").addEventListener("click", () =>
        mutate(() => postActor("/admin/api/resume"), "switch-note"),
    );

    $("policy-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const patch = policyPatch();
        if (Object.keys(patch).length === 0) {
            setNote("policy-note", "nothing changed", false);
            return;
        }
        patch.actor = actor();
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
