// Integration tier: the ticket CLI core against an in-process management API over a real socket,
// store and ticket directory in a disposable temp dir. One smoke row runs the built binary to
// prove the effect/cli wiring of `ticket`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Effect, Exit, Scope } from "effect";
import { DATABASE_FILE_NAME, createTicketService, openStore, serveManagementApi } from "@foundry/daemon";
import {
  defaultTitle,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
  runTicketList,
  runTicketShow,
  runTicketSubmit,
} from "@foundry/cli";

const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-cli-tickets-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  return root;
};

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const run = (args: Array<string>): number | null =>
  spawnSync(process.execPath, [cliMain, ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 }).status;


const serve = async (home: string): Promise<void> => {
  const scope = await Effect.runPromise(Scope.make());
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const store = await Effect.runPromise(Scope.provide(scope)(openStore({ filename: join(home, DATABASE_FILE_NAME) })));
  const factories = [{ name: "shop", defaultLine: "standard", messageBudget: 100, lines: { standard: { rejectionLimit: 3 } } }];

  const api = await serveManagementApi({
    stateRoot: home,
    status: () => ({ instance: { stateRoot: home, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } }),
    tickets: createTicketService({ stateRoot: home, store, factories: () => factories }),
  });

  cleanups.push(() => api.close());
};

test("ticket submit copies the file into the ticket directory; list and show print it back", async () => {
  const home = tempRoot();
  await serve(home);
  const file = join(home, "reset.md");
  writeFileSync(file, "# Password reset\n\nBody\n");
  const common = { json: false, home, factory: undefined, env };

  const submitted = await runTicketSubmit({ ...common, file, title: undefined, line: undefined });
  expect(submitted.exitCode).toBe(EXIT_OK);
  expect(submitted.stdout).toContain("shop #1 password-reset");

  const list = await runTicketList(common);
  expect(list).toMatchObject({ exitCode: EXIT_OK, stdout: "shop #1  backlog  standard  Password reset\n" });

  const shown = await runTicketShow({ ...common, json: true, number: 1 });
  expect(shown.exitCode).toBe(EXIT_OK);
  const { ticket } = JSON.parse(shown.stdout).result;
  expect(readFileSync(ticket.specPath, "utf8")).toBe("# Password reset\n\nBody\n");

  const badLine = await runTicketSubmit({ ...common, file, title: "T", line: "nope" });
  expect(badLine.exitCode).toBe(EXIT_REFUSED);
  expect(badLine.stderr).toContain('No production line "nope"');
  expect((await runTicketShow({ ...common, number: 9 })).exitCode).toBe(EXIT_REFUSED);
});

test("titles default to the first heading, else the file name", () => {
  expect(defaultTitle("/x/a.md", "intro\n## Fix the login  ##\n")).toBe("Fix the login");
  expect(defaultTitle("/x/fix-login.md", "no heading")).toBe("fix-login");
  // PRD §8.3's generic top heading is skipped.
  expect(defaultTitle("/x/a.md", "# Specification\n\n# Password reset\n")).toBe("Password reset");
  expect(defaultTitle("/x/reset.md", "# Specification\n")).toBe("reset");
});

test("the foundry binary wires ticket commands: usage errors exit 2, no daemon exits 3", () => {
  const home = tempRoot();
  const file = join(home, "spec.md");
  writeFileSync(file, "# T\n");


  expect(run(["ticket", "show", "abc", "--home", home])).toBe(EXIT_USAGE);
  expect(run(["ticket", "submit", "--home", home])).toBe(EXIT_USAGE);
  expect(run(["ticket", "submit", join(home, "missing.md"), "--home", home])).toBe(EXIT_USAGE);
  expect(run(["ticket", "submit", file, "--home", home])).toBe(EXIT_UNREACHABLE);
  expect(run(["ticket", "list", "--home", home])).toBe(EXIT_UNREACHABLE);
});
