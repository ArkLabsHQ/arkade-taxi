import { createServer, request as httpRequest } from "node:http";

export async function createFailureProxy(targets) {
    let rules = [];
    let nextRuleId = 0;
    const events = [];
    const submissionCounts = { arkd: 0, emulator: 0 };
    const paused = new Map();
    const sockets = new Set();
    const record = (event) => {
        const recorded = { at: Date.now(), ...event };
        if (event.action === "forwarded" && event.method === "POST") {
            if (event.target === "arkd" && event.path === "/v1/tx/submit") submissionCounts.arkd++;
            else if (event.target === "emulator" && event.path === "/v1/tx")
                submissionCounts.emulator++;
        }
        events.push(recorded);
        if (events.length > 30000) events.shift();
        return recorded;
    };
    const reset = (ruleId) => {
        if (ruleId !== undefined && (!Number.isInteger(ruleId) || ruleId < 1))
            throw new Error("invalid failure proxy rule ID");
        rules = rules.filter((rule) => ruleId !== undefined && rule.id !== ruleId);
        for (const [resume, id] of paused) {
            if (ruleId !== undefined && id !== ruleId) continue;
            paused.delete(resume);
            resume();
        }
    };
    const server = createServer((request, response) => {
        const [target, ...parts] = request.url.slice(1).split("/");
        if (!Object.hasOwn(targets, target)) {
            response.writeHead(404).end();
            return;
        }
        const path = `/${parts.join("/")}`;
        const rule = rules.find(
            (item) =>
                item.target === target &&
                path.startsWith(item.path) &&
                (!item.method || item.method === request.method) &&
                Object.entries(item.query ?? {}).every(([key, value]) =>
                    new URL(path, "http://proxy").searchParams.getAll(key).includes(value),
                ),
        );
        if (rule?.mode === "drop" && rule.once !== false)
            rules = rules.filter((item) => item !== rule);
        const forwarded = record({
            target,
            path: path.split("?")[0],
            method: request.method,
            action: "forwarded",
        });
        response.once("finish", () => (forwarded.clientFinishAt = Date.now()));
        response.once("close", () => {
            if (!response.writableFinished) forwarded.clientAbortAt = Date.now();
        });
        const send = () => {
            const upstream = httpRequest(
                `${targets[target].replace(/\/$/, "")}${path}`,
                {
                    method: request.method,
                    headers: { ...request.headers, host: new URL(targets[target]).host },
                },
                (result) => {
                    forwarded.responseStatus = result.statusCode;
                    forwarded.responseAt = Date.now();
                    result.once("end", () => (forwarded.responseEndAt = Date.now()));
                    result.once("aborted", () => (forwarded.responseAbortedAt = Date.now()));
                    const forward = () => {
                        response.writeHead(result.statusCode, result.headers);
                        result.pipe(response);
                    };
                    if (rule?.mode === "drop") {
                        result.resume();
                        result.on("end", () => {
                            record({
                                target,
                                path: path.split("?")[0],
                                action: "dropped",
                                status: result.statusCode,
                                ruleId: rule.id,
                            });
                            response.destroy();
                        });
                    } else if (
                        rule?.mode === "identity" ||
                        (rule?.mode === "projection-lag" && result.statusCode === 200)
                    ) {
                        const chunks = [];
                        result.on("data", (chunk) => chunks.push(chunk));
                        result.on("end", () => {
                            try {
                                const body = JSON.parse(Buffer.concat(chunks).toString());
                                if (rule.mode === "identity")
                                    body.signerPubkey = "03" + "22".repeat(32);
                                else {
                                    if (!Array.isArray(body.vtxos))
                                        throw new Error("invalid indexer response");
                                    body.vtxos = [];
                                }
                                response.writeHead(result.statusCode, {
                                    "content-type": "application/json",
                                });
                                response.end(JSON.stringify(body));
                                record({
                                    target,
                                    path: path.split("?")[0],
                                    action:
                                        rule.mode === "identity"
                                            ? "identity"
                                            : "projection-delayed",
                                    ruleId: rule.id,
                                });
                            } catch {
                                response.destroy();
                            }
                        });
                    } else if (rule?.mode === "pause" && rule.phase !== "request") {
                        result.pause();
                        paused.set(forward, rule.id);
                        result.on("close", () => paused.delete(forward));
                        record({
                            target,
                            path: path.split("?")[0],
                            action: "paused",
                            ruleId: rule.id,
                        });
                    } else forward();
                    response.on("close", () => result.destroy());
                },
            );
            upstream.on("error", () => response.destroy());
            response.on("close", () => upstream.destroy());
            request.pipe(upstream);
        };
        if (rule?.mode === "pause" && rule.phase === "request") {
            request.pause();
            paused.set(send, rule.id);
            response.on("close", () => paused.delete(send));
            record({ target, path: path.split("?")[0], action: "request-paused", ruleId: rule.id });
        } else send();
    });
    server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        configure(rule) {
            if (
                !Object.hasOwn(targets, rule.target) ||
                !["drop", "pause", "identity", "projection-lag"].includes(rule.mode) ||
                (rule.once !== undefined && typeof rule.once !== "boolean") ||
                typeof rule.path !== "string" ||
                !rule.path.startsWith("/")
            )
                throw new Error("invalid failure proxy rule");
            if (
                rule.mode === "projection-lag" &&
                (rule.target !== "arkd" ||
                    rule.path !== "/v1/indexer/vtxos" ||
                    rule.method !== "GET" ||
                    Object.keys(rule.query ?? {}).length !== 1 ||
                    typeof rule.query?.outpoints !== "string" ||
                    !/^[0-9a-f]{64}:[0-9]+$/.test(rule.query.outpoints))
            )
                throw new Error("invalid projection lag rule");
            const id = ++nextRuleId;
            rules.push({ ...rule, id });
            return id;
        },
        reset,
        events,
        get submissionCounts() {
            return { ...submissionCounts };
        },
        close: () =>
            new Promise((resolve) => {
                reset();
                for (const socket of sockets) socket.destroy();
                server.close(resolve);
            }),
    };
}
