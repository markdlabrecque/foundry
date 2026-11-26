# Superseded FOU-151 attempts — not passing evidence

These records preserve unsuccessful approaches; neither is the qualification run.

- `fixture-error.json`: initial idle builtin `openai/gpt-4o` without auth; no accepted clear worker and no prompt/request to that model. The startup-auth explanation was source-supported, not a captured stderr trace. Current analyzer classifies the incomplete observations **inconclusive**.
- `blocked-result.json`: corrected sibling loopback `probe-local/inert` fixture; three actual clear launches exited with captured `SDK model is not registered: probe-local/inert`. SDK intentionally uses `modelsPath: null`. **Blocked on that tested fixture approach**, not evidence that SDK cannot support isolation.
- `original-observations.json`: original analyzer output, retained historically only. Its negative checks could falsely verify empty arrays and its failure reason was hardcoded. **Do not use this output to qualify a run.**
- `reanalysis.json`: current prerequisite-aware analyzer applied to both preserved records. Missing newer fetch/group observations stay unverified rather than being invented retroactively.
- `cleanup.json`: original external exact-PGID post-run check for the blocked attempt. It does not belong to the new qualification run.

Both result captures are explicitly path-transformed, not byte-for-byte raw: `/REPO` = source checkout, `/NODE` = pinned Node installation, `/RUN` = that artifact's disposable root. All relationships within an artifact are preserved. The environment's irrelevant PATH search list is replaced by a labeled placeholder. Marker strings, launch IDs, counts, model requests/results, error messages and ordering are unchanged. Original records were published at prior branch head `5e67e08b500a287e3b6854883d22bc34f3dfaa6d` before rebase; the transformed copies here preserve the observations independently of that superseded head.

Recovery was approved as fixture-only: idle builtin `openai/gpt-4.1-mini` plus intentionally fake disposable auth and deny-fetch, with no clear-station prompt. No SDK registration/product change was needed. See the parent directory's new `result.json` and `observations.json` for the complete successful observations.
