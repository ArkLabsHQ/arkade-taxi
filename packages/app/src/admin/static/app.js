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

const CLAIMS = [
    ["recycle", "Get my sats back"],
    ["purchase", "Sell outright"],
    ["either", "Payer chooses"],
];

const ATTENTION = " Check it under Advances.";
const PROCEEDS_STUCK =
    "Collecting the fares and repayments the Taxi received is stuck; the code beside this names the cause.";

// Readiness blockers by meaning, one sentence each. A code missing here is shown raw.
const BLOCKER_GROUPS = [
    ["The Taxi is paused, so it refuses every new payment.", "manual_pause"],
    ["The Taxi's spendable balance is below the reserve it must keep.", "operator_reserve_low"],
    ["The Taxi is shutting down.", "shutdown_in_progress"],
    ["The Taxi has stopped.", "runtime_stopped"],
    ["The Taxi has not checked its wallet and the Arkade server yet.", "runtime_unchecked"],
    ["The Taxi is checking its wallet and the Arkade server.", "runtime_checking"],
    [
        "The Taxi's last check of its wallet and the Arkade server failed; it tries again shortly.",
        "runtime_check_failed",
    ],
    [
        "The Taxi's last check of its wallet and the Arkade server is out of date; it checks again shortly.",
        "runtime_stale",
    ],
    ["The Taxi cannot reach the Arkade server.", "server_unavailable"],
    ["The Arkade server's key changed since the Taxi started.", "server_identity_mismatch"],
    ["The Arkade server reports a network the Taxi does not know.", "network_unknown"],
    ["The Arkade server's network changed since the Taxi started.", "network_mismatch"],
    ["The Taxi knows no emulator key for this network.", "emulator_key_unavailable"],
    ["The Taxi cannot reach the emulator.", "emulator_unavailable"],
    [
        "The emulator's key does not match the one this network expects.",
        "emulator_identity_mismatch",
    ],
    ["The Arkade server's dust amount changed since the Taxi started.", "dust_mismatch"],
    [
        "The Arkade server's minimum coin amount changed since the Taxi started.",
        "vtxo_min_amount_mismatch",
    ],
    [
        "The Arkade server reports amount limits the Taxi cannot work with.",
        "provider_limits_invalid",
    ],
    ["The Arkade server's exit script failed the Taxi's safety check.", "server_unroll_invalid"],
    [
        "The Arkade server changed while the Taxi was settling; it waits for the settlement to finish.",
        "operator_settlement_provider_changed",
    ],
    [
        "The wallet's address does not match the Taxi's configured operator key.",
        "operator_payout_mismatch",
    ],
    ["The Taxi cannot read the latest block from its chain explorer.", "chain_tip_unavailable"],
    ["The Taxi does not know the current block height.", "chain_height_unavailable"],
    ["The Taxi does not know the current chain time.", "chain_time_unavailable"],
    ["The Taxi's wallet is still syncing with the Arkade server.", "wallet_unsynced"],
    ["The Taxi could not open or read its wallet.", "wallet_unavailable"],
    [
        "The Taxi cannot tell which of its coins are already in use.",
        "intent_locks_unavailable reservation_locks_unavailable",
    ],
    ["The wallet reported a coin with an impossible amount.", "wallet_value_invalid"],
    ["The wallet holds a coin whose expiry the Taxi cannot read.", "vtxo_expiry_unknown"],
    ["Some of the Taxi's coins expire too soon to lend.", "vtxo_expiry_headroom"],
    [
        "This network's coins live no longer than TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS, so every coin is renewed as it arrives and none can be lent. Lower TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS below the network's VTXO lifetime.",
        "renewal_threshold_exceeds_vtxo_lifetime",
    ],
    [
        "The Taxi has not finished its first check of payments in progress.",
        "reconciler_not_started",
    ],
    [
        "The Taxi has not finished its first check of swap fills in progress.",
        "swap_fill_reconciler_not_started",
    ],
    ["The recovery sweeper has not run yet.", "sweeper_not_started"],
    [
        "The recovery sweeper has stopped running on time. Lent sats are recovered only while it runs.",
        "sweeper_stale",
    ],
    [
        "A safety check reported a problem without a name.",
        "startup_blocked runtime_blocked recovery_blocked reconciler_blocked proceeds_blocked",
    ],
    [
        "Startup failed while starting background checks. Check again to retry.",
        "startup_background_failed",
    ],
    [
        "A payment tried to use coins that were already reserved." + ATTENTION,
        "reserved_input_conflict",
    ],
    [
        "A payment's lockup failed a safety check, so the Taxi stopped sending it." + ATTENTION,
        "lockup_submission_invalid_prepared_artifact lockup_submission_invalid_pending_proof " +
            "lockup_submission_invalid_provider_response lockup_submission_invalid_persisted_artifact " +
            "lockup_submission_invalid_persisted_envelope",
    ],
    [
        "The Taxi could not release the coins it held for a finished payment.",
        "sponsored_release_failed",
    ],
    [
        "The Taxi cannot read the chain tip to watch payments, so it paused itself.",
        "canonical_tip_unavailable",
    ],
    [
        "The live feed of Arkade transactions dropped; the Taxi keeps checking by polling.",
        "transaction_stream_disconnected",
    ],
    [
        "A payment's coin was spent in a way the Taxi does not recognise." + ATTENTION,
        "covenant_spend_unknown",
    ],
    [
        "The Taxi saw conflicting chain data about a payment." + ATTENTION,
        "covenant_observation_disagreement",
    ],
    ["Coins held for a swap fill were spent unexpectedly.", "swap_fill_unexpected_spend"],
    ["A swap fill failed and what is owed is not settled yet.", "joint_fill_liability_unresolved"],
    [
        "A payment expired before the Taxi recovered its lent sats, which may be lost. Escalate to your Arkade provider.",
        "covenant_unspent_at_expiry",
    ],
    [
        "A payment's recovery deadline is very close, so the Taxi paused new payments.",
        "recovery_deadline_critical",
    ],
    ["A payment's recovery deadline is getting close.", "recovery_deadline_warning"],
    ["A payment's lent sats can now be recovered.", "recovery_eligible"],
    [
        "A payment's recovery time is invalid, so the Taxi cannot recover its sats on its own.",
        "recovery_locktime_invalid",
    ],
    [
        "Recovering a payment's lent sats failed a safety check." + ATTENTION,
        "recovery_quarantined recovery_artifact_invalid",
    ],
    [
        "The emulator did not confirm a recovery; the Taxi retries it.",
        "recovery_submission_ambiguous",
    ],
    [
        "The Taxi is collecting the fares and repayments it received; new payments wait until it finishes.",
        "proceeds_collecting proceeds_output_pending proceeds_intent_pending proceeds_worker_active",
    ],
    [
        "Collecting the Taxi's earnings needs more balance above the reserve. Send it more sats.",
        "proceeds_reserve_unavailable",
    ],
    [
        "Collecting the Taxi's earnings costs a fee above TAXI_PROCEEDS_MAX_FEE_SATS.",
        "proceeds_fee_cap_exceeded",
    ],
    [
        PROCEEDS_STUCK,
        "proceeds_submission_not_authorized proceeds_wallet_unavailable proceeds_output_limit_invalid " +
            "proceeds_asset_invalid proceeds_plan_invalid proceeds_fee_invalid proceeds_ownership_invalid " +
            "proceeds_duplicate_inventory proceeds_input_reserved proceeds_output_limit_exceeded " +
            "proceeds_fee_authorization_changed proceeds_input_conflict proceeds_submission_ambiguous " +
            "proceeds_ambiguous_intent proceeds_receipt_missing proceeds_receipt_mismatch " +
            "proceeds_payout_key_changed proceeds_lockup_mismatch proceeds_covenant_missing " +
            "proceeds_spend_mismatch proceeds_inputs_missing proceeds_input_facts_changed " +
            "proceeds_stopped proceeds_provider_unsafe proceeds_chain_tip_invalid " +
            "proceeds_input_unavailable proceeds_collection_failed proceeds_storage_unavailable " +
            "proceeds_lease_lost proceeds_submission_evidence_missing proceeds_intent_unbound " +
            "proceeds_reservation_changed",
    ],
];

const BLOCKERS = new Map(
    BLOCKER_GROUPS.flatMap(([text, codes]) => codes.split(" ").map((code) => [code, text])),
);

// Startup blockers are built as startup_<phase>[_pending|_failed].
const PHASES = new Map([
    ["local", "starting"],
    ["listening", "starting its checks"],
    ["provider", "checking its wallet and the Arkade server"],
    ["reconciliation", "catching up on payments in progress"],
    ["recovery", "checking for lent sats that are due back"],
    ["streams", "subscribing to live Arkade updates"],
    ["background", "starting background checks"],
    ["ready", "finishing startup"],
    ["stopping", "shutting down"],
    ["stopped", "stopping"],
]);

function blockerText(code) {
    if (BLOCKERS.has(code)) return BLOCKERS.get(code);
    const startup = /^startup_([a-z]+?)(_pending|_failed)?$/.exec(code);
    if (startup && PHASES.has(startup[1]))
        return startup[2] === "_failed"
            ? "Startup failed while " + PHASES.get(startup[1]) + "; the Taxi keeps retrying."
            : "Starting up: " + PHASES.get(startup[1]) + ".";
    if (/^lockup_submission_[a-z]+_ambiguous$/.test(code))
        return "The Arkade server did not confirm a payment's lockup." + ATTENTION;
    return code;
}

const STEP_NAMES = {
    connected: "get the Taxi running and connected",
    fund: "fund your Taxi",
    limits: "set your limits",
    carry: "choose what to carry",
};

const ASSET_ID_HELP =
    "Paste the asset id your wallet shows: 68 characters of 0-9 and a-f. The txid:group form also works.";

const $ = (id) => document.getElementById(id);

const view = {
    status: null,
    policy: null,
    funding: null,
    rules: [],
    done: {},
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
        error.status = res.status;
        error.blockers = parsed && parsed.blockers;
        throw error;
    }
    return parsed;
}

const FIELD_LABELS = {
    maxOutstandingSats: "Max outstanding",
    maxPerPaymentTopupSats: "Max per payment",
    maxConcurrentAdvances: "Max payments at once",
    locktimeMarginBlocks: "Locktime margin (blocks)",
    locktimeMarginSeconds: "Locktime margin (seconds)",
    quoteTtlSeconds: "Quote lifetime",
    units: "amount",
    bps: "percentage",
    minUnits: "minimum",
    maxUnits: "maximum",
    maxTopupSats: "max per payment",
    claim: "claim mode",
    groupIndex: "group",
};

// The router's validation messages, as predicates of the field they name.
const ISSUE_RULES = [
    [/decimal sats amount/, () => "must be a whole number of sats"],
    [/Expected (number|integer)/, () => "must be a whole number"],
    [/greater than or equal to ([0-9]+)/, (m) => "must be at least " + m[1]],
    [/less than or equal to ([0-9]+)/, (m) => "must be at most " + m[1]],
    [/Invalid enum value/, () => "is not one of the choices"],
    [
        /^Invalid( input)?$/,
        (m, path) =>
            /(units|Units|TopupSats)$/.test(path) ? "must be a whole number" : "is not valid",
    ],
    [/bps must be within/, () => "has a percentage outside 0 to 100"],
    [/maxUnits must not be below minUnits/, () => "has a maximum below its minimum"],
    [/token fare must be flat/, () => "is in a fixed token, so it must be flat"],
    [/non-empty id/, () => "needs an id"],
    [/Unrecognized key/, () => "has a field the Taxi does not know"],
];

function fieldLabel(path) {
    const parts = path.split(".");
    if (parts[0] !== "assetRules" || parts.length < 2) return FIELD_LABELS[path] || path;
    const label = ["Rule " + (Number(parts[1]) + 1)];
    const fare = parts[2] === "fares" && parts.length > 3;
    if (fare) label.push("fare " + (Number(parts[3]) + 1));
    const last = parts[parts.length - 1];
    if (parts.length > (fare ? 4 : 2)) label.push(FIELD_LABELS[last] || last);
    return label.join(", ");
}

function issueText(issue) {
    const m = /^([A-Za-z0-9_.]+): (.+)$/.exec(issue);
    if (!m) return issue;
    for (const [pattern, say] of ISSUE_RULES) {
        const hit = pattern.exec(m[2]);
        if (hit) return fieldLabel(m[1]) + " " + say(hit, m[1]) + ".";
    }
    return fieldLabel(m[1]) + ": " + m[2] + ".";
}

function explain(error) {
    const raw = (error.code ? error.code + ": " : "") + error.message;
    let text = error.message;
    if (error.code === "resume_blocked")
        text =
            "The Taxi cannot go live yet. " +
            (error.blockers || [error.message]).map(blockerText).join(" ");
    else if (error.code === "funding_unavailable")
        text = "The Taxi cannot read its wallet right now.";
    else if (/^header x-taxi-operator/.test(error.message))
        text =
            "The console could not tell who you are: the proxy in front of it must send the operator header.";
    else if (/recovery execution budget/.test(error.message))
        text =
            "Each locktime margin must be larger than the Taxi's recovery budget, set by TAXI_RECOVERY_BROADCAST_BLOCKS and TAXI_RECOVERY_BROADCAST_SECONDS.";
    else if (error.status === 400) text = error.message.split("; ").map(issueText).join(" ");
    return { text, raw };
}

function showError(id, error) {
    const { text, raw } = explain(error);
    setNote(id, text, true, raw);
}

function gateActions() {
    for (const id of ["apply", "pause", "resume", "rescan"]) $(id).disabled = false;
}

function setNote(id, text, isError, raw) {
    const el = $(id);
    el.textContent = text;
    el.classList.toggle("is-error", Boolean(isError));
    if (raw && raw !== text) {
        const details = document.createElement("details");
        details.append(cell("summary", "details"), cell("code", raw));
        el.append(details);
    }
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
}

function step(id, done, detail) {
    view.done[id] = done;
    $("step-" + id).classList.toggle("is-done", done);
    $("step-" + id + "-state").textContent = done ? "Done" : "To do";
    $("step-" + id + "-fix").hidden = done;
    if (detail !== undefined) $("step-" + id + "-detail").textContent = detail;
}

const SEND_TO = "offchain to its Arkade address, or on-chain to its boarding address.";

function fundText(usable, reserve, funded) {
    if (usable === undefined) return "Its balance is unknown until it can read its wallet.";
    if (!reserve)
        return funded
            ? group(usable) + " sats usable."
            : blockerText("operator_reserve_low") + " Send it sats " + SEND_TO;
    const spare = BigInt(usable) - BigInt(reserve);
    return funded
        ? group(usable) +
              " sats usable: the " +
              group(spare.toString()) +
              " above its " +
              group(reserve) +
              " sats reserve can be lent."
        : group(usable) +
              " sats usable, below the " +
              group(reserve) +
              " sats it must keep in reserve. Send it at least " +
              group((-spare).toString()) +
              " sats more: " +
              SEND_TO;
}

function renderSetup() {
    const status = view.status;
    const policy = view.policy;
    if (!status || !policy) return;
    const blockers = status.readiness.blockers;
    const runtime = status.readiness.runtime || {};
    const others = view.offline
        ? []
        : blockers.filter((code) => code !== "manual_pause" && code !== "operator_reserve_low");

    step("connected", !view.offline && others.length === 0);
    const network = (runtime.provider || {}).network;
    $("step-connected-title").textContent =
        "Taxi is running and connected" + (network ? " (" + network + ")" : "");
    const list = $("step-connected-detail");
    list.textContent = "";
    if (view.offline) list.append(cell("li", "The console cannot reach the Taxi."));
    for (const code of others) {
        const item = cell("li", blockerText(code));
        item.append(cell("code", code));
        list.append(item);
    }

    const usable = (runtime.inventory || {}).usableSats;
    const reserve = view.funding && view.funding.minReserveSats;
    const funded =
        usable !== undefined &&
        (reserve ? BigInt(usable) >= BigInt(reserve) : !blockers.includes("operator_reserve_low"));
    step("fund", funded, fundText(usable, reserve, funded));

    const limited =
        policy.maxPerPaymentTopupSats !== "0" &&
        policy.maxOutstandingSats !== "0" &&
        policy.maxConcurrentAdvances !== 0;
    step(
        "limits",
        limited,
        limited
            ? "Up to " +
                  group(policy.maxPerPaymentTopupSats) +
                  " sats per payment, " +
                  group(policy.maxOutstandingSats) +
                  " sats in total, " +
                  group(String(policy.maxConcurrentAdvances)) +
                  " payments at once."
            : "It lends nothing while any of the three limits is 0.",
    );

    const on = policy.assetRules.filter((rule) => rule.enabled);
    step(
        "carry",
        on.length > 0,
        on.length
            ? "It carries " + carriedText(on) + "."
            : "It carries nothing until at least one rule is switched on.",
    );

    const ready = Object.keys(STEP_NAMES).every((id) => view.done[id]);
    step(
        "live",
        !status.paused,
        status.paused
            ? blockerText("manual_pause")
            : ready
              ? "It is taking payments."
              : "It is live, but refuses payments until the steps above are done.",
    );
    if (!status.paused) $("go-live-confirm").hidden = true;
}

function goLive() {
    $("go-live-confirm").hidden = true;
    mutate(() => postAction("/admin/api/policy/resume"), "setup-note");
}

function carriedText(rules) {
    const assets = rules.filter((rule) => rule.assetId !== null).length;
    return [
        ...(rules.length > assets ? ["small bitcoin payments"] : []),
        ...(assets ? [assets + (assets === 1 ? " asset" : " assets")] : []),
    ].join(" and ");
}

const wizard = { step: 1, size: "small", fare: "free", claim: "recycle" };

const WIZARD_CHOICES = {
    size: ["small", "medium", "custom"],
    fare: ["free", "flat", "percent"],
    claim: ["recycle", "purchase", "either"],
};

// Per payment is always the dust: the most any one payment can need.
const PRESETS = { small: [100n, 100], medium: [1000n, 1000] };

const WHOLE = /^(0|[1-9][0-9]*)$/;
const PERCENT = /^[0-9]+(\.[0-9]{1,2})?$/;

const CLAIM_SUMMARY = {
    recycle: "When a receiver claims, they repay the lent sats, so your Taxi gets them back.",
    purchase: "When a receiver claims, they keep the lent sats; the fare is all your Taxi earns.",
    either: "Each payer chooses whether the receiver repays the lent sats; without a choice, they do.",
};

const assetLines = () =>
    $("wiz-assets")
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

function openWizard() {
    if (!view.status)
        return setNote("setup-note", "The console has not reached the Taxi yet.", true);
    Object.assign(wizard, { step: 1, size: "small", fare: "free", claim: "recycle" });
    $("wiz-btc").checked = true;
    $("wiz-fare-asset").checked = false;
    for (const id of [
        "wiz-assets",
        "wiz-per-payment",
        "wiz-outstanding",
        "wiz-concurrent",
        "wiz-fare-flat-sats",
        "wiz-fare-pct",
        "wiz-fare-min",
        "wiz-fare-max",
    ])
        $(id).value = "";
    const dust = BigInt(view.status.dust);
    $("wiz-dust").textContent = group(view.status.dust);
    for (const [size, [total, count]] of Object.entries(PRESETS))
        $("wiz-size-" + size + "-text").textContent =
            group(dust.toString()) +
            " sats per payment · " +
            group((dust * total).toString()) +
            " sats in total · " +
            group(String(count)) +
            " payments at once";
    renderWizard();
    $("wizard").showModal();
    $("wiz-h1").focus();
}

function renderWizard() {
    for (let n = 1; n <= 4; n++) $("wiz-step-" + n).hidden = n !== wizard.step;
    $("wizard-progress").textContent = "Step " + wizard.step + " of 4";
    $("wiz-back").hidden = wizard.step === 1;
    $("wiz-next").hidden = wizard.step === 4;
    const live = Boolean(view.status && !view.status.paused);
    $("wiz-save").hidden = wizard.step !== 4;
    $("wiz-save-live").hidden = wizard.step !== 4 || live;
    $("wiz-save-hint").textContent = live
        ? "Save keeps your Taxi live."
        : "Save keeps your Taxi paused. Save & go live also starts it: it takes payments as soon as every step of the checklist is done.";
    for (const [name, values] of Object.entries(WIZARD_CHOICES))
        for (const value of values) $("wiz-" + name + "-" + value).checked = wizard[name] === value;
    $("wiz-custom").hidden = wizard.size !== "custom";
    $("wiz-fare-flat-fields").hidden = wizard.fare !== "flat";
    $("wiz-fare-percent-fields").hidden = wizard.fare !== "percent";
    $("wiz-fare-asset-row").hidden = wizard.fare === "free" || assetLines().length === 0;
    $("wiz-fare-btc-warn").hidden = wizard.fare === "free" || !$("wiz-btc").checked;
    const giveaway = wizard.fare === "free" && wizard.claim !== "recycle";
    $("wiz-claim-warn").hidden = !giveaway;
    $("wiz-claim-warn").textContent =
        wizard.claim === "purchase"
            ? "With no fare, selling outright gives the lent sats away on every payment."
            : "With no fare, a payer who chooses to sell outright gets the lent sats for nothing.";
    setNote("wiz-note", "", false);
}

function wizardProblem() {
    if (wizard.step === 1) {
        const lines = assetLines();
        const bad = lines.find((line) => !parseAssetId(line));
        if (bad) return '"' + bad + '" is not an asset id. ' + ASSET_ID_HELP;
        if (new Set(lines.map((line) => assetKey(parseAssetId(line)))).size < lines.length)
            return "An asset is listed twice.";
        if (!$("wiz-btc").checked && lines.length === 0)
            return "Choose small bitcoin payments, at least one asset, or both.";
    }
    if (wizard.step === 2 && wizard.size === "custom") {
        const limits = ["wiz-per-payment", "wiz-outstanding", "wiz-concurrent"];
        if (!limits.every((id) => WHOLE.test($(id).value.trim()) && $(id).value.trim() !== "0"))
            return "Each limit is a whole number above 0.";
    }
    if (wizard.step === 3 && wizard.fare === "flat") {
        if (!WHOLE.test($("wiz-fare-flat-sats").value.trim()))
            return "The flat fare is a whole number of sats.";
    }
    if (wizard.step === 3 && wizard.fare === "percent") {
        const pct = $("wiz-fare-pct").value.trim();
        const min = $("wiz-fare-min").value.trim() || "0";
        const max = $("wiz-fare-max").value.trim();
        if (!PERCENT.test(pct) || Number(pct) > 100)
            return "The percentage is a number from 0 to 100, at most two decimals.";
        if (!WHOLE.test(min) || (max && (!WHOLE.test(max) || BigInt(max) < BigInt(min))))
            return "The minimum and maximum are whole numbers of sats, the maximum not below the minimum.";
    }
    return null;
}

function wizardFares(isAsset) {
    const pricing =
        wizard.fare === "free"
            ? { kind: "flat", units: "0" }
            : wizard.fare === "flat"
              ? { kind: "flat", units: $("wiz-fare-flat-sats").value.trim() }
              : {
                    kind: "proportional",
                    bps: Math.round(Number($("wiz-fare-pct").value.trim()) * 100),
                    minUnits: $("wiz-fare-min").value.trim() || "0",
                    maxUnits: $("wiz-fare-max").value.trim() || null,
                };
    const fares = [{ id: "sats", currency: { kind: "sats" }, pricing }];
    if (isAsset && wizard.fare !== "free" && $("wiz-fare-asset").checked)
        fares.push({ id: "asset", currency: { kind: "sameAsset" }, pricing });
    return fares;
}

function wizardPatch() {
    const dust = BigInt(view.status.dust);
    const custom = wizard.size === "custom";
    const [total, count] = custom ? [] : PRESETS[wizard.size];
    const rule = (assetId) => ({
        assetId,
        enabled: true,
        fares: wizardFares(assetId !== null),
        claim: wizard.claim,
        maxTopupSats: null,
    });
    return {
        maxPerPaymentTopupSats: custom ? $("wiz-per-payment").value.trim() : dust.toString(),
        maxOutstandingSats: custom ? $("wiz-outstanding").value.trim() : (dust * total).toString(),
        maxConcurrentAdvances: custom ? Number($("wiz-concurrent").value.trim()) : count,
        assetRules: [
            ...($("wiz-btc").checked ? [rule(null)] : []),
            ...assetLines().map((line) => rule(parseAssetId(line))),
        ],
    };
}

function wizardSummary(patch) {
    const pricing = patch.assetRules[0].fares[0].pricing;
    const fare =
        wizard.fare === "free"
            ? "Payers pay no fare."
            : wizard.fare === "flat"
              ? "Each payment pays a fare of " + group(pricing.units) + " sats."
              : "Each payment pays " +
                pricing.bps / 100 +
                "% of the sats lent, at least " +
                group(pricing.minUnits) +
                " sats" +
                (pricing.maxUnits === null
                    ? ""
                    : " and at most " + group(pricing.maxUnits) + " sats") +
                ".";
    return [
        "Your Taxi will carry " + carriedText(patch.assetRules) + ".",
        "It lends up to " +
            group(patch.maxPerPaymentTopupSats) +
            " sats per payment and " +
            group(patch.maxOutstandingSats) +
            " sats in total, to at most " +
            group(String(patch.maxConcurrentAdvances)) +
            " payments at once.",
        fare,
        ...(patch.assetRules.some((rule) => rule.fares.length > 1)
            ? ["Asset payments may pay it in the asset they send instead."]
            : []),
        CLAIM_SUMMARY[wizard.claim],
        ...(view.policy && view.policy.assetRules.length
            ? ["This replaces the rules your Taxi has now."]
            : []),
    ].join(" ");
}

function wizardMove(by) {
    if (by > 0) {
        const problem = wizardProblem();
        if (problem) return setNote("wiz-note", problem, true);
    }
    wizard.step += by;
    if (wizard.step === 4) $("wiz-summary").textContent = wizardSummary(wizardPatch());
    renderWizard();
    $("wiz-h" + wizard.step).focus();
}

async function saveWizard(goLive) {
    const patch = wizardPatch();
    if (goLive) patch.paused = false;
    const wasLive = Boolean(view.status && !view.status.paused);
    try {
        await patchPolicy(patch);
        $("wizard").close();
        setNote(
            "setup-note",
            goLive
                ? "Saved, and your Taxi is live."
                : wasLive
                  ? "Saved. Your Taxi is still live."
                  : "Saved. Your Taxi stays paused until you go live.",
            false,
        );
        await Promise.all([loadPolicy(), loadHistory(), loadStatus()]);
        renderAlarm();
    } catch (e) {
        showError($("wizard").open ? "wiz-note" : "setup-note", e);
    }
}

const firstRun = (policy) =>
    policy.assetRules.length === 0 &&
    policy.maxOutstandingSats === "0" &&
    policy.maxPerPaymentTopupSats === "0" &&
    policy.maxConcurrentAdvances === 0;

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
        id.append(cell("span", assetLabel(a.assetId)));
        id.title = walletAssetId(a.assetId);
        tr.append(
            id,
            cell("td", String(a.assetId.groupIndex), "n"),
            cell("td", group(a.amount), "n"),
        );
        body.append(tr);
    }
    $("funding-assets-empty").hidden = funding.assets.length > 0;
    const boarding = funding.boarding;
    $("funding-boarding-address").textContent =
        boarding.address === null ? "unavailable" : boarding.address;
    $("funding-boarding-copy").disabled = boarding.address === null;
    $("funding-boarding-confirmed").textContent = sats(boarding.confirmedSats);
    $("funding-boarding-unconfirmed").textContent = sats(boarding.unconfirmedSats);
    $("funding-boarding-expired").textContent = sats(boarding.expiredSats);
    $("funding-loaded").textContent = "loaded " + new Date().toLocaleTimeString();
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
    view.rules = JSON.parse(JSON.stringify(editableRules(policy.assetRules)));
    editRules(() => {}, true);
    $("policy-loaded").textContent = "loaded " + new Date().toLocaleTimeString();
}

const assetKey = (id) => id.txid + ":" + id.groupIndex;
const reverseBytes = (hex) => hex.match(/../g).reverse().join("");
const byteHex = (n) => n.toString(16).padStart(2, "0");

// The wallet's id is the txid bytes then the group as uint16 little-endian; the
// Taxi keeps those txid bytes reversed, as swapIdToTaxiAssetId does.
const walletAssetId = (id) =>
    reverseBytes(id.txid) + byteHex(id.groupIndex & 255) + byteHex(id.groupIndex >> 8);

const assetLabel = (id) =>
    id === null ? "Bitcoin" : walletAssetId(id).slice(0, 8) + "…" + walletAssetId(id).slice(-8);

function parseAssetId(text) {
    const s = text.trim().toLowerCase();
    if (/^[0-9a-f]{68}$/.test(s))
        return {
            txid: reverseBytes(s.slice(0, 64)),
            groupIndex: parseInt(s.slice(66, 68) + s.slice(64, 66), 16),
        };
    const m = /^([0-9a-f]{64}):([0-9]{1,5})$/.exec(s);
    return m && Number(m[2]) <= 65535 ? { txid: m[1], groupIndex: Number(m[2]) } : null;
}

function newFare(fares, kind = "sats") {
    const base = kind === "sats" ? "sats" : "asset";
    let id = base;
    for (let n = 2; fares.some((f) => f.id === id); n++) id = base + "-" + n;
    return { id, currency: { kind }, pricing: { kind: "flat", units: "0" } };
}

const newRule = (assetId) => ({
    assetId,
    enabled: true,
    fares: [newFare([])],
    claim: "recycle",
    maxTopupSats: null,
});

// The JSON view is the serialised form of view.rules; the table re-renders only
// when the shape changed, so typing in a cell keeps its focus.
function editRules(change, rerender) {
    change();
    $("assetRules").value = JSON.stringify(view.rules, null, 2);
    if (rerender) renderRules();
}

function control(tag, name, label) {
    const el = document.createElement(tag);
    el.name = name;
    if (tag === "button") el.type = "button";
    if (label) el.ariaLabel = label;
    return el;
}

function choice(name, options, value, label) {
    const select = control("select", name, label);
    for (const [key, text] of options) {
        const option = cell("option", text);
        option.value = key;
        select.append(option);
    }
    select.value = value;
    return select;
}

function amountInput(name, value, label, set) {
    const input = control("input", name, label);
    input.type = "text";
    input.inputMode = "numeric";
    input.value = value === null ? "" : value;
    input.addEventListener("change", () => editRules(() => set(input.value.trim())));
    return input;
}

function percentInput(pricing) {
    const input = control("input", "percent", "Fare percentage");
    input.type = "text";
    input.inputMode = "decimal";
    input.value = String(pricing.bps / 100);
    input.addEventListener("change", () => {
        const text = input.value.trim();
        if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(text) || Number(text) > 100) {
            input.value = String(pricing.bps / 100);
            setNote(
                "policy-note",
                "A percentage is a number from 0 to 100, at most two decimals.",
                true,
            );
            return;
        }
        editRules(() => (pricing.bps = Math.round(Number(text) * 100)));
    });
    return input;
}

const wrap = (el) => {
    const td = document.createElement("td");
    td.append(el);
    return td;
};

function fareEditor(rule, fare) {
    const line = cell("div", "", "fare");
    const remove = control("button", "remove-fare", "Remove fare " + fare.id);
    remove.textContent = "Remove";
    remove.addEventListener("click", () =>
        editRules(() => rule.fares.splice(rule.fares.indexOf(fare), 1), true),
    );
    if (fare.currency.kind === "token") {
        line.append(cell("span", "in a fixed token: edit as JSON", "dim"), remove);
        return line;
    }
    const unit = fare.currency.kind === "sats" ? "sats" : "units";
    if (rule.assetId === null) line.append(cell("span", "in sats", "dim"));
    else {
        const currency = choice(
            "currency",
            [
                ["sats", "in sats"],
                ["sameAsset", "in this asset"],
            ],
            fare.currency.kind,
            "Fare currency",
        );
        currency.addEventListener("change", () =>
            editRules(() => (fare.currency = { kind: currency.value }), true),
        );
        line.append(currency);
    }
    const pricing = choice(
        "pricing",
        [
            ["flat", "flat"],
            ["proportional", "percent"],
        ],
        fare.pricing.kind,
        "Fare pricing",
    );
    pricing.addEventListener("change", () =>
        editRules(
            () =>
                (fare.pricing =
                    pricing.value === "flat"
                        ? { kind: "flat", units: "0" }
                        : { kind: "proportional", bps: 0, minUnits: "0", maxUnits: null }),
            true,
        ),
    );
    line.append(pricing);
    const p = fare.pricing;
    if (p.kind === "flat")
        line.append(
            amountInput("units", p.units, "Fare in " + unit, (v) => (p.units = v)),
            cell("span", unit, "dim"),
        );
    else
        line.append(
            percentInput(p),
            cell("span", "%, min", "dim"),
            amountInput("min", p.minUnits, "Minimum fare in " + unit, (v) => (p.minUnits = v)),
            cell("span", "max", "dim"),
            amountInput(
                "max",
                p.maxUnits,
                "Maximum fare in " + unit + ", blank for none",
                (v) => (p.maxUnits = v === "" ? null : v),
            ),
            cell("span", unit, "dim"),
        );
    line.append(remove);
    return line;
}

function renderRules() {
    const body = $("rules-body");
    body.textContent = "";
    view.rules.forEach((rule, index) => {
        const label = assetLabel(rule.assetId);
        const asset = cell("th", label);
        asset.scope = "row";
        if (rule.assetId) asset.title = walletAssetId(rule.assetId);

        const on = control("input", "enabled", "Carry " + label);
        on.type = "checkbox";
        on.checked = rule.enabled;
        on.addEventListener("change", () => editRules(() => (rule.enabled = on.checked)));

        const fares = document.createElement("td");
        for (const fare of rule.fares) fares.append(fareEditor(rule, fare));
        if (rule.fares.length === 0)
            fares.append(cell("p", "No fare: these payments are refused.", "warn"));
        const add = control("button", "add-fare", "Add a fare for " + label);
        add.textContent = "Add fare";
        add.addEventListener("click", () =>
            editRules(() => rule.fares.push(newFare(rule.fares)), true),
        );
        fares.append(add);

        const claim = choice("claim", CLAIMS, rule.claim, "When the receiver claims " + label);
        claim.addEventListener("change", () => editRules(() => (rule.claim = claim.value)));

        const cap = amountInput(
            "maxTopupSats",
            rule.maxTopupSats,
            "Max per payment for " + label + ", blank for the global limit",
            (v) => (rule.maxTopupSats = v === "" ? null : v),
        );
        cap.placeholder = "global";

        const remove = control("button", "remove-rule", "Remove " + label);
        remove.textContent = "Remove";
        remove.addEventListener("click", () => editRules(() => view.rules.splice(index, 1), true));

        const tr = document.createElement("tr");
        tr.append(asset, wrap(on), fares, wrap(claim), wrap(cap), wrap(remove));
        body.append(tr);
    });
    $("rules-empty").hidden = view.rules.length > 0;
}

function readJsonRules() {
    let rules;
    try {
        rules = JSON.parse($("assetRules").value);
    } catch (e) {
        return e.message;
    }
    const tableable =
        Array.isArray(rules) &&
        rules.every(
            (r) =>
                r && Array.isArray(r.fares) && r.fares.every((f) => f && f.currency && f.pricing),
        );
    if (!tableable) return "expected a list of rules, each with a list of fares";
    view.rules = rules;
    renderRules();
    return null;
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
    $("hint-dust").textContent = group(status.dust);
    renderSetup();
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
    const policy = await api("/admin/api/policy");
    fillPolicyForm(policy);
    view.policy = policy;
    if (view.status) renderExposure(view.status);
    renderSetup();
}

async function loadHistory() {
    renderHistory((await api("/admin/api/policy/history?limit=50")).history);
}

async function loadFunding() {
    try {
        view.funding = await api("/admin/api/funding");
        renderFunding(view.funding);
        $("funding-state").title = "";
    } catch (e) {
        const { text, raw } = explain(e);
        $("funding-state").textContent = text;
        $("funding-state").title = raw;
    }
    renderSetup();
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
    renderSetup();
}

async function mutate(run, noteId) {
    try {
        await run();
        setNote(noteId, "request accepted", false);
        await Promise.all([loadPolicy(), loadHistory(), loadStatus()]);
        renderAlarm();
    } catch (e) {
        showError(noteId, e);
    }
}

const postAction = (path) =>
    api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
    });

const patchPolicy = (patch) =>
    api("/admin/api/policy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
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
    $("refresh").addEventListener("click", loadFunding);
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
    $("step-connected-fix").addEventListener("click", () =>
        mutate(() => postAction("/admin/api/rescan"), "setup-note"),
    );
    $("step-live-fix").addEventListener("click", () => {
        const undone = Object.keys(STEP_NAMES).filter((id) => !view.done[id]);
        if (undone.length === 0) return goLive();
        $("go-live-warning").textContent =
            "Not done yet: " +
            undone.map((id) => STEP_NAMES[id]).join(", ") +
            ". It will refuse payments until they are.";
        $("go-live-confirm").hidden = false;
        $("go-live-anyway").focus();
    });
    $("go-live-anyway").addEventListener("click", goLive);
    $("go-live-cancel").addEventListener("click", () => {
        $("go-live-confirm").hidden = true;
        $("step-live-fix").focus();
    });
    for (const [button, address] of [
        ["funding-copy", "funding-address"],
        ["funding-boarding-copy", "funding-boarding-address"],
    ])
        $(button).addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText($(address).textContent);
                $("funding-state").textContent = "address copied";
            } catch (e) {
                $("funding-state").textContent = "copy failed: select the address instead";
            }
        });

    $("rule-add-bitcoin").addEventListener("click", () => {
        if (view.rules.some((r) => r.assetId === null))
            return setNote("policy-note", "Bitcoin already has a rule.", true);
        editRules(() => view.rules.push(newRule(null)), true);
    });
    $("rule-add-asset").addEventListener("click", () => {
        const id = parseAssetId($("rule-asset").value);
        if (!id) return setNote("policy-note", ASSET_ID_HELP, true);
        if (view.rules.some((r) => r.assetId && assetKey(r.assetId) === assetKey(id)))
            return setNote("policy-note", "That asset already has a rule.", true);
        editRules(() => view.rules.push(newRule(id)), true);
        $("rule-asset").value = "";
    });
    $("assetRules").addEventListener("input", readJsonRules);
    $("rules-json-toggle").addEventListener("click", () => {
        const show = $("rules-json").hidden;
        const problem = show ? null : readJsonRules();
        if (problem)
            return setNote(
                "policy-note",
                "Asset rules: the JSON is not valid (" + problem + ").",
                true,
            );
        $("rules-json").hidden = !show;
        $("rules-json-toggle").ariaExpanded = String(show);
        $("rules-json-toggle").textContent = show ? "Hide JSON" : "Edit as JSON";
    });

    $("policy-form").addEventListener("submit", (e) => {
        e.preventDefault();
        let rules;
        try {
            rules = JSON.parse($("assetRules").value);
        } catch (err) {
            setNote(
                "policy-note",
                "Asset rules: the JSON is not valid (" + err.message + ").",
                true,
            );
            return;
        }
        const patch = policyPatch(rules);
        if (Object.keys(patch).length === 0) {
            setNote("policy-note", "nothing changed", false);
            return;
        }
        mutate(() => patchPolicy(patch), "policy-note");
    });

    $("wizard-open").addEventListener("click", openWizard);
    $("wiz-cancel").addEventListener("click", () => $("wizard").close());
    $("wiz-back").addEventListener("click", () => wizardMove(-1));
    $("wiz-next").addEventListener("click", () => wizardMove(1));
    $("wiz-save").addEventListener("click", () => saveWizard(false));
    $("wiz-save-live").addEventListener("click", () => saveWizard(true));
    $("wiz-btc").addEventListener("change", renderWizard);
    $("wiz-assets").addEventListener("input", renderWizard);
    for (const [name, values] of Object.entries(WIZARD_CHOICES))
        for (const value of values)
            $("wiz-" + name + "-" + value).addEventListener("change", () => {
                wizard[name] = value;
                renderWizard();
            });

    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refresh();
    });

    gateActions();
}

wire();
Promise.all([loadPolicy().catch((e) => setNote("policy-note", e.message, true)), refresh()]).then(
    () => {
        if (view.policy && view.status && firstRun(view.policy)) openWizard();
    },
);
loadHistory().catch(() => {});
loadFunding();
window.setInterval(refresh, POLL_MS);
