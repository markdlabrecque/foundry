/** Used inside message updates, with `message` as the target table. Receipt evidence is
 * independent of whether the underlying work is still actionable: never replay abandoned work. */
export const actionableMessage = `
  NOT EXISTS (SELECT 1 FROM agent_request r WHERE r.notice_id = message.id AND r.status IN ('abandoned', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM delegation d WHERE d.notice_id = message.id AND d.status IN ('abandoned', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM assignment a WHERE a.context_message = message.id
    AND a.status = 'ended' AND a.end_reason IN ('abandoned', 'cancelled'))
  AND NOT EXISTS (SELECT 1 FROM repository_context r JOIN assignment a ON a.id = r.assignment_id
    WHERE r.message_id = message.id AND a.status = 'ended' AND a.end_reason IN ('abandoned', 'cancelled'))`;
