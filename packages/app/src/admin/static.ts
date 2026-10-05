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
            <section class="panel" id="setup" aria-labelledby="setup-heading">
                <div class="panel__head">
                    <h2 id="setup-heading">Get started</h2>
                    <button type="button" id="wizard-open">Run setup again</button>
                </div>
                <ol class="steps">
                    <li class="step" id="step-connected">
                        <span class="step__state" id="step-connected-state">…</span>
                        <div>
                            <p class="step__title" id="step-connected-title">
                                Taxi is running and connected
                            </p>
                            <ul class="step__detail" id="step-connected-detail"></ul>
                        </div>
                        <button type="button" id="step-connected-fix">Check again</button>
                    </li>
                    <li class="step" id="step-fund">
                        <span class="step__state" id="step-fund-state">…</span>
                        <div>
                            <p class="step__title">Fund your Taxi</p>
                            <p class="step__detail" id="step-fund-detail"></p>
                            <p class="step__detail">
                                On-chain deposits move in automatically shortly after they confirm.
                            </p>
                        </div>
                        <a class="button" id="step-fund-fix" href="#funding">Show addresses</a>
                    </li>
                    <li class="step" id="step-limits">
                        <span class="step__state" id="step-limits-state">…</span>
                        <div>
                            <p class="step__title">Set your limits</p>
                            <p class="step__detail" id="step-limits-detail"></p>
                        </div>
                        <a class="button" id="step-limits-fix" href="#limits">Edit limits</a>
                    </li>
                    <li class="step" id="step-carry">
                        <span class="step__state" id="step-carry-state">…</span>
                        <div>
                            <p class="step__title">Choose what to carry</p>
                            <p class="step__detail" id="step-carry-detail"></p>
                        </div>
                        <a class="button" id="step-carry-fix" href="#carry">Edit rules</a>
                    </li>
                    <li class="step" id="step-live">
                        <span class="step__state" id="step-live-state">…</span>
                        <div>
                            <p class="step__title">Go live</p>
                            <p class="step__detail" id="step-live-detail"></p>
                            <div class="step__confirm" id="go-live-confirm" role="alert" hidden>
                                <p id="go-live-warning"></p>
                                <div class="actions">
                                    <button type="button" class="attention" id="go-live-anyway">
                                        Go live anyway
                                    </button>
                                    <button type="button" id="go-live-cancel">Cancel</button>
                                </div>
                            </div>
                        </div>
                        <button type="button" class="primary" id="step-live-fix">Go live</button>
                    </li>
                </ol>
                <div class="note setup__note" id="setup-note" aria-live="polite"></div>
            </section>

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
                <ul class="step__detail warn" id="readiness-warnings" hidden></ul>
            </section>

            <section class="panel" id="funding" aria-labelledby="funding-heading">
                <div class="panel__head">
                    <h2 id="funding-heading">Funding</h2>
                    <div class="actions">
                        <button type="button" id="funding-copy" disabled>Copy address</button>
                        <span class="meta" id="funding-state">unknown</span>
                        <span class="meta" id="funding-loaded"></span>
                    </div>
                </div>
                <dl class="states operational">
                    <div>
                        <dt>Usable</dt>
                        <dd id="funding-usable">—</dd>
                    </div>
                    <div>
                        <dt>Reserved</dt>
                        <dd id="funding-reserved">—</dd>
                    </div>
                    <div>
                        <dt>Reserve threshold</dt>
                        <dd id="funding-threshold">—</dd>
                    </div>
                    <div>
                        <dt>On-chain confirmed</dt>
                        <dd id="funding-boarding-confirmed">—</dd>
                    </div>
                    <div>
                        <dt>On-chain unconfirmed</dt>
                        <dd id="funding-boarding-unconfirmed">—</dd>
                    </div>
                    <div>
                        <dt>On-chain expired</dt>
                        <dd id="funding-boarding-expired">—</dd>
                    </div>
                </dl>
                <div class="panel__body">
                    <p class="label">Arkade address</p>
                    <p class="address" id="funding-address">—</p>
                    <p class="note">
                        Send sats or assets offchain from any Arkade wallet to this address.
                    </p>
                    <p class="label">On-chain boarding address</p>
                    <p class="address" id="funding-boarding-address">—</p>
                    <div class="actions">
                        <button type="button" id="funding-boarding-copy" disabled>
                            Copy boarding address
                        </button>
                    </div>
                    <p class="note">
                        Send bitcoin on-chain to this address. Deposits move into the Arkade address
                        above automatically shortly after they confirm; expired ones are swept back
                        here automatically.
                    </p>
                </div>
                <div class="scroll">
                    <table>
                        <caption class="sr-only">
                            Asset balances across the operator's spendable coins
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">Asset</th>
                                <th scope="col" class="n">Group</th>
                                <th scope="col" class="n">Amount</th>
                            </tr>
                        </thead>
                        <tbody id="funding-assets"></tbody>
                    </table>
                    <p class="empty" id="funding-assets-empty" hidden>No assets held.</p>
                </div>
            </section>

            <section class="panel" id="settings" aria-labelledby="policy-heading">
                <div class="panel__head">
                    <h2 id="policy-heading">Settings</h2>
                    <div class="actions">
                        <button type="button" id="pause" class="attention">Pause</button>
                        <button type="button" id="resume">Resume</button>
                        <span class="meta" id="policy-loaded"></span>
                    </div>
                </div>
                <div class="panel__body">
                    <div class="note" id="switch-note" aria-live="polite"></div>

                    <form id="policy-form" novalidate>
                        <fieldset class="group" id="limits">
                            <legend>Limits</legend>
                            <div class="form-grid">
                                <p class="field">
                                    <label for="maxPerPaymentTopupSats"
                                        >Max per payment (sats)</label
                                    >
                                    <input
                                        type="text"
                                        id="maxPerPaymentTopupSats"
                                        inputmode="numeric"
                                        aria-describedby="hint-per-payment"
                                    />
                                    <span class="hint" id="hint-per-payment"
                                        >The most it lends to one payment, unless a rule below sets
                                        its own. The network dust,
                                        <span id="hint-dust">—</span> sats, covers any small
                                        payment.</span
                                    >
                                </p>
                                <p class="field">
                                    <label for="maxOutstandingSats">Max outstanding (sats)</label>
                                    <input
                                        type="text"
                                        id="maxOutstandingSats"
                                        inputmode="numeric"
                                        aria-describedby="hint-outstanding"
                                    />
                                    <span class="hint" id="hint-outstanding"
                                        >The most it has lent at once, across all payments. It is
                                        lent from the balance above the reserve. Example: 33
                                        000.</span
                                    >
                                </p>
                                <p class="field">
                                    <label for="maxConcurrentAdvances">Max payments at once</label>
                                    <input
                                        type="number"
                                        id="maxConcurrentAdvances"
                                        min="0"
                                        step="1"
                                        aria-describedby="hint-concurrent"
                                    />
                                    <span class="hint" id="hint-concurrent"
                                        >How many payments can wait to be claimed at the same time.
                                        Example: 100.</span
                                    >
                                </p>
                            </div>
                            <p class="hint">
                                At 0, any one of these makes the Taxi refuse every payment.
                            </p>
                        </fieldset>

                        <fieldset class="group" id="carry">
                            <legend>What you carry</legend>
                            <p class="hint">
                                One rule per kind of payment: bitcoin, any asset, or one asset by
                                its exact id. An asset's own rule always wins over "Any asset", so
                                you can price one asset differently or switch it off. A payer may
                                take any fare a rule offers; the first is the one they get if they
                                name none, and the arrows reorder them.
                            </p>
                            <details class="help" id="carry-help">
                                <summary>What each choice means</summary>
                                <dl>
                                    <dt>When the receiver claims</dt>
                                    <dd id="help-claim-recycle">
                                        <b>Get my sats back</b> (recycle). The receiver repays the
                                        lent sats with their own when they claim, so they come back
                                        to your Taxi then. If nobody claims, the Taxi recovers them
                                        itself after the locktime.
                                    </dd>
                                    <dd id="help-claim-purchase">
                                        <b>Sell outright</b> (purchase). The receiver keeps the lent
                                        sats when they claim: the fare, paid when the payment is
                                        sent, is all your Taxi earns. Receive quotes refuse this
                                        mode, as they need the sats repaid.
                                    </dd>
                                    <dd id="help-claim-either">
                                        <b>Payer chooses</b> (either). Each payer picks recycle or
                                        purchase; one who does not pick gets recycle.
                                    </dd>
                                    <dt>Fare currency</dt>
                                    <dd id="help-currency-sats">
                                        <b>In sats</b>. Paid out of the payer's own spare sats, so a
                                        payer who has none cannot take it.
                                    </dd>
                                    <dd id="help-currency-sameAsset">
                                        <b>In the asset</b>. Paid in the asset being moved, so a
                                        payer holding only that asset can still pay. Never on
                                        bitcoin.
                                    </dd>
                                    <dd id="help-currency-token">
                                        <b>In a token</b>. A set amount of one token you name,
                                        whatever is sent, like a prepaid ticket. Always flat.
                                    </dd>
                                    <dt>Fare pricing</dt>
                                    <dd id="help-pricing-flat">
                                        <b>Flat</b>. The same amount on every payment; 0 is free.
                                    </dd>
                                    <dd id="help-pricing-proportional">
                                        <b>Percent</b>. A share of the sats lent for a sats fare, or
                                        of the amount sent for an asset fare, rounded down and kept
                                        between the minimum and the optional maximum.
                                    </dd>
                                </dl>
                            </details>
                            <div class="scroll">
                                <table class="rules">
                                    <caption class="sr-only">
                                        Payments the Taxi carries, and on what terms
                                    </caption>
                                    <thead>
                                        <tr>
                                            <th scope="col">Payment</th>
                                            <th scope="col">On</th>
                                            <th scope="col">Fares</th>
                                            <th scope="col">When the receiver claims</th>
                                            <th scope="col">Max per payment</th>
                                            <th scope="col"><span class="sr-only">Remove</span></th>
                                        </tr>
                                    </thead>
                                    <tbody id="rules-body"></tbody>
                                </table>
                                <p class="empty" id="rules-empty" hidden>
                                    No rules yet: the Taxi refuses every payment.
                                </p>
                            </div>
                            <div class="confirm" id="rules-giveaway" role="alert" hidden>
                                <p>
                                    Payers could take the carrier sats for free; you would pay every
                                    carrier yourself. <span id="rules-giveaway-which"></span>
                                </p>
                                <label class="check" for="rules-giveaway-ok">
                                    <input type="checkbox" id="rules-giveaway-ok" />
                                    Give carriers away for free
                                </label>
                            </div>
                            <div class="actions">
                                <button type="button" id="rule-add-bitcoin">Add bitcoin</button>
                                <button type="button" id="rule-add-any">Add any asset</button>
                                <label class="sr-only" for="rule-asset">Asset id to add</label>
                                <input
                                    type="text"
                                    id="rule-asset"
                                    class="asset-input"
                                    placeholder="asset id from your wallet"
                                    spellcheck="false"
                                />
                                <button type="button" id="rule-add-asset">Add asset</button>
                                <button
                                    type="button"
                                    id="rules-json-toggle"
                                    aria-expanded="false"
                                    aria-controls="rules-json"
                                >
                                    Edit as JSON
                                </button>
                            </div>
                            <p class="field" id="rules-json" hidden>
                                <label for="assetRules">Asset rules (JSON)</label>
                                <textarea id="assetRules" rows="14" spellcheck="false"></textarea>
                            </p>
                        </fieldset>

                        <details class="group help" id="payment-kinds">
                            <summary>Which settings each kind of payment uses</summary>
                            <dl>
                                <dt>Covenant transfers</dt>
                                <dd id="help-route-transfers">
                                    The Taxi lends the carrier sats a payment lacks, locked in a
                                    covenant until the receiver claims it or the Taxi recovers it.
                                    Uses Pause, the payment's rule (on, fares, claim mode, max per
                                    payment), Max per payment, Max outstanding, Max payments at
                                    once, both locktime margins and Quote lifetime.
                                </dd>
                                <dt>Sponsored direct transfers</dt>
                                <dd id="help-route-sponsored-transfers">
                                    The Taxi pays its share of the carrier straight into the
                                    receiver's own wallet. Nothing is claimed or repaid, so the fare
                                    is all your Taxi earns, and a free fare gives the carrier away.
                                    Uses Pause, the payment's rule (on, fares, max per payment; not
                                    its claim mode), Max per payment, Max outstanding and Max
                                    payments at once (counting it only until it lands) and Quote
                                    lifetime.
                                </dd>
                                <dt>Receive quotes</dt>
                                <dd id="help-route-receive-quotes">
                                    A receiver asks ahead for a covenant address a swap will pay
                                    into; the Taxi lends the carrier and gets it back when the
                                    receiver recycles. Uses Pause, the asset's rule (on, a sats fare
                                    or the receiver's own fare, a claim mode that allows recycle,
                                    max per payment), Max per payment, Max outstanding, Max payments
                                    at once, both locktime margins and Quote lifetime.
                                </dd>
                                <dt>Swap fills</dt>
                                <dd id="help-route-swap-fills">
                                    A solver fills a swap offer into a receive quote's covenant, and
                                    the Taxi puts in the sats that quote lends, on its terms. Uses
                                    Pause and the Bitcoin rule (on, max per payment) whatever is
                                    swapped, Max per payment, Max outstanding and Max payments at
                                    once.
                                </dd>
                            </dl>
                        </details>

                        <details class="group" id="advanced">
                            <summary>Advanced</summary>
                            <p class="hint">Leave these at their defaults unless you know why.</p>
                            <div class="form-grid">
                                <p class="field">
                                    <label for="locktimeMarginBlocks"
                                        >Locktime margin (blocks)</label
                                    >
                                    <input
                                        type="number"
                                        id="locktimeMarginBlocks"
                                        min="0"
                                        step="1"
                                        aria-describedby="hint-margin-blocks"
                                    />
                                    <span class="hint" id="hint-margin-blocks"
                                        >Headroom between a payment's recovery time and its coin's
                                        expiry, so the Taxi recovers lent sats before the coin
                                        expires. Must exceed the recovery budget
                                        (TAXI_RECOVERY_BROADCAST_BLOCKS). Default 144.</span
                                    >
                                </p>
                                <p class="field">
                                    <label for="locktimeMarginSeconds"
                                        >Locktime margin (seconds)</label
                                    >
                                    <input
                                        type="number"
                                        id="locktimeMarginSeconds"
                                        min="0"
                                        step="1"
                                        aria-describedby="hint-margin-seconds"
                                    />
                                    <span class="hint" id="hint-margin-seconds"
                                        >The same headroom for coins that expire at a time rather
                                        than a block. Must exceed TAXI_RECOVERY_BROADCAST_SECONDS.
                                        Default 86 400, one day.</span
                                    >
                                </p>
                                <p class="field">
                                    <label for="quoteTtlSeconds">Quote lifetime (seconds)</label>
                                    <input
                                        type="number"
                                        id="quoteTtlSeconds"
                                        min="1"
                                        step="1"
                                        aria-describedby="hint-quote-ttl"
                                    />
                                    <span class="hint" id="hint-quote-ttl"
                                        >How long a price quote stays valid. The coins set aside for
                                        a quote are freed when it expires. Default 60.</span
                                    >
                                </p>
                            </div>
                        </details>

                        <div class="actions">
                            <button type="submit" class="primary" id="apply">Apply</button>
                            <button type="button" id="revert">Revert</button>
                        </div>
                    </form>
                    <div class="note" id="policy-note" aria-live="polite"></div>
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

            <section class="panel" id="service" aria-labelledby="service-heading">
                <div class="panel__head">
                    <h2 id="service-heading">Service configuration</h2>
                    <span class="meta">read-only</span>
                </div>
                <div class="panel__body">
                    <p class="hint">
                        Set from environment variables when the Taxi starts, so changing one needs a
                        redeploy: set the variable and restart the Taxi. Derived values are read
                        from the Arkade server and the Arkade SDK at startup. Secrets, such as the
                        operator private key, are never shown.
                    </p>
                </div>
                <div class="scroll">
                    <table>
                        <caption class="sr-only">
                            The Taxi's running configuration
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">Variable</th>
                                <th scope="col">Value</th>
                                <th scope="col">What it does</th>
                            </tr>
                        </thead>
                        <tbody id="service-config"></tbody>
                    </table>
                    <p class="empty" id="service-config-empty">Loading…</p>
                </div>
            </section>
        </main>

        <dialog class="wizard" id="wizard" aria-labelledby="wizard-title">
            <div class="panel__head">
                <h2 id="wizard-title">Set up your Taxi</h2>
                <span class="meta" id="wizard-progress">Step 1 of 4</span>
            </div>
            <div class="panel__body">
                <section id="wiz-step-1" aria-labelledby="wiz-h1">
                    <h3 id="wiz-h1" tabindex="-1">What should your Taxi carry?</h3>
                    <p class="lede">
                        Your Taxi lends the sats a payment is missing, so that it can be sent.
                        Choose which payments it helps.
                    </p>
                    <label class="check" for="wiz-btc">
                        <input type="checkbox" id="wiz-btc" aria-describedby="wiz-btc-hint" />
                        Small bitcoin payments
                    </label>
                    <p class="hint" id="wiz-btc-hint">
                        Payments below the network dust, <span id="wiz-dust">—</span> sats, which
                        cannot be sent on their own.
                    </p>
                    <label class="check" for="wiz-any">
                        <input type="checkbox" id="wiz-any" aria-describedby="wiz-any-hint" />
                        Any asset
                    </label>
                    <p class="hint" id="wiz-any-hint">
                        Every asset payment, whatever the asset. To treat one asset differently,
                        give it a rule of its own under Settings afterwards.
                    </p>
                    <p class="field">
                        <label for="wiz-assets">Specific assets (optional)</label>
                        <textarea
                            id="wiz-assets"
                            rows="4"
                            spellcheck="false"
                            placeholder="asset id from your wallet, one per line"
                            aria-describedby="wiz-assets-hint"
                        ></textarea>
                        <span class="hint" id="wiz-assets-hint"
                            >One per line: the 68-character asset id your wallet shows.</span
                        >
                    </p>
                </section>

                <section id="wiz-step-2" aria-labelledby="wiz-h2" hidden>
                    <h3 id="wiz-h2" tabindex="-1">How much should it lend?</h3>
                    <p class="lede">
                        Each payment borrows at most the network dust. Choose how much your Taxi may
                        have lent out at once.
                    </p>
                    <fieldset class="choices">
                        <legend class="sr-only">Lending limits</legend>
                        <label class="choice">
                            <input type="radio" name="wiz-size" id="wiz-size-small" />
                            <span class="choice__title">Small</span>
                            <span class="choice__body" id="wiz-size-small-text"></span>
                        </label>
                        <label class="choice">
                            <input type="radio" name="wiz-size" id="wiz-size-medium" />
                            <span class="choice__title">Medium</span>
                            <span class="choice__body" id="wiz-size-medium-text"></span>
                        </label>
                        <label class="choice">
                            <input type="radio" name="wiz-size" id="wiz-size-custom" />
                            <span class="choice__title">Custom</span>
                            <span class="choice__body">Set the three limits yourself.</span>
                        </label>
                    </fieldset>
                    <div class="form-grid" id="wiz-custom" hidden>
                        <p class="field">
                            <label for="wiz-per-payment">Per payment (sats)</label>
                            <input type="text" id="wiz-per-payment" inputmode="numeric" />
                        </p>
                        <p class="field">
                            <label for="wiz-outstanding">In total (sats)</label>
                            <input type="text" id="wiz-outstanding" inputmode="numeric" />
                        </p>
                        <p class="field">
                            <label for="wiz-concurrent">Payments at once</label>
                            <input type="text" id="wiz-concurrent" inputmode="numeric" />
                        </p>
                    </div>
                    <p class="hint">
                        Lent sats stay locked until the receiver claims them or the Taxi recovers
                        them. To lend the whole total, your Taxi needs it on top of the reserve it
                        must keep.
                    </p>
                </section>

                <section id="wiz-step-3" aria-labelledby="wiz-h3" hidden>
                    <h3 id="wiz-h3" tabindex="-1">What should payers pay?</h3>
                    <fieldset class="choices">
                        <legend>Fare</legend>
                        <label class="choice">
                            <input type="radio" name="wiz-fare" id="wiz-fare-free" />
                            <span class="choice__title">Free</span>
                            <span class="choice__body">Payers pay nothing extra.</span>
                        </label>
                        <label class="choice">
                            <input type="radio" name="wiz-fare" id="wiz-fare-flat" />
                            <span class="choice__title">A flat fare</span>
                            <span class="choice__body"
                                >The same number of sats on every payment.</span
                            >
                        </label>
                        <label class="choice">
                            <input type="radio" name="wiz-fare" id="wiz-fare-percent" />
                            <span class="choice__title">A percentage</span>
                            <span class="choice__body"
                                >A share of the sats lent, with a minimum and an optional
                                maximum.</span
                            >
                        </label>
                    </fieldset>
                    <p class="inline-fields" id="wiz-fare-flat-fields" hidden>
                        <label for="wiz-fare-flat-sats">Fare</label>
                        <input type="text" id="wiz-fare-flat-sats" inputmode="numeric" /> sats per
                        payment
                    </p>
                    <p class="inline-fields" id="wiz-fare-percent-fields" hidden>
                        <label for="wiz-fare-pct">Percentage</label>
                        <input type="text" id="wiz-fare-pct" inputmode="decimal" /> %, at least
                        <label class="sr-only" for="wiz-fare-min">Minimum fare in sats</label>
                        <input type="text" id="wiz-fare-min" inputmode="numeric" placeholder="0" />
                        and at most
                        <label class="sr-only" for="wiz-fare-max">Maximum fare in sats</label>
                        <input
                            type="text"
                            id="wiz-fare-max"
                            inputmode="numeric"
                            placeholder="none"
                        />
                        sats
                    </p>
                    <div id="wiz-fare-asset-row" hidden>
                        <label class="check" for="wiz-fare-asset">
                            <input type="checkbox" id="wiz-fare-asset" />
                            Asset payments may pay the fare in the asset they send instead
                        </label>
                        <p class="inline-fields" id="wiz-asset-flat-fields" hidden>
                            <label for="wiz-asset-flat-units">Fare in the asset</label>
                            <input type="text" id="wiz-asset-flat-units" inputmode="numeric" />
                            units of the asset per payment
                        </p>
                        <p class="inline-fields" id="wiz-asset-percent-fields" hidden>
                            <label for="wiz-asset-pct">Percentage</label>
                            <input type="text" id="wiz-asset-pct" inputmode="decimal" /> % of the
                            amount sent, at least
                            <label class="sr-only" for="wiz-asset-min">Minimum fare in units</label>
                            <input
                                type="text"
                                id="wiz-asset-min"
                                inputmode="numeric"
                                placeholder="0"
                            />
                            and at most
                            <label class="sr-only" for="wiz-asset-max">Maximum fare in units</label>
                            <input
                                type="text"
                                id="wiz-asset-max"
                                inputmode="numeric"
                                placeholder="none"
                            />
                            units
                        </p>
                        <p class="hint">
                            Counted in the asset's own units, not in sats. A payer picks either
                            fare.
                        </p>
                    </div>
                    <p class="hint warn" id="wiz-fare-btc-warn" hidden>
                        A small bitcoin payment leaves its sender no sats to spare, so a fare the
                        sender pays is refused on it. Free is the safe choice for bitcoin.
                    </p>

                    <fieldset class="choices">
                        <legend>When the receiver claims</legend>
                        <label class="choice">
                            <input type="radio" name="wiz-claim" id="wiz-claim-recycle" />
                            <span class="choice__title"
                                >Get my sats back when the receiver claims</span
                            >
                            <span class="choice__body"
                                >The receiver repays the lent sats with their own, so they return to
                                your Taxi.</span
                            >
                        </label>
                        <label class="choice">
                            <input type="radio" name="wiz-claim" id="wiz-claim-purchase" />
                            <span class="choice__title">Sell the carrier outright</span>
                            <span class="choice__body"
                                >The receiver keeps the lent sats; the fare is all your Taxi earns.
                                Receives quoted for a swap are refused, as they need the sats
                                back.</span
                            >
                        </label>
                        <label class="choice">
                            <input type="radio" name="wiz-claim" id="wiz-claim-either" />
                            <span class="choice__title">Let the payer choose</span>
                            <span class="choice__body"
                                >The payer picks one of the two; if they do not, the sats come back
                                to you.</span
                            >
                        </label>
                    </fieldset>
                    <div class="confirm" id="wiz-giveaway" role="alert" hidden>
                        <p>
                            Payers could take the carrier sats for free; you would pay every carrier
                            yourself.
                        </p>
                        <label class="check" for="wiz-giveaway-ok">
                            <input type="checkbox" id="wiz-giveaway-ok" />
                            Give carriers away for free
                        </label>
                    </div>
                </section>

                <section id="wiz-step-4" aria-labelledby="wiz-h4" hidden>
                    <h3 id="wiz-h4" tabindex="-1">Check and save</h3>
                    <p class="summary" id="wiz-summary"></p>
                    <p class="hint" id="wiz-save-hint"></p>
                </section>

                <div class="note" id="wiz-note" aria-live="polite"></div>
            </div>
            <div class="actions wizard__foot">
                <button type="button" id="wiz-cancel">Not now</button>
                <button type="button" id="wiz-back">Back</button>
                <button type="button" class="primary" id="wiz-next">Next</button>
                <button type="button" id="wiz-save">Save</button>
                <button type="button" class="primary" id="wiz-save-live">Save &amp; go live</button>
            </div>
        </dialog>
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
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
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

.panel:target,
.group:target {
    outline: 1px solid var(--accent);
    outline-offset: 4px;
}

/* Setup checklist */

.steps {
    margin: 0;
    padding: 0;
    list-style: none;
}

.step {
    display: grid;
    grid-template-columns: 9ch minmax(0, 1fr) auto;
    gap: 4px 16px;
    align-items: start;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
}

.step__state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding-top: 2px;
    font: 600 11px/1.6 var(--mono);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    white-space: nowrap;
}

.step__state::before {
    content: "";
    flex: none;
    width: 8px;
    height: 8px;
    background: var(--accent);
}

.step.is-done .step__state {
    color: var(--text-faint);
}

.step.is-done .step__state::before {
    background: var(--line-strong);
}

.step__title {
    margin: 0;
    font: 600 13.5px/1.6 var(--sans);
}

.step__detail {
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    color: var(--text-dim);
    font: 400 12.5px/1.55 var(--sans);
}

.step__detail code {
    margin-left: 8px;
    color: var(--text-faint);
    font: 400 11px/1.5 var(--mono);
}

.step__confirm,
.confirm {
    margin-top: 8px;
    padding: 8px 10px;
    border-left: 2px solid var(--accent);
    background: #1a1710;
    color: var(--accent);
    font: 400 12.5px/1.5 var(--sans);
}

.step__confirm p,
.confirm p {
    margin: 0 0 8px;
}

.setup__note {
    margin: 0;
    padding: 0 14px 10px;
}

/* Setup wizard */

.wizard {
    width: min(720px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow: auto;
    padding: 0;
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--line-strong);
}

.wizard::backdrop {
    background: rgb(8 9 11 / 0.75);
}

.wizard h3 {
    margin: 0 0 6px;
    font: 600 16px/1.4 var(--sans);
}

/* Focused only so a screen reader announces the new step; it is not a control. */
.wizard h3:focus {
    outline: none;
}

.lede {
    margin: 0 0 14px;
    color: var(--text-dim);
}

.choices {
    margin: 14px 0 10px;
    padding: 0;
    border: 0;
}

.choices > legend {
    margin-bottom: 8px;
    padding: 0;
    font: 600 11px/1.4 var(--sans);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
}

.choice {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 2px 10px;
    margin: 0 0 6px;
    padding: 9px 12px;
    border: 1px solid var(--line);
    cursor: pointer;
}

.choice:has(input:checked) {
    border-color: var(--accent);
    background: var(--panel-2);
}

.choice__title {
    font: 600 13px/1.5 var(--sans);
}

.choice__body {
    grid-column: 2;
    color: var(--text-dim);
    font: 400 12.5px/1.5 var(--sans);
}

.inline-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin: 0 0 10px;
    color: var(--text-dim);
}

.inline-fields input[type="text"] {
    width: 9ch;
}

.summary {
    margin: 0 0 10px;
    font: 400 14px/1.6 var(--sans);
}

.wizard__foot {
    justify-content: flex-end;
    padding: 10px 14px;
    border-top: 1px solid var(--line);
}

#wiz-cancel {
    margin-right: auto;
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

.address {
    margin: 0;
    font: 400 14px/1.5 var(--mono);
    word-break: break-all;
    user-select: all;
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
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px 16px;
    align-items: start;
}

/* Settings groups. A fieldset defaults to min-width: min-content, which would
 * stop the rules table from scrolling inside it. */
.group {
    min-width: 0;
    margin: 0 0 18px;
    padding: 0;
    border: 0;
}

.group > legend,
.group > summary {
    display: block;
    width: 100%;
    margin: 0 0 10px;
    padding: 0 0 6px;
    border-bottom: 1px solid var(--line);
    font: 600 11px/1.4 var(--sans);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim);
}

.group > summary {
    cursor: pointer;
}

.group > summary::before {
    content: "+ ";
    font-family: var(--mono);
}

.group[open] > summary::before {
    content: "− ";
}

.group > .hint,
.group .actions {
    margin: 8px 0;
}

.rules th,
.rules td {
    vertical-align: top;
}

.rules input[type="text"] {
    width: 9ch;
    padding: 3px 6px;
}

.rules select {
    width: auto;
    padding: 3px 6px;
}

.fare {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin: 0 0 6px;
}

.asset-input {
    max-width: 72ch;
}

.rules input.asset-input {
    width: 30ch;
}

.rules input[name="percent"] {
    width: 6ch;
}

.fare__actions {
    display: inline-flex;
    gap: 6px;
}

.help > summary {
    cursor: pointer;
    color: var(--text-dim);
    font: 600 11px/1.4 var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.help dl {
    margin: 8px 0 0;
    max-width: 96ch;
}

.help dt {
    margin: 10px 0 4px;
    color: var(--text-dim);
    font: 600 10.5px/1.4 var(--sans);
    letter-spacing: 0.1em;
    text-transform: uppercase;
}

.help dd {
    margin: 0 0 6px;
    color: var(--text-dim);
    font: 400 12.5px/1.5 var(--sans);
}

.help dd b {
    color: var(--text);
    font-weight: 600;
}

#service td {
    white-space: normal;
    vertical-align: top;
}

#service td.value {
    word-break: break-all;
}

.warn,
.hint.warn {
    margin: 0 0 6px;
    color: var(--accent);
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
select,
textarea {
    width: 100%;
    padding: 6px 8px;
    background: #0c0e11;
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: 2px;
    font: 400 13px/1.4 var(--mono);
}

input[type="text"]:hover,
select:hover,
textarea:hover {
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
}

input[type="checkbox"],
input[type="radio"] {
    accent-color: var(--accent);
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}

button,
.button {
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

.button {
    display: inline-block;
    text-decoration: none;
    white-space: nowrap;
}

.button:hover,
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

.note details {
    margin-top: 2px;
    color: var(--text-faint);
    font-size: 11px;
}

.note summary {
    cursor: pointer;
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

// Readiness blockers and warnings by meaning, one sentence each. A code missing here is shown raw.
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
    [
        "The Arkade server reports a unilateral exit delay the Taxi cannot use.",
        "provider_exit_delay_invalid",
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
        "This network's coins outlive TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS by less than 12 hours, so renewing them would cost a fee again and again. Renewal is stopped and nothing is lent until you lower TAXI_VTXO_RENEWAL_THRESHOLD_SECONDS to at least 12 hours below the network's VTXO lifetime.",
        "renewal_threshold_exceeds_vtxo_lifetime",
    ],
    [
        "A wallet settlement has waited over an hour for an Arkade batch, so the coins it spends stay locked. Restarting the Taxi cancels a stuck background settlement.",
        "operator_intent_stale",
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
        "A payment's coin was moved on-chain, so it can no longer be claimed, refunded or recovered off-chain." +
            ATTENTION,
        "covenant_unrolled",
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
            "proceeds_reservation_changed proceeds_intent_inputs_changed",
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
    assetId: "asset",
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
    [/Expected object, received null/, () => "is missing"],
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
            "The console could not tell who you are: the proxy in front of it must send the operator header" +
            (/ is required$/.test(error.message)
                ? "; or set TAXI_ADMIN_OPERATOR on the Taxi itself."
                : ".");
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
}

function renderWarnings(warnings) {
    const list = $("readiness-warnings");
    list.textContent = "";
    list.hidden = warnings.length === 0;
    for (const { advanceId, code } of warnings) {
        const item = cell("li", blockerText(code));
        item.append(cell("code", code), cell("code", advanceId));
        list.append(item);
    }
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
    const assets = rules.filter((rule) => rule.assetId !== null && rule.assetId !== "*").length;
    const parts = [
        ...(rules.some((rule) => rule.assetId === null) ? ["small bitcoin payments"] : []),
        ...(assets ? [assets + (assets === 1 ? " asset" : " assets")] : []),
        ...(rules.some((rule) => rule.assetId === "*")
            ? [assets ? "any other asset" : "any asset"]
            : []),
    ];
    const last = parts.pop();
    return parts.length ? parts.join(", ") + " and " + last : last;
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
const PERCENT = /^[0-9]+(\\.[0-9]{1,2})?$/;

const CLAIM_SUMMARY = {
    recycle: "When a receiver claims, they repay the lent sats, so your Taxi gets them back.",
    purchase: "When a receiver claims, they keep the lent sats; the fare is all your Taxi earns.",
    either: "Each payer chooses whether the receiver repays the lent sats; without a choice, they do.",
};

const GIVEAWAY =
    "Payers could take the carrier sats for free; you would pay every carrier yourself.";

const isZero = (units) => /^0*$/.test(String(units));

// A fare a payer can bring to 0: flat 0, or a percentage with no minimum of a
// base they can shrink. An asset fare's base is the amount sent; a sats fare's
// is the loan, which is the whole dust for an asset and down to vtxoMinAmount
// for bitcoin.
function canBeFree(rule, fare) {
    const p = fare.pricing;
    if (p.kind === "flat") return isZero(p.units);
    if (!isZero(p.minUnits)) return false;
    if (fare.currency.kind !== "sats") return p.bps < 10000;
    const status = view.status || {};
    return (
        p.bps * Number((rule.assetId === null ? status.vtxoMinAmount : status.dust) || 1) < 10000
    );
}

// A purchased carrier is never repaid, so a free fare under purchase or either
// hands the payer the Taxi's sats.
function giveaways(rules) {
    return rules.filter(
        (rule) =>
            rule.enabled &&
            rule.claim !== "recycle" &&
            rule.fares.some((fare) => canBeFree(rule, fare)),
    );
}

const assetLines = () =>
    $("wiz-assets")
        .value.split("\\n")
        .map((line) => line.trim())
        .filter(Boolean);

function openWizard() {
    if (!view.status)
        return setNote("setup-note", "The console has not reached the Taxi yet.", true);
    Object.assign(wizard, { step: 1, size: "small", fare: "free", claim: "recycle" });
    $("wiz-btc").checked = true;
    $("wiz-any").checked = false;
    $("wiz-fare-asset").checked = false;
    $("wiz-giveaway-ok").checked = false;
    for (const id of [
        "wiz-assets",
        "wiz-per-payment",
        "wiz-outstanding",
        "wiz-concurrent",
        ...Object.values(FARE_FIELDS.sats).slice(0, 4),
        ...Object.values(FARE_FIELDS.asset).slice(0, 4),
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
    $("wiz-fare-asset-row").hidden =
        wizard.fare === "free" || (assetLines().length === 0 && !$("wiz-any").checked);
    $("wiz-asset-flat-fields").hidden = !wantsAssetFare() || wizard.fare !== "flat";
    $("wiz-asset-percent-fields").hidden = !wantsAssetFare() || wizard.fare !== "percent";
    $("wiz-fare-btc-warn").hidden = wizard.fare === "free" || !$("wiz-btc").checked;
    $("wiz-giveaway").hidden =
        wizard.step !== 3 || giveaways(wizardPatch().assetRules).length === 0;
    setNote("wiz-note", "", false);
}

function wizardProblem() {
    if (wizard.step === 1) {
        const lines = assetLines();
        const bad = lines.find((line) => !parseAssetId(line));
        if (bad) return '"' + bad + '" is not an asset id. ' + ASSET_ID_HELP;
        if (new Set(lines.map((line) => assetKey(parseAssetId(line)))).size < lines.length)
            return "An asset is listed twice.";
        if (!$("wiz-btc").checked && !$("wiz-any").checked && lines.length === 0)
            return "Choose small bitcoin payments, any asset, or at least one specific asset.";
    }
    if (wizard.step === 2 && wizard.size === "custom") {
        const limits = ["wiz-per-payment", "wiz-outstanding", "wiz-concurrent"];
        if (!limits.every((id) => WHOLE.test($(id).value.trim()) && $(id).value.trim() !== "0"))
            return "Each limit is a whole number above 0.";
    }
    if (wizard.step === 3) {
        const asset = wantsAssetFare() && pricingProblem(FARE_FIELDS.asset);
        const problem = pricingProblem(FARE_FIELDS.sats) || (asset && "Asset fare: " + asset);
        if (problem) return problem;
        if (giveaways(wizardPatch().assetRules).length && !$("wiz-giveaway-ok").checked)
            return 'To go on, tick "Give carriers away for free", set a fare that cannot come to 0, or get your sats back when the receiver claims.';
    }
    return null;
}

const FARE_FIELDS = {
    sats: {
        flat: "wiz-fare-flat-sats",
        pct: "wiz-fare-pct",
        min: "wiz-fare-min",
        max: "wiz-fare-max",
        unit: "sats",
    },
    asset: {
        flat: "wiz-asset-flat-units",
        pct: "wiz-asset-pct",
        min: "wiz-asset-min",
        max: "wiz-asset-max",
        unit: "units",
    },
};

const field = (id) => $(id).value.trim();

const wantsAssetFare = () =>
    wizard.fare !== "free" &&
    $("wiz-fare-asset").checked &&
    (assetLines().length > 0 || $("wiz-any").checked);

function pricingProblem(f) {
    if (wizard.fare === "flat" && !WHOLE.test(field(f.flat)))
        return "The flat fare is a whole number of " + f.unit + ".";
    if (wizard.fare !== "percent") return null;
    const min = field(f.min) || "0";
    const max = field(f.max);
    if (!PERCENT.test(field(f.pct)) || Number(field(f.pct)) > 100)
        return "The percentage is a number from 0 to 100, at most two decimals.";
    if (!WHOLE.test(min) || (max && (!WHOLE.test(max) || BigInt(max) < BigInt(min))))
        return (
            "The minimum and maximum are whole numbers of " +
            f.unit +
            ", the maximum not below the minimum."
        );
    return null;
}

function wizardPricing(f) {
    if (wizard.fare === "free") return { kind: "flat", units: "0" };
    if (wizard.fare === "flat") return { kind: "flat", units: field(f.flat) };
    return {
        kind: "proportional",
        bps: Math.round(Number(field(f.pct)) * 100),
        minUnits: field(f.min) || "0",
        maxUnits: field(f.max) || null,
    };
}

function wizardFares(isAsset) {
    const fares = [
        { id: "sats", currency: { kind: "sats" }, pricing: wizardPricing(FARE_FIELDS.sats) },
    ];
    if (isAsset && wantsAssetFare())
        fares.push({
            id: "asset",
            currency: { kind: "sameAsset" },
            pricing: wizardPricing(FARE_FIELDS.asset),
        });
    return fares;
}

function fareText(pricing, unit, base) {
    if (pricing.kind === "flat") return group(pricing.units) + " " + unit;
    return (
        pricing.bps / 100 +
        "% of " +
        base +
        ", at least " +
        group(pricing.minUnits) +
        " " +
        unit +
        (pricing.maxUnits === null ? "" : " and at most " + group(pricing.maxUnits) + " " + unit)
    );
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
            ...($("wiz-any").checked ? [rule("*")] : []),
            ...assetLines().map((line) => rule(parseAssetId(line))),
        ],
    };
}

function wizardSummary(patch) {
    const fares = (patch.assetRules.find((rule) => rule.fares.length > 1) || patch.assetRules[0])
        .fares;
    const [sats, asset] = fares.map((fare) => fare.pricing);
    const fare =
        wizard.fare === "free"
            ? "Payers pay no fare."
            : "Each payment pays " +
              (sats.kind === "flat" ? "a fare of " : "") +
              fareText(sats, "sats", "the sats lent") +
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
        ...(asset
            ? [
                  "Asset payments may instead pay " +
                      fareText(asset, "units", "the amount they send") +
                      (asset.kind === "flat" ? " of the asset they send." : "."),
              ]
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

        const phase = cell("td", a.recoveryPhase || a.submissionPhase || "observing", "dim");
        if (a.failureCode)
            phase.append(
                cell(
                    "div",
                    a.failureCode + (a.failureDetail ? ": " + a.failureDetail : ""),
                    "warn",
                ),
            );

        tr.append(
            id,
            state,
            cell("td", group(a.topup), "n"),
            cell("td", group(a.fare.units), "n dim"),
            cell("td", group(a.locktime), due ? "n due" : "n"),
            cell("td", duration(a.ageSeconds * 1000), "n dim"),
            phase,
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
    $("rules-giveaway-ok").checked = false;
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
    id === null
        ? "Bitcoin"
        : id === "*"
          ? "Any asset"
          : walletAssetId(id).slice(0, 8) + "…" + walletAssetId(id).slice(-8);

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

const FARE_ID = { sats: "sats", sameAsset: "asset", token: "token" };

function fareId(fares, kind) {
    let id = FARE_ID[kind];
    for (let n = 2; fares.some((f) => f.id === id); n++) id = FARE_ID[kind] + "-" + n;
    return id;
}

const newFare = (fares, kind = "sats") => ({
    id: fareId(fares, kind),
    currency: { kind },
    pricing: { kind: "flat", units: "0" },
});

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
    renderGiveaway();
}

function renderGiveaway() {
    const free = giveaways(view.rules);
    $("rules-giveaway").hidden = free.length === 0;
    $("rules-giveaway-which").textContent = free.length
        ? "Affects: " + free.map((rule) => assetLabel(rule.assetId)).join(", ") + "."
        : "";
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
        if (!/^[0-9]+(\\.[0-9]{1,2})?$/.test(text) || Number(text) > 100) {
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

const CURRENCIES = [
    ["sats", "in sats"],
    ["sameAsset", "in the asset"],
    ["token", "in a token"],
];

const PRICINGS = [
    ["flat", "flat"],
    ["proportional", "percent"],
];

function fareIdInput(rule, fare) {
    const input = control("input", "id", "Id of fare " + fare.id);
    input.type = "text";
    input.value = fare.id;
    input.addEventListener("change", () => {
        const id = input.value.trim();
        if (!id || rule.fares.some((f) => f !== fare && f.id === id)) {
            input.value = fare.id;
            return setNote("policy-note", "Each fare in a rule needs an id of its own.", true);
        }
        editRules(() => (fare.id = id));
    });
    return input;
}

function tokenInput(fare) {
    const input = control("input", "token", "Asset id of the token fare " + fare.id);
    input.type = "text";
    input.className = "asset-input";
    input.placeholder = "token asset id";
    const show = () =>
        (input.value = fare.currency.assetId ? walletAssetId(fare.currency.assetId) : "");
    show();
    input.addEventListener("change", () => {
        const id = parseAssetId(input.value);
        if (id) editRules(() => (fare.currency.assetId = id));
        else setNote("policy-note", ASSET_ID_HELP, true);
        show();
    });
    return input;
}

function fareEditor(rule, fare, index) {
    const line = cell("div", "", "fare");
    line.append(fareIdInput(rule, fare));
    if (index === 0) line.append(cell("span", "default", "state-tag"));
    const remove = control("button", "remove-fare", "Remove fare " + fare.id);
    remove.textContent = "Remove";
    remove.addEventListener("click", () =>
        editRules(() => rule.fares.splice(rule.fares.indexOf(fare), 1), true),
    );
    const unit = fare.currency.kind === "sats" ? "sats" : "units";
    // A bitcoin payment has no asset to take a same-asset fare in.
    const currencies = CURRENCIES.filter(
        ([kind]) => kind !== "sameAsset" || rule.assetId !== null || fare.currency.kind === kind,
    );
    const currency = choice("currency", currencies, fare.currency.kind, "Fare currency");
    currency.addEventListener("change", () =>
        editRules(() => {
            const kind = currency.value;
            if (/^(sats|asset|token)(-[0-9]+)?$/.test(fare.id))
                fare.id = fareId(
                    rule.fares.filter((f) => f !== fare),
                    kind,
                );
            fare.currency = kind === "token" ? { kind, assetId: null } : { kind };
            if (kind === "token" && fare.pricing.kind !== "flat")
                fare.pricing = { kind: "flat", units: "0" };
        }, true),
    );
    line.append(currency);
    if (fare.currency.kind === "token") line.append(tokenInput(fare));
    const pricing = choice(
        "pricing",
        fare.currency.kind === "token" ? PRICINGS.slice(0, 1) : PRICINGS,
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
    const move = (by, text) => {
        const button = control("button", by < 0 ? "fare-up" : "fare-down", text + fare.id);
        button.textContent = by < 0 ? "↑" : "↓";
        button.disabled = !rule.fares[index + by];
        button.addEventListener("click", () =>
            editRules(() => rule.fares.splice(index + by, 0, rule.fares.splice(index, 1)[0]), true),
        );
        return button;
    };
    const actions = cell("span", "", "fare__actions");
    actions.append(move(-1, "Offer earlier: fare "), move(1, "Offer later: fare "), remove);
    line.append(actions);
    return line;
}

function renderRules() {
    const body = $("rules-body");
    body.textContent = "";
    view.rules.forEach((rule, index) => {
        const label = assetLabel(rule.assetId);
        const asset = cell("th", label);
        asset.scope = "row";
        if (rule.assetId && rule.assetId !== "*") asset.title = walletAssetId(rule.assetId);

        const on = control("input", "enabled", "Carry " + label);
        on.type = "checkbox";
        on.checked = rule.enabled;
        on.addEventListener("change", () => editRules(() => (rule.enabled = on.checked)));

        const fares = document.createElement("td");
        rule.fares.forEach((fare, i) => fares.append(fareEditor(rule, fare, i)));
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
    renderGiveaway();
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
    renderWarnings(status.warnings);
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

const CONFIG_MEANINGS = {
    httpPort: "The public port wallets call.",
    adminPort: "The port serving this console; keep it behind the authenticating proxy.",
    adminOperator:
        "The name recorded for a console change when the proxy forwards no operator identity.",
    dbPath: "The SQLite file holding the ledger; it must survive restarts.",
    arkdUrl: "The Arkade server the Taxi works with.",
    indexerUrl: "Where the Taxi reads coins: the same Arkade server's indexer.",
    emulatorUrl: "The emulator that co-signs every claim, refund and recovery.",
    publicArkdUrl:
        "The Arkade endpoint clients connect to; defaults to the Taxi's internal endpoint.",
    publicEmulatorUrl:
        "The emulator endpoint clients connect to; defaults to the Taxi's internal endpoint.",
    operatorMinReserveSats: "Sats the Taxi always keeps; it lends only what is above them.",
    minExpiryHeadroomBlocks:
        "The Taxi lends only coins with at least this many blocks left before they expire.",
    recoveryBroadcastBlocks:
        "Blocks the Taxi allows to recover lent sats: this close to expiry a payment raises a warning, and the locktime margin must be larger.",
    recoveryCriticalBlocks:
        "This close to expiry, in blocks, a recovery deadline is critical and new payments pause.",
    minExpiryHeadroomSeconds:
        "The Taxi lends only coins with at least this many seconds left before they expire.",
    recoveryBroadcastSeconds:
        "Seconds the Taxi allows to recover lent sats, for coins that expire at a time.",
    recoveryCriticalSeconds:
        "This close to expiry, in seconds, a recovery deadline is critical and new payments pause.",
    vtxoRenewalThresholdSeconds:
        "This close to expiry, in seconds, the wallet renews a coin, and the Taxi lends none; keep it 12 hours below the network's VTXO lifetime.",
    reconcileIntervalMs:
        "How often, in milliseconds, the Taxi re-checks its wallet and the Arkade server and runs recovery; an older check stops new quotes.",
    proceedsMaxFeeSats:
        "The most the Taxi pays in fees to collect its fares and repayments; at 0 it never pays one.",
    logLevel: "How much the Taxi writes to its logs.",
    operatorKey: "Where repayments and fares are paid: the Taxi wallet's output key.",
    operatorSignerKey: "The public key of TAXI_OPERATOR_PRIVKEY, which signs the Taxi's own coins.",
    networkName: "The network the Arkade server reports.",
    esploraUrl: "The configured chain explorer, or the Arkade SDK default for this network.",
    serverPubkey: "The Arkade server's signing key, pinned at startup.",
    emulatorPubkey: "The emulator key the Arkade SDK pins for this network.",
    dust: "The network dust: the most one payment can borrow.",
    vtxoMinAmount: "The smallest coin the Arkade server accepts, and the least a payment borrows.",
    addressHrp: "The prefix of Arkade addresses on this network.",
    exitDelay:
        "The Arkade server's unilateral exit delay, which a payment's emergency exit leaf waits out before it can be spent without the server.",
};

function renderServiceConfig(entries) {
    const body = $("service-config");
    body.textContent = "";
    for (const { key, env, value } of entries) {
        const name = cell("th", env || key + " (derived)");
        name.scope = "row";
        const amount = /^[0-9]+$/.test(value) && !key.endsWith("Port");
        const shown = value === null ? "not set" : amount ? group(value) : value;
        const tr = document.createElement("tr");
        tr.append(name, cell("td", shown, "value"), cell("td", CONFIG_MEANINGS[key] || "", "dim"));
        body.append(tr);
    }
    $("service-config-empty").hidden = entries.length > 0;
}

async function loadServiceConfig() {
    try {
        renderServiceConfig((await api("/admin/api/config")).config);
    } catch (e) {
        $("service-config-empty").textContent = explain(e).text;
    }
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
    $("rule-add-any").addEventListener("click", () => {
        if (view.rules.some((r) => r.assetId === "*"))
            return setNote("policy-note", "Any asset already has a rule.", true);
        editRules(() => view.rules.push(newRule("*")), true);
    });
    $("rule-add-asset").addEventListener("click", () => {
        const id = parseAssetId($("rule-asset").value);
        if (!id) return setNote("policy-note", ASSET_ID_HELP, true);
        if (
            view.rules.some(
                (r) =>
                    typeof r.assetId === "object" &&
                    r.assetId &&
                    assetKey(r.assetId) === assetKey(id),
            )
        )
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
        if (
            patch.assetRules &&
            giveaways(patch.assetRules).length &&
            !$("rules-giveaway-ok").checked
        )
            return setNote("policy-note", GIVEAWAY, true);
        mutate(() => patchPolicy(patch), "policy-note");
    });

    $("wizard-open").addEventListener("click", openWizard);
    $("wiz-cancel").addEventListener("click", () => $("wizard").close());
    $("wiz-back").addEventListener("click", () => wizardMove(-1));
    $("wiz-next").addEventListener("click", () => wizardMove(1));
    $("wiz-save").addEventListener("click", () => saveWizard(false));
    $("wiz-save-live").addEventListener("click", () => saveWizard(true));
    $("wiz-btc").addEventListener("change", renderWizard);
    $("wiz-any").addEventListener("change", renderWizard);
    $("wiz-fare-asset").addEventListener("change", renderWizard);
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
loadServiceConfig();
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
