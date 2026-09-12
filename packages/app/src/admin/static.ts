/**
 * The dashboard, compiled in as strings. No route touches the filesystem, so
 * the Docker image needs no COPY of an asset directory and tsc alone is a
 * complete build.
 *
 * Authored under ./static/ and copied here verbatim; test/admin/static.test.ts
 * fails on any drift between those files and these constants.
 */

import type { Context, Hono } from "hono";

export const INDEX_HTML = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>arkade-taxi operator console</title>
        <link
            rel="icon"
            href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' fill='%23101215'/><rect x='3' y='3' width='10' height='3' fill='%23dfe3e8'/><rect x='3' y='8' width='10' height='3' fill='%23f0a92c'/></svg>"
        />
        <link rel="stylesheet" href="/admin/styles.css" />
        <script src="/admin/app.js" defer></script>
    </head>
    <body>
        <div class="alarm" id="alarm" role="alert" hidden>
            <span id="alarm-title">Sweeper stale</span>
            <span class="alarm__detail" id="alarm-detail"></span>
        </div>

        <header class="bar">
            <h1>arkade-taxi <span>operator console</span></h1>
            <div class="bar__right">
                <span class="pill" id="service-state">loading</span>
                <button type="button" id="refresh">Refresh</button>
                <span class="meta" id="updated">never updated</span>
            </div>
        </header>

        <main>
            <section class="headline" aria-labelledby="exposure-heading">
                <div>
                    <h2 class="label" id="exposure-heading">Outstanding exposure</h2>
                    <p class="figure" id="outstanding">—<span class="unit">sats</span></p>
                    <div class="gauge" title="share of the outstanding cap in use">
                        <div class="gauge__fill" id="gauge"></div>
                    </div>
                    <dl class="satellites">
                        <div>
                            <dt>Active advances</dt>
                            <dd id="locked-count">—</dd>
                        </div>
                        <div>
                            <dt>Oldest unswept (height / time)</dt>
                            <dd id="oldest-locktime">—</dd>
                        </div>
                        <div>
                            <dt>Cap</dt>
                            <dd id="cap">—</dd>
                        </div>
                        <div>
                            <dt>Cap in use</dt>
                            <dd id="cap-used">—</dd>
                        </div>
                    </dl>
                </div>

                <div class="headline__sweeper" id="sweeper">
                    <h2 class="label">Sweeper — last tick</h2>
                    <p class="tick" id="sweeper-tick">—</p>
                    <p class="sweeper__state" id="sweeper-state">unknown</p>
                    <p class="sweeper__meta" id="sweeper-meta"></p>
                    <p class="sweeper__error" id="sweeper-error" hidden></p>
                </div>
            </section>

            <dl class="states" id="states"></dl>

            <section class="panel" aria-labelledby="readiness-heading">
                <div class="panel__head">
                    <h2 id="readiness-heading">Operational readiness</h2>
                    <div class="actions">
                        <button type="button" id="rescan">Rescan</button>
                        <span class="meta" id="readiness-state">unknown</span>
                    </div>
                </div>
                <dl class="states operational">
                    <div>
                        <dt>Startup phase</dt>
                        <dd id="startup-phase">—</dd>
                    </div>
                    <div>
                        <dt>Usable inventory</dt>
                        <dd id="usable-inventory">—</dd>
                    </div>
                    <div>
                        <dt>Reserved inventory</dt>
                        <dd id="reserved-inventory">—</dd>
                    </div>
                    <div>
                        <dt>Provider network</dt>
                        <dd id="provider-network">—</dd>
                    </div>
                    <div>
                        <dt>Height expiry</dt>
                        <dd id="height-expiry">—</dd>
                    </div>
                    <div>
                        <dt>Time expiry</dt>
                        <dd id="time-expiry">—</dd>
                    </div>
                </dl>
                <p class="note" id="readiness-blockers"></p>
            </section>

            <div class="cols">
                <section class="panel" aria-labelledby="policy-heading">
                    <div class="panel__head">
                        <h2 id="policy-heading">Policy</h2>
                        <span class="meta" id="policy-loaded"></span>
                    </div>
                    <div class="panel__body">
                        <div class="actions">
                            <button type="button" id="pause" class="attention">Pause</button>
                            <button type="button" id="resume">Resume</button>
                        </div>
                        <p class="note" id="switch-note" aria-live="polite"></p>

                        <form id="policy-form" class="form-grid" novalidate>
                            <p class="field">
                                <label for="feeFlatSats">Flat fee (sats)</label>
                                <input type="text" id="feeFlatSats" inputmode="numeric" />
                            </p>
                            <p class="field">
                                <label for="feeBps">Fee (bps)</label>
                                <input type="number" id="feeBps" min="0" max="10000" step="1" />
                            </p>
                            <p class="field">
                                <label for="maxOutstandingSats">Max outstanding (sats)</label>
                                <input type="text" id="maxOutstandingSats" inputmode="numeric" />
                            </p>
                            <p class="field">
                                <label for="maxPerPaymentTopupSats"
                                    >Max topup per payment (sats)</label
                                >
                                <input
                                    type="text"
                                    id="maxPerPaymentTopupSats"
                                    inputmode="numeric"
                                />
                            </p>
                            <p class="field">
                                <label for="maxConcurrentAdvances">Max concurrent advances</label>
                                <input type="number" id="maxConcurrentAdvances" min="0" step="1" />
                            </p>
                            <p class="field">
                                <label for="locktimeMarginBlocks">Locktime margin (blocks)</label>
                                <input type="number" id="locktimeMarginBlocks" min="0" step="1" />
                            </p>
                            <p class="field">
                                <label for="locktimeMarginSeconds">Locktime margin (seconds)</label>
                                <input type="number" id="locktimeMarginSeconds" min="0" step="1" />
                            </p>
                            <p class="field">
                                <label for="quoteTtlSeconds">Quote TTL (seconds)</label>
                                <input type="number" id="quoteTtlSeconds" min="1" step="1" />
                            </p>
                            <p class="field field--wide">
                                <label for="assetAllowlist">Asset allowlist</label>
                                <input
                                    type="text"
                                    id="assetAllowlist"
                                    spellcheck="false"
                                    placeholder="comma separated"
                                />
                                <label class="check">
                                    <input type="checkbox" id="allowAnyAsset" />
                                    Accept every asset
                                </label>
                            </p>
                            <div class="actions">
                                <button type="submit" class="primary" id="apply">Apply</button>
                                <button type="button" id="revert">Revert</button>
                            </div>
                        </form>
                        <p class="note" id="policy-note" aria-live="polite"></p>
                    </div>
                </section>

                <section class="panel" aria-labelledby="advances-heading">
                    <div class="panel__head">
                        <h2 id="advances-heading">Advances</h2>
                        <span class="actions">
                            <label class="field-label" for="state-filter">State</label>
                            <select id="state-filter">
                                <option value="">all</option>
                            </select>
                            <span class="meta" id="advances-count"></span>
                        </span>
                    </div>
                    <div class="scroll">
                        <table>
                            <caption class="sr-only">
                                Advances ordered by safety urgency in the current snapshot
                            </caption>
                            <thead>
                                <tr>
                                    <th scope="col">Id</th>
                                    <th scope="col">State</th>
                                    <th scope="col" class="n">Topup</th>
                                    <th scope="col" class="n">Fee</th>
                                    <th scope="col" class="n">Locktime</th>
                                    <th scope="col" class="n">Age</th>
                                    <th scope="col">Phase</th>
                                    <th scope="col">Action</th>
                                    <th scope="col">Covenant</th>
                                </tr>
                            </thead>
                            <tbody id="advances-body"></tbody>
                        </table>
                        <p class="empty" id="advances-empty" hidden>No advances.</p>
                    </div>
                    <div class="pagination">
                        <p class="note" id="advances-note" aria-live="polite">
                            Current snapshot pagination starts on refresh.
                        </p>
                        <button type="button" id="advances-more" hidden>Load more</button>
                    </div>
                </section>
            </div>

            <section class="panel" aria-labelledby="history-heading">
                <div class="panel__head">
                    <h2 id="history-heading">Policy audit</h2>
                    <span class="meta">every field change, attributed</span>
                </div>
                <div class="scroll">
                    <table>
                        <caption class="sr-only">
                            Policy changes, newest first
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">When</th>
                                <th scope="col">Field</th>
                                <th scope="col">From</th>
                                <th scope="col">To</th>
                                <th scope="col">Actor</th>
                            </tr>
                        </thead>
                        <tbody id="history-body"></tbody>
                    </table>
                    <p class="empty" id="history-empty" hidden>No policy changes recorded.</p>
                </div>
            </section>
        </main>
    </body>
</html>
`;

export const STYLES_CSS = `:root {
    --bg: #101215;
    --panel: #171a1e;
    --panel-2: #1b1f24;
    --line: #262b31;
    --line-strong: #363d45;
    --text: #dfe3e8;
    --text-dim: #939ba6;
    --text-faint: #7b848f;
    --accent: #f0a92c;
    --accent-ink: #14150f;
    --sans: ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", Menlo, Consolas, monospace;
}

*,
*::before,
*::after {
    box-sizing: border-box;
}

[hidden] {
    display: none !important;
}

html {
    background: var(--bg);
}

body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 400 14px/1.45 var(--sans);
    -webkit-font-smoothing: antialiased;
}

.num,
input,
select,
textarea,
button,
td,
.figure,
.tick {
    font-variant-numeric: tabular-nums;
}

.sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
}

:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
}

/* Alarm */

.alarm {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    gap: 12px;
    align-items: baseline;
    padding: 10px 16px;
    background: var(--accent);
    color: var(--accent-ink);
    border-bottom: 2px solid #b87c14;
    font: 700 13px/1.3 var(--sans);
    letter-spacing: 0.06em;
    text-transform: uppercase;
}

.alarm__detail {
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: none;
    font-family: var(--mono);
}

/* Top bar */

.bar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 20px;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
}

.bar h1 {
    margin: 0;
    font: 600 15px/1 var(--sans);
    letter-spacing: 0.01em;
}

.bar h1 span {
    color: var(--text-faint);
    font-weight: 400;
    margin-left: 8px;
}

.bar__right {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    align-items: center;
}

.pill {
    padding: 3px 9px;
    border: 1px solid var(--line-strong);
    color: var(--text-dim);
    font: 600 11px/1.4 var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.pill--attention {
    border-color: var(--accent);
    color: var(--accent);
}

.meta {
    color: var(--text-faint);
    font: 400 12px/1.4 var(--mono);
}

/* Layout */

main {
    max-width: 1560px;
    margin: 0 auto;
    padding: 16px;
    display: grid;
    gap: 16px;
}

.cols {
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
    align-items: stretch;
}

@media (max-width: 1040px) {
    .cols {
        grid-template-columns: minmax(0, 1fr);
    }
}

.panel {
    background: var(--panel);
    border: 1px solid var(--line);
}

.panel__head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    align-items: center;
    justify-content: space-between;
    padding: 9px 14px;
    border-bottom: 1px solid var(--line);
}

.panel__head select {
    width: auto;
    min-width: 11ch;
}

.panel__head h2 {
    margin: 0;
    font: 600 11px/1.4 var(--sans);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
}

.panel__body {
    padding: 14px;
}

/* Headline: exposure and sweeper */

.headline {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
    border: 1px solid var(--line);
    background: var(--panel);
}

@media (max-width: 900px) {
    .headline {
        grid-template-columns: minmax(0, 1fr);
    }
}

.headline > div {
    padding: 18px 20px 16px;
}

.headline__sweeper {
    border-left: 1px solid var(--line);
}

@media (max-width: 900px) {
    .headline__sweeper {
        border-left: 0;
        border-top: 1px solid var(--line);
    }
}

body.is-alarm .headline__sweeper {
    background: #1e1a12;
    border-left-color: var(--accent);
    box-shadow: inset 3px 0 0 var(--accent);
}

.label {
    margin: 0 0 6px;
    font: 600 11px/1.4 var(--sans);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
}

/* Digits are grouped with a plain space, which at this size reads as two
 * separate numbers unless it is pulled back in. */
.figure {
    margin: 0;
    font: 500 clamp(2.4rem, 6.5vw, 4rem) / 1 var(--mono);
    letter-spacing: -0.02em;
    word-spacing: -0.28em;
    word-break: break-all;
}

.figure .unit {
    font-size: 0.28em;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-faint);
    margin-left: 10px;
    word-break: normal;
}

.gauge {
    height: 5px;
    margin: 14px 0 10px;
    background: #0b0d0f;
    border: 1px solid var(--line);
}

.gauge__fill {
    height: 100%;
    background: var(--text-faint);
    width: 0;
}

.gauge__fill.is-high {
    background: var(--accent);
}

.satellites {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 28px;
    margin: 0;
}

.satellites > div {
    min-width: 0;
}

.satellites dt {
    font: 600 10.5px/1.6 var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
}

.satellites dd {
    margin: 0;
    font: 400 15px/1.4 var(--mono);
}

.tick {
    margin: 0;
    font: 500 clamp(1.5rem, 3.2vw, 2.1rem) / 1.1 var(--mono);
}

.tick--stale {
    color: var(--accent);
}

.sweeper__state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0 0;
    font: 600 12px/1.4 var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
}

.sweeper__state::before {
    content: "";
    width: 8px;
    height: 8px;
    background: var(--line-strong);
}

.sweeper__state.is-bad {
    color: var(--accent);
}

.sweeper__state.is-bad::before {
    background: var(--accent);
}

.sweeper__meta {
    margin: 10px 0 0;
    color: var(--text-faint);
    font: 400 12px/1.6 var(--mono);
}

.sweeper__error {
    margin: 8px 0 0;
    padding: 6px 8px;
    border-left: 2px solid var(--accent);
    background: #1a1710;
    color: var(--accent);
    font: 400 12px/1.5 var(--mono);
    word-break: break-word;
}

/* State counts */

.states {
    display: flex;
    flex-wrap: wrap;
    margin: 0;
    border: 1px solid var(--line);
    background: var(--panel);
}

.states.operational {
    grid-template-columns: repeat(6, minmax(120px, 1fr));
    border-top: 0;
}

.states > div {
    flex: 1 1 110px;
    padding: 10px 14px;
    border-right: 1px solid var(--line);
}

.states > div:last-child {
    border-right: 0;
}

.states dt {
    font: 600 10.5px/1.6 var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
}

.states dd {
    margin: 0;
    font: 400 20px/1.2 var(--mono);
}

.states .is-live dd {
    color: var(--text);
}

/* Forms */

.form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 12px;
    align-items: start;
    margin-top: 14px;
}

.form-grid > .actions,
.field--wide {
    grid-column: 1 / -1;
}

.field {
    display: grid;
    gap: 4px;
    margin: 0;
}

.field > label:not(.check),
.field-label {
    font: 600 10.5px/1.4 var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
}

.hint {
    color: var(--text-faint);
    font: 400 11.5px/1.4 var(--sans);
    text-transform: none;
    letter-spacing: 0;
}

input[type="text"],
input[type="number"],
select {
    width: 100%;
    padding: 6px 8px;
    background: #0c0e11;
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: 2px;
    font: 400 13px/1.4 var(--mono);
}

input[type="text"]:hover,
select:hover {
    border-color: #48515b;
}

.bar input[type="text"] {
    width: 170px;
}

.check {
    display: flex;
    gap: 8px;
    align-items: center;
    font: 400 12.5px/1.4 var(--sans);
    color: var(--text-dim);
}

.check input {
    width: 14px;
    height: 14px;
    accent-color: var(--accent);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}

button {
    padding: 6px 12px;
    background: transparent;
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: 2px;
    font: 600 11px/1.5 var(--sans);
    letter-spacing: 0.09em;
    text-transform: uppercase;
    cursor: pointer;
}

button:hover:not(:disabled) {
    background: var(--panel-2);
    border-color: #4b545f;
}

button:disabled {
    color: var(--text-faint);
    border-color: var(--line);
    cursor: not-allowed;
}

button.primary {
    background: var(--panel-2);
}

button.attention:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
}

.note {
    margin: 10px 0 0;
    min-height: 1.4em;
    font: 400 12px/1.4 var(--mono);
    color: var(--text-dim);
    word-break: break-word;
}

.note.is-error {
    color: var(--accent);
}

/* Tables */

.scroll {
    max-height: 460px;
    overflow: auto;
}

table {
    width: 100%;
    border-collapse: collapse;
    font: 400 12.5px/1.5 var(--mono);
}

caption {
    text-align: left;
}

thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 7px 10px;
    background: var(--panel-2);
    border-bottom: 1px solid var(--line-strong);
    text-align: left;
    font: 600 10.5px/1.5 var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
    white-space: nowrap;
}

tbody td,
tbody th {
    padding: 6px 10px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    font-weight: 400;
    white-space: nowrap;
}

tbody tr:nth-child(even) td,
tbody tr:nth-child(even) th {
    background: #14171b;
}

.n {
    text-align: right;
}

th.n,
td.n {
    text-align: right;
}

.dim {
    color: var(--text-faint);
}

.trunc {
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-block;
    vertical-align: bottom;
}

.state-tag {
    font: 600 10.5px/1.5 var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim);
}

.state-tag.is-locked {
    color: var(--text);
}

.due {
    color: var(--accent);
    font-weight: 600;
}

.empty {
    padding: 18px 14px;
    color: var(--text-faint);
    font: 400 12.5px/1.5 var(--mono);
}

.pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    border-top: 1px solid var(--line);
}

.pagination .note {
    margin: 0;
}
`;

export const APP_JS = `"use strict";

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

const SATS_FIELDS = ["feeFlatSats", "maxOutstandingSats", "maxPerPaymentTopupSats"];
const INT_FIELDS = [
    "feeBps",
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
            : \`\${oldest.height === null ? "—" : group(oldest.height)} / \${
                  oldest.time === null ? "—" : group(oldest.time)
              }\`;

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

    $("allowAnyAsset").addEventListener("change", (e) => {
        $("assetAllowlist").disabled = e.target.checked;
    });

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

    $("policy-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const patch = policyPatch();
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
`;

const serve = (payload: string, contentType: string) => (c: Context) =>
    c.body(payload, 200, { "content-type": contentType, "cache-control": "no-cache" });

/** Registered under both the bare and the /admin prefix so the page answers
 * whichever way server.ts mounts the router. */
export function registerStaticRoutes(app: Hono, prefix: string): void {
    const page = serve(INDEX_HTML, "text/html; charset=utf-8");
    for (const p of prefix === "" ? ["/"] : [prefix, prefix + "/"]) app.get(p, page);
    app.get(prefix + "/app.js", serve(APP_JS, "text/javascript; charset=utf-8"));
    app.get(prefix + "/styles.css", serve(STYLES_CSS, "text/css; charset=utf-8"));
}
