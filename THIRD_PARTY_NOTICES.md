# Third-party notices

## DeepSeek Harness

This project targets DeepSeek Harness revision `dd6322d604e00eec1ba5e0c8541159906a21094a` (`dsh-v0.1.2-alpha.3`) through its published `0.1.2-alpha.3` packages. DeepSeek Harness is MIT licensed. No DeepSeek Harness source is vendored in the production packages; the files under `patches/deepseek-harness/` are proposed changes against that revision and retain the upstream license.

## Prime Agent

`vendor/prime-agent-runtime/` is an unmodified copy of `prime-agent-runtime` from Prime Agent revision `f8f0036cc2da1a640aad990ae8dcb7c4820ce32e`, original path `prime-agent-runtime/`. Prime Agent is MIT licensed. The upstream license is preserved at `vendor/prime-agent-runtime/LICENSE.upstream`.

Selected Jupyter transport and namespace-snapshot techniques in `packages/rlm-jupyter/` are adapted from Prime Agent files recorded in `provenance/upstreams.json`; those files contain local changes for the DSH service lifecycle, authenticated generation fencing, byte limits, and durable DSH events.
