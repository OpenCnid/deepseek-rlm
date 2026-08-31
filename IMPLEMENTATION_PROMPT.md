# Prompt for a new Codex implementation task

Copy everything below into a new Codex task whose workspace is this repository.

---

Implement the project defined by `SPEC.md` in this workspace. Treat the specification as normative and implement working code—not another architecture proposal.

The workspace may contain only the specification and this prompt when you begin, so bootstrap the repository as needed. First read `SPEC.md` completely, inspect the workspace for `AGENTS.md` or other repository instructions, and create a concrete milestone-based plan tied to the spec's acceptance criteria.

Important architectural constraint: DeepSeek Harness must remain the sole harness/orchestrator. Build the native Cordis `ctx.rlm` capability seam, persistent Jupyter provider, `ipython` tool consumer, Prime-compatible Python bridge, and installable DSH bundle. Do not implement the production path by launching `prime-agent`, wrapping Prime ACP, or instantiating Prime `AgentSession`. ACP may be used only as a compatibility oracle in tests.

Use these pinned upstream baselines unless `SPEC.md` has been intentionally updated:

- DeepSeek Harness: `dd6322d604e00eec1ba5e0c8541159906a21094a` (`dsh-v0.1.2-alpha.3`)
- Prime Agent: `f8f0036cc2da1a640aad990ae8dcb7c4820ce32e`

Clone or inspect those repositories in a temporary/read-only location. Read their `AGENTS.md` files and the exact source contracts before coding. Do not guess DeepSeek Harness APIs from names. Reuse or adapt the smallest MIT-licensed Prime kernel/runtime pieces needed, preserve provenance and license notices, and keep all pins reproducible.

Implement in the milestones specified in `SPEC.md`, starting with repository/tooling bootstrap and a vertical slice that proves persistent state (`x = 41`, then `x + 1`). Continue through native `ctx.subagents.startContinuable()` recursion, explicit child reports/follow-ups, snapshot/restore, the two upstream-ready DeepSeek Harness seam patches, bundle packaging, documentation, and hardening. Do not stop after scaffolding if safe implementation work remains.

Non-negotiable rules:

- Never create a second agent loop in Python or Prime code.
- Never make provider calls from the Python runtime.
- Never silently ignore unsupported `rlm.run` options or substitute models/reasoning levels.
- Never access DeepSeek Harness continuation-manager private fields; implement the generic public seam changes from section 14.
- Preserve DSH tool/session logging, exact Agent authority, cancellation, depth, persistence, and lifecycle semantics.
- Do not replay historical Python cells to restore state.
- Treat IPython as OS-authority code execution, not a sandbox, and test/document the boundary.
- Use `apply_patch` for manual file edits and preserve any pre-existing user changes.
- Do not commit, push, publish packages, or open a PR unless explicitly asked.

For each milestone:

1. Implement the smallest complete vertical behavior.
2. Add focused unit tests and at least one real integration test.
3. Run formatting, lint, typecheck, tests, and package/build checks relevant to the changed packages.
4. Fix failures before advancing.
5. Keep `README.md`, provenance records, and configuration examples synchronized with behavior.

The finished handoff must state:

- what was implemented by package and milestone;
- exact upstream revisions and any adapted files;
- the commands run and their results;
- any spec acceptance criterion not yet met, with concrete evidence and the next required change;
- security/trust limitations; and
- paths to the bundle, example profile, and primary tests.

Begin now by reading `SPEC.md` and the repository instructions, then implement Milestone 0 and proceed as far toward the full Definition of Done as the environment allows.

---
