export function assertTaxiRestartOwnership(container, volume, image, project) {
    const label = "dev.arkade-taxi.e2e-project";
    const bindings = container.NetworkSettings?.Ports?.["8080/tcp"];
    const networks = Object.keys(container.NetworkSettings?.Networks ?? {});
    const mounts = container.Mounts ?? [];
    const dataMount = mounts.find((mount) => mount.Destination === "/data");
    const bridgeMount = mounts.find((mount) => mount.Destination === "/app/e2e-esplora-bridge.mjs");
    const port = Number(bindings?.[0]?.HostPort);
    if (
        !/^taxi12-[a-f0-9]{12}$/.test(project) ||
        container.Name !== `/${project}-taxi` ||
        container.Config?.Labels?.[label] !== project ||
        volume.Name !== `${project}-taxi-data` ||
        volume.Labels?.[label] !== project ||
        image.Config?.Labels?.[label] !== project ||
        container.Image !== image.Id ||
        networks.length !== 1 ||
        networks[0] !== `${project}_default` ||
        mounts.length !== 2 ||
        dataMount?.Type !== "volume" ||
        dataMount.Name !== volume.Name ||
        bridgeMount?.Type !== "bind" ||
        bridgeMount.RW !== false ||
        bindings?.length !== 1 ||
        bindings[0].HostIp !== "127.0.0.1" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    )
        throw new Error("Taxi restart ownership verification failed");
    return { port };
}
