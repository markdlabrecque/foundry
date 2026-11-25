import { Schema, SchemaIssue } from "effect";
import * as Result from "effect/Result";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import type { Document, Node as YamlNode } from "yaml";
import { checkProductionLines } from "./lines.js";
import type { LineIssue } from "./lines.js";
import { checkNames } from "./names.js";
import { FactoryConfig } from "./schema.js";
import { checkToolNames } from "./tool-set.js";

/** One reason a factory YAML file is rejected, with its YAML location where available. */
export interface ConfigProblem {
  /** Dotted path to the offending setting, empty for the whole document. */
  readonly path: string;
  readonly message: string;
  /** 1-based line and column of the offending node, when it can be found. */
  readonly line?: number;
  readonly column?: number;
}

export type DecodeResult =
  | {
      readonly _tag: "Valid";
      readonly config: FactoryConfig;
      /** Findings that do not reject the configuration, such as a line with no `verify`. */
      readonly warnings: ReadonlyArray<ConfigProblem>;
    }
  | { readonly _tag: "Invalid"; readonly problems: ReadonlyArray<ConfigProblem> };

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) =>
    issue._tag === "UnexpectedKey" ? "Unknown key" : SchemaIssue.defaultLeafHook(issue),
});

/**
 * Decodes factory YAML text into its structural configuration (PRD §4).
 *
 * Pure and read-only: it parses and checks shape only. It rejects malformed YAML,
 * multiple documents, duplicate keys, unresolved tags, unknown keys, wrong types,
 * unsupported versions and invalid scalar constraints, and applies the defaults.
 */
export const decodeFactoryYaml = (text: string): DecodeResult => {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, lineCounter });

  const at = (offset: number): { line: number; column: number } => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };

  // YAML warnings (such as an unresolved tag) are errors in strict configuration.
  const yamlErrors = [...doc.errors, ...doc.warnings];
  if (yamlErrors.length > 0) {
    return {
      _tag: "Invalid",
      problems: yamlErrors.map((error) => ({
        path: "",
        message: `${error.message} (${error.code})`,
        ...at(error.pos[0]),
      })),
    };
  }

  const decoded = Schema.decodeUnknownResult(FactoryConfig)(doc.toJS(), {
    onExcessProperty: "error",
    errors: "all",
  });
  if (Result.isSuccess(decoded)) {
    const config = decoded.success;
    // Name and tool-name rules (PRD §4) run first; a name problem points at its key.
    // Line rules resolve station references by name, so they run only on valid names.
    const nameProblems = [...checkNames(config), ...checkToolNames(config)].map((problem) => ({
      path: problem.path.join("."),
      message: problem.message,
      ...at(locate(doc, problem.path, true) ?? 0),
    }));
    if (nameProblems.length > 0) return { _tag: "Invalid", problems: nameProblems };

    const located = (issue: LineIssue): ConfigProblem => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
      ...at(locate(doc, issue.path, false) ?? 0),
    });
    const lines = checkProductionLines(config);
    if (lines.errors.length > 0) {
      return { _tag: "Invalid", problems: byLocation(lines.errors.map(located)) };
    }
    return { _tag: "Valid", config, warnings: byLocation(lines.warnings.map(located)) };
  }

  const problems = formatIssue(decoded.failure.issue).issues.map((issue) => {
    const path = (issue.path ?? []).map((segment) =>
      typeof segment === "object" ? segment.key : segment,
    );
    // An empty document has no node; its problems belong at the document start.
    const range = locate(doc, path, issue.message === "Unknown key") ?? 0;
    return {
      path: path.map(String).join("."),
      message: issue.message,
      ...at(range),
    };
  });
  return { _tag: "Invalid", problems: byLocation(problems) };
};

const byLocation = (problems: ConfigProblem[]): ConfigProblem[] =>
  problems.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));

/**
 * Adds YAML locations to problems found on an already decoded configuration
 * (such as effective-station resolution), whose paths are dotted setting paths.
 * Problems that already carry a line are returned unchanged.
 */
export const locateProblems = (
  text: string,
  problems: ReadonlyArray<ConfigProblem>,
): ReadonlyArray<ConfigProblem> => {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false, lineCounter });
  return problems.map((problem) => {
    if (problem.line !== undefined) return problem;
    const path = problem.path === "" ? [] : problem.path.split(".");
    const { line, col } = lineCounter.linePos(locate(doc, path, false) ?? 0);
    return { ...problem, line, column: col };
  });
};

/**
 * Finds the start offset of the node at `path`, or of its deepest existing
 * ancestor when the path does not exist (a missing key). For an unknown key the
 * key itself is located rather than its value.
 */
const locate = (
  doc: Document,
  path: ReadonlyArray<PropertyKey>,
  pointAtKey: boolean,
): number | undefined => {
  let node: unknown = doc.contents;
  let offset = rangeStart(node);
  for (const [index, segment] of path.entries()) {
    if (isAlias(node)) node = node.resolve(doc);
    let next: unknown;
    let keyNode: unknown;
    if (isMap(node)) {
      const pair = node.items.find(
        (item) => isScalar(item.key) && String(item.key.value) === String(segment),
      );
      next = pair?.value;
      keyNode = pair?.key;
    } else if (isSeq(node)) {
      next = node.items[Number(segment)];
    }
    if (pointAtKey && index === path.length - 1 && keyNode !== undefined) {
      return rangeStart(keyNode) ?? offset;
    }
    if (next === undefined || next === null) return keyNode === undefined ? offset : rangeStart(keyNode) ?? offset;
    node = next;
    offset = rangeStart(node) ?? offset;
  }
  return offset;
};

const rangeStart = (node: unknown): number | undefined =>
  (node as YamlNode | null | undefined)?.range?.[0];
