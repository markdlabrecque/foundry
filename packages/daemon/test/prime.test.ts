import { createHash } from "node:crypto";
import { Predicate } from "effect";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { composePrime, ComposePrimeResult } from "@foundry/daemon";
import type { Prime, PrimeRequest, ReadSource } from "@foundry/daemon";

// Unit tier for ordering and the header: composition is a function of the
// request and an injected reader. One integration test exercises the real
// filesystem read against a disposable temp dir (re-read on the next prime and
// a named missing file).

const sha = (text: string): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

const request = (overrides: Partial<PrimeRequest> = {}): PrimeRequest => ({
  address: "eng.dev",
  slotId: "slot-1",
  situation: "fresh",
  isolation: "none",
  instructions: ["/factory/factory.md", "/factory/rooms/eng.md", "/factory/roles/dev.md"],
  knowledgeRoot: "/factory/knowledge",
  baseDir: "/factory",
  ...overrides,
});

const memoryReader =
  (files: Record<string, string>): ReadSource =>
  async (path) => {
    const content = files[path];

    if (content === undefined) {throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });}

    return new TextEncoder().encode(content);
  };

const composed = (result: ComposePrimeResult): Prime => {
  if (!Predicate.isTagged(result, "Composed")) {throw new Error(JSON.stringify(result.problems));}

  return result.prime;
};

const FILES = {
  "/factory/factory.md": "FACTORY\n",
  "/factory/rooms/eng.md": "ROOM\n",
  "/factory/roles/dev.md": "STATION",
};

describe("composition", () => {
  test("parts keep factory → room → station order with relative sources and hashes", async () => {
    const prime = composed(await composePrime(request(), memoryReader(FILES)));
    expect(prime.parts.map(({ source, hash }) => ({ source, hash }))).toEqual([
      { source: "factory.md", hash: sha("FACTORY\n") },
      { source: "rooms/eng.md", hash: sha("ROOM\n") },
      { source: "roles/dev.md", hash: sha("STATION") },
    ]);
    const at = (needle: string): number => prime.text.indexOf(needle);
    expect(at("FACTORY")).toBeGreaterThan(-1);
    expect(at("FACTORY")).toBeLessThan(at("ROOM"));
    expect(at("ROOM")).toBeLessThan(at("STATION"));
    expect(prime.text).toContain(`<foundry-source path="rooms/eng.md" hash="${sha("ROOM\n")}">`);
  });

  test("header states address, slot, situation and both conventions before any instruction", async () => {
    const prime = composed(await composePrime(request({ situation: "recovery" }), memoryReader(FILES)));
    const header = prime.text.slice(0, prime.text.indexOf("<foundry-source"));
    expect(header).toContain("Address: eng.dev");
    expect(header).toContain("Slot: slot-1");
    expect(header).toContain("Situation: recovery");
    expect(header).toContain("writes only in the ticket directory");
    expect(header).toContain("do not write to the knowledge root (`/factory/knowledge`)");
  });

  test("situations share the same body and differ only in the situation line", async () => {
    const texts = await Promise.all(
      (["fresh", "recovery", "compaction"] as const).map(async (situation) =>
        composed(await composePrime(request({ situation }), memoryReader(FILES))).text,
      ),
    );

    const withoutSituation = texts.map((text) => text.replace(/^Situation: .*$/m, ""));
    expect(new Set(withoutSituation).size).toBe(1);
    expect(new Set(texts).size).toBe(3);
  });

  test("every missing source is named, in order, and no prime is returned", async () => {
    const result = await composePrime(request(), memoryReader({ "/factory/rooms/eng.md": "ROOM" }));
    expect(result._tag).toBe("SourceUnavailable");

    if (!Predicate.isTagged(result, "SourceUnavailable")) {return;}

    expect(result.problems.map(({ path, source, reason }) => ({ path, source, reason }))).toEqual([
      { path: "/factory/factory.md", source: "factory.md", reason: "missing" },
      { path: "/factory/roles/dev.md", source: "roles/dev.md", reason: "missing" },
    ]);
  });
});

describe("source bytes", () => {
  const reader =
    (read: () => Promise<Uint8Array>): ReadSource =>
    () =>
      read();

  test("the hash covers the raw bytes, including a byte-order mark the content drops", async () => {
    const bytes = new TextEncoder().encode("\uFEFFX");

    const prime = composed(
      await composePrime(request({ instructions: ["/factory/factory.md"] }), reader(async () => bytes)),
    );

    expect(prime.parts).toEqual([
      {
        source: "factory.md",
        hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        content: "X",
      },
    ]);
  });

  test("a source that exists but cannot be read is reported as unreadable", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

    const result = await composePrime(
      request({ instructions: ["/factory/factory.md"] }),
      reader(async () => {
        throw denied;
      }),
    );

    expect(result).toMatchObject(
      ComposePrimeResult.SourceUnavailable({
      problems: [expect.objectContaining({ path: "/factory/factory.md", source: "factory.md", reason: "unreadable" })],
    }),
    );
  });
});

describe("real files", () => {
  const dirs: Array<string> = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("the next prime re-reads changed content and a deleted file fails by name", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "foundry-prime-"));
    dirs.push(baseDir);
    const factoryFile = join(baseDir, "factory.md");
    const stationFile = join(baseDir, "dev.md");
    await writeFile(factoryFile, "FACTORY-V1\n");
    await writeFile(stationFile, "station\n");
    const req = request({ baseDir, instructions: [factoryFile, stationFile], knowledgeRoot: join(baseDir, "knowledge") });

    const first = composed(await composePrime(req));
    expect(first.parts[0]).toMatchObject({ source: "factory.md", hash: sha("FACTORY-V1\n"), content: "FACTORY-V1\n" });

    await writeFile(factoryFile, "FACTORY-V2\n");
    const second = composed(await composePrime(req));
    expect(second.parts[0]).toMatchObject({ source: "factory.md", hash: sha("FACTORY-V2\n"), content: "FACTORY-V2\n" });
    expect(second.text).toContain(">\nFACTORY-V2\n</foundry-source>");
    expect(second.text).not.toContain("FACTORY-V1");

    await unlink(stationFile);
    const third = await composePrime(req);
    expect(third).toMatchObject(
      ComposePrimeResult.SourceUnavailable({
      problems: [expect.objectContaining({ path: stationFile, source: "dev.md", reason: "missing" })],
    }),
    );
  });
});
