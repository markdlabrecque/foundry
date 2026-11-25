// Integration tier: socket-file lifecycle and permissions on a real Unix socket. The stale
// socket is left by a really killed process, since only that leaves a file nobody answers on.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ManagementSocketError, serveManagementApi, SlotsError } from "@foundry/daemon";
import type { ManagementApi, SlotsReader } from "@foundry/daemon";
import { managementSocketPath, STATUS_PATH } from "@foundry/protocol/management-api";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-api-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  return root;
};

const status = { instance: { stateRoot: "/fixture", daemonPid: 4242, startedAt: "2026-01-01T00:00:00.000Z" } };

const serve = async (stateRoot: string): Promise<ManagementApi> => {
  const api = await serveManagementApi({ stateRoot, status: () => status });
  cleanups.push(() => api.close());

  return api;
};

const get = (socketPath: string, path: string): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
    });

    req.on("error", reject);
    req.end();
  });

const refusal = async (start: Promise<unknown>): Promise<ManagementSocketError> => {
  try {
    await start;
  } catch (error) {
    if (error instanceof ManagementSocketError) {return error;}

    throw error;
  }

  throw new Error("expected serving to be refused");
};

/** Leaves a socket file at `path` whose listener was killed, as a crashed daemon would. */
const leaveStaleSocket = (path: string): void => {
  const script = `require("node:net").createServer().listen(process.argv[1], () => process.kill(process.pid, "SIGKILL"))`;
  const result = spawnSync(process.execPath, ["-e", script, path], { timeout: 10_000 });
  expect(result.signal).toBe("SIGKILL");
  expect(lstatSync(path).isSocket()).toBe(true);
};

test("status is served in the envelope on an owner-only socket, which close removes", async () => {
  const root = tempRoot();
  const api = await serve(root);
  expect(lstatSync(api.socketPath).mode & 0o777).toBe(0o600);

  expect(await get(api.socketPath, STATUS_PATH)).toEqual({ status: 200, body: { ok: true, result: status } });
  expect(await get(api.socketPath, "/api/v1/nope")).toMatchObject({
    status: 404,
    body: { ok: false, error: { code: "not_found" } },
  });

  await api.close();
  expect(() => lstatSync(api.socketPath)).toThrow(/ENOENT/);
});

test("a stale socket left by a dead daemon is replaced", async () => {
  const root = tempRoot();
  leaveStaleSocket(managementSocketPath(root));
  const api = await serve(root);
  expect((await get(api.socketPath, STATUS_PATH)).status).toBe(200);
});

test("a socket another daemon answers on is refused and left serving", async () => {
  const root = tempRoot();
  const first = await serve(root);
  expect((await refusal(serveManagementApi({ stateRoot: root, status: () => status }))).reason).toBe("in-use");
  expect((await get(first.socketPath, STATUS_PATH)).status).toBe(200);
});

test("a file that is not a socket is refused and never removed", async () => {
  const root = tempRoot();
  const path = managementSocketPath(root);
  writeFileSync(path, "operator data");
  expect((await refusal(serveManagementApi({ stateRoot: root, status: () => status }))).reason).toBe("not-a-socket");
  expect(readFileSync(path, "utf8")).toBe("operator data");
});

test("a factory path request with a malformed name answers 400; an unknown factory 404", async () => {
  const api = await serveManagementApi({ stateRoot: tempRoot(), status: () => status, clonePath: () => undefined });
  cleanups.push(() => api.close());
  expect(await get(api.socketPath, "/api/v1/factories/%E0%A4/path")).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_request" } } });
  expect(await get(api.socketPath, "/api/v1/factories/nope/path")).toMatchObject({ status: 404, body: { ok: false, error: { code: "not_found" } } });
});

test.each([
  ["a malformed slot address", "/api/v1/slots/Dev/0", 400, "bad_request"],
  ["an empty factory", "/api/v1/slots?factory=", 400, "bad_request"],
  ["an unknown factory", "/api/v1/slots?factory=nope", 404, "unknown_factory"],
  ["no factory with several loaded", "/api/v1/slots/dev/1", 400, "factory_required"],
  ["a slot the factory does not have", "/api/v1/slots/dev/9?factory=alpha", 404, "slot_not_found"],
])("the slot routes refuse %s with its code", async (_name, path, statusCode, code) => {
  const slots: SlotsReader = {
    list: async (factory) => {
      if (factory === "nope") {throw new SlotsError("unknown_factory", "no factory");}

      return { slots: [] };
    },
    show: async (_slotId, factory) => {
      throw factory === undefined ? new SlotsError("factory_required", "name one") : new SlotsError("slot_not_found", "no slot");
    },
  };

  const api = await serveManagementApi({ stateRoot: tempRoot(), status: () => status, slots });
  cleanups.push(() => api.close());
  expect(await get(api.socketPath, path)).toMatchObject({ status: statusCode, body: { ok: false, error: { code } } });
});

test("the slot routes answer 503 when the daemon serves no slots", async () => {
  const api = await serve(tempRoot());
  expect(await get(api.socketPath, "/api/v1/slots")).toMatchObject({ status: 503, body: { ok: false, error: { code: "unavailable" } } });
});
