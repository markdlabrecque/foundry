import type { FactoryConfig } from "./schema.js";

/** A name rule broken by a decoded configuration, located by the path to the offending key. */
export interface NameProblem {
  readonly path: ReadonlyArray<string>;
  readonly message: string;
}

/** Room and station names: lowercase letters, digits and hyphens, starting with a letter (PRD §4). */
const NAME_GRAMMAR = /^[a-z][a-z0-9-]*$/;

/** Names no room or station may take (PRD §4). */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["packs", "lore", "factory"]);

const grammarProblem = (kind: "Room" | "Station", name: string): string | undefined => {
  if (!NAME_GRAMMAR.test(name)) {
    return `${kind} name "${name}" must be lowercase letters, digits and hyphens, starting with a letter`;
  }

  if (RESERVED_NAMES.has(name)) {return `${kind} name "${name}" is reserved`;}

  return undefined;
};

/**
 * Checks room and station names on a structurally valid configuration (PRD §4, §5.1–2):
 * grammar, reserved names, station uniqueness across the whole factory, and the
 * namespace rooms and stations share. Pure: it reads only the decoded value.
 */
export const checkNames = (config: FactoryConfig): ReadonlyArray<NameProblem> => {
  const problems: Array<NameProblem> = [];
  const rooms = Object.keys(config.rooms);
  const roomNames = new Set(rooms);
  const stationRoom = new Map<string, string>();

  for (const room of rooms) {
    const roomPath = ["rooms", room];
    const roomProblem = grammarProblem("Room", room);

    if (roomProblem !== undefined) {problems.push({ path: roomPath, message: roomProblem });}

    for (const station of Object.keys(config.rooms[room]?.stations ?? {})) {
      const path = [...roomPath, "stations", station];
      const stationProblem = grammarProblem("Station", station);

      if (stationProblem !== undefined) {problems.push({ path, message: stationProblem });}

      const first = stationRoom.get(station);

      if (first !== undefined) {
        problems.push({
          path,
          message: `Station name "${station}" is already used by ${first}.${station}; station names are unique across the factory`,
        });
      } else {
        stationRoom.set(station, room);
      }

      if (roomNames.has(station)) {
        problems.push({
          path,
          message: `Station name "${station}" is also a room name; rooms and stations share one namespace`,
        });
      }
    }
  }

  return problems;
};
