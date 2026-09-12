import { createServer, request as httpRequest } from "node:http";

export async function createFailureProxy(targets) {
    let rules = [];
    const events = [];
    const paused = new Set();
    const sockets = new Set();
    const record = (event) => {
        events.push({ at: Date.now(), ...event });
        if (events.length > 10000) events.shift();
    };
    const reset = () => {
        rules = [];
        for (const resume of paused) resume();
        paused.clear();
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
        if (rule?.mode === "drop") rules = rules.filter((item) => item !== rule);
        record({ target, path: path.split("?")[0], method: request.method, action: "forwarded" });
        const send = () => {
            const upstream = httpRequest(
                `${targets[target].replace(/\/$/, "")}${path}`,
                {
                    method: request.method,
                    headers: { ...request.headers, host: new URL(targets[target]).host },
                },
                (result) => {
                    const forward = () => {
                        response.writeHead(result.statusCode, result.headers);
                        result.pipe(response);
                    };
                    if (rule?.mode === "drop") {
                        result.resume();
                        result.on("end", () => {
                            record({ target, path, action: "dropped", status: result.statusCode });
                            response.destroy();
                        });
                    } else if (rule?.mode === "identity") {
                        const chunks = [];
                        result.on("data", (chunk) => chunks.push(chunk));
                        result.on("end", () => {
                            try {
                                const body = JSON.parse(Buffer.concat(chunks).toString());
                                body.signerPubkey = "03" + "22".repeat(32);
                                response.writeHead(result.statusCode, {
                                    "content-type": "application/json",
                                });
                                response.end(JSON.stringify(body));
                                record({ target, path, action: "identity" });
                            } catch {
                                response.destroy();
                            }
                        });
                    } else if (rule?.mode === "pause" && rule.phase !== "request") {
                        result.pause();
                        paused.add(forward);
                        result.on("close", () => paused.delete(forward));
                        record({ target, path: path.split("?")[0], action: "paused" });
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
            paused.add(send);
            response.on("close", () => paused.delete(send));
            record({ target, path: path.split("?")[0], action: "request-paused" });
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
                !["drop", "pause", "identity"].includes(rule.mode) ||
                typeof rule.path !== "string" ||
                !rule.path.startsWith("/")
            )
                throw new Error("invalid failure proxy rule");
            rules.push({ ...rule });
        },
        reset,
        events,
        close: () =>
            new Promise((resolve) => {
                reset();
                for (const socket of sockets) socket.destroy();
                server.close(resolve);
            }),
    };
}
