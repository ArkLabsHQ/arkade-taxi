import { expect, it } from "vitest";
import { assertTaxiRestartOwnership } from "../lib/taxi-restart.mjs";

const project = "taxi12-123456789abc";
const fixture = () => ({
    container: {
        Name: `/${project}-taxi`,
        Config: { Labels: { "dev.arkade-taxi.e2e-project": project }, Image: "sha256:taxi" },
        Image: "sha256:taxi",
        Mounts: [{ Type: "volume", Name: `${project}-taxi-data`, Destination: "/data" }],
        NetworkSettings: {
            Networks: { [`${project}_default`]: {} },
            Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49123" }] },
        },
    },
    volume: { Name: `${project}-taxi-data`, Labels: { "dev.arkade-taxi.e2e-project": project } },
    image: { Id: "sha256:taxi", Config: { Labels: { "dev.arkade-taxi.e2e-project": project } } },
});

it("preserves the inspected loopback port and named data volume for Taxi alone", () => {
    const f = fixture();
    expect(assertTaxiRestartOwnership(f.container, f.volume, f.image, project)).toEqual({
        port: 49123,
    });
});

it.each(["container", "volume", "image", "network", "mount", "binding"])(
    "refuses restart when the %s belongs outside the exact run",
    (field) => {
        const f = fixture();
        if (field === "container")
            f.container.Config.Labels["dev.arkade-taxi.e2e-project"] = "arkade-regtest";
        if (field === "volume") f.volume.Labels["dev.arkade-taxi.e2e-project"] = "arkade-regtest";
        if (field === "image")
            f.image.Config.Labels["dev.arkade-taxi.e2e-project"] = "arkade-regtest";
        if (field === "network") f.container.NetworkSettings.Networks = { arkade_regtest: {} };
        if (field === "mount") f.container.Mounts[0].Name = "arkade-regtest-data";
        if (field === "binding")
            f.container.NetworkSettings.Ports["8080/tcp"][0].HostIp = "0.0.0.0";
        expect(() => assertTaxiRestartOwnership(f.container, f.volume, f.image, project)).toThrow(
            /ownership/,
        );
    },
);
