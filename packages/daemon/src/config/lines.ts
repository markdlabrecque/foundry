import type { FactoryConfig } from "./schema.js";

/** A rule finding on decoded configuration, before it is given a YAML location. */
export interface LineIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
}

export interface LineCheck {
  readonly errors: ReadonlyArray<LineIssue>;
  readonly warnings: ReadonlyArray<LineIssue>;
}

type ProductionLine = FactoryConfig["production_lines"][string];

/**
 * Checks production-line references and rules on a structurally valid
 * configuration (PRD §4 "Production lines", §8.2).
 *
 * Errors: an unknown default line, unknown station references, duplicate stage
 * IDs, rejection routes that do not name an earlier stage, writing stages on a
 * station without worktree isolation, and a final stage that breaks its
 * contract. A line with no `verify` command is only a warning.
 */
export const checkProductionLines = (config: FactoryConfig): LineCheck => {
  const errors: Array<LineIssue> = [];
  const warnings: Array<LineIssue> = [];

  if (!Object.hasOwn(config.production_lines, config.default_production_line)) {
    errors.push({
      path: ["default_production_line"],
      message: `Unknown production line "${config.default_production_line}"`,
    });
  }

  for (const [name, line] of Object.entries(config.production_lines)) {
    checkLine(config, ["production_lines", name], line, errors);

    if (line.verify === undefined) {
      warnings.push({
        path: ["production_lines", name],
        message: "No verify command; integration onto a moved default branch is unchecked",
      });
    }
  }

  return { errors, warnings };
};

/** The isolation of the station a stage names, or undefined if it does not exist. */
const stationIsolation = (config: FactoryConfig, reference: string): "none" | "worktree" | undefined => {
  const parts = reference.split(".");

  if (parts.length !== 2) {return undefined;}

  const [room, station] = parts as [string, string];
  const rooms = config.rooms;

  if (!Object.hasOwn(rooms, room)) {return undefined;}

  const stations = rooms[room]!.stations;

  if (!Object.hasOwn(stations, station)) {return undefined;}

  return stations[station]!.isolation;
};

const checkLine = (
  config: FactoryConfig,
  at: ReadonlyArray<string>,
  line: ProductionLine,
  errors: Array<LineIssue>,
): void => {
  const firstIndex = new Map<string, number>();
  const isolation: Array<"none" | "worktree" | undefined> = [];

  for (const [index, stage] of line.stages.entries()) {
    const stagePath = [...at, "stages", index];

    if (firstIndex.has(stage.id)) {
      errors.push({ path: [...stagePath, "id"], message: `Duplicate stage ID "${stage.id}" in this line` });
    } else {
      firstIndex.set(stage.id, index);
    }

    const stationIso = stationIsolation(config, stage.station);
    isolation.push(stationIso);

    if (stationIso === undefined) {
      errors.push({
        path: [...stagePath, "station"],
        message: `Unknown station "${stage.station}"; expected room.station`,
      });
    } else if (stage.writing && stationIso !== "worktree") {
      errors.push({
        path: [...stagePath, "writing"],
        message: `A writing stage must use a worktree station; "${stage.station}" has isolation none`,
      });
    }

    if (stage.on_rejection !== undefined) {
      const target = firstIndex.get(stage.on_rejection);

      if (target === undefined || target >= index) {
        errors.push({
          path: [...stagePath, "on_rejection"],
          message: `Rejection route "${stage.on_rejection}" does not name an earlier stage`,
        });
      }
    }
  }

  const last = line.stages.length - 1;
  const final = line.stages[last];

  if (final === undefined) {return;}

  const finalPath = [...at, "stages", last];

  const contract = (key: string, message: string): void => {
    errors.push({ path: [...finalPath, key], message: `Final stage ${message}` });
  };

  if (final.writing) {contract("writing", "must not be a writing stage");}

  if (isolation[last] === "none") {contract("station", "must use a worktree station");}

  if (!final.approval) {contract("approval", "must require approval");}

  if (final.on_rejection === undefined) {
    contract("on_rejection", "must name an earlier writing stage as its rejection target");
  } else {
    const target = firstIndex.get(final.on_rejection);

    if (target !== undefined && target < last && !line.stages[target]!.writing) {
      contract("on_rejection", `must route rejection to a writing stage; "${final.on_rejection}" is not writing`);
    }
  }
};
