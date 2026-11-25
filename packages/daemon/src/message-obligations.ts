/** Used inside message updates, with `alias` naming a row of the message table (the target, or an
 * earlier same-slot message). Receipt evidence is independent of whether the underlying work is
 * still actionable: never replay abandoned work. */
export const actionableMessageAs = (alias: string): string => `
  NOT EXISTS (SELECT 1 FROM agent_request r WHERE r.notice_id = ${alias}.id AND r.status IN ('abandoned', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM delegation d WHERE d.notice_id = ${alias}.id AND d.status IN ('abandoned', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.context_message = ${alias}.id
    AND a.status = 'ended' AND a.end_reason IN ('abandoned', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM repository_context r JOIN assignment a ON a.id = r.assignment_id
    WHERE r.message_id = ${alias}.id AND a.status = 'ended' AND a.end_reason IN ('abandoned', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM resume_notice n JOIN assignment a ON a.id = n.assignment_id
    WHERE n.message_id = ${alias}.id AND a.status = 'ended' AND a.end_reason IN ('abandoned', 'cancelled'))`;

/** The check with `message` as the target table. */
export const actionableMessage = actionableMessageAs("message");
