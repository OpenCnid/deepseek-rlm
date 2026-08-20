# @deepseek-rlm/dsh-rlm-bundle

Apply `dsh.bundle.patch` after a pinned DeepSeek Harness rc.7 profile. The example uses explicit absolute Windows roots; change both paths for the deployment host. The package declares the RLM packages, Cordis services, in-process continuable provider, schemas, and ZeroMQ transport instead of relying on a base bundle's incidental dependencies.

Install the implementation tarballs before this bundle tarball. The DSH CLI recognizes the `dsh.bundle.patch` manifest and appends this layer to the selected profile. Full operation requires all three ordered patches under `patches/deepseek-harness`; the first two provide the Section 14 parity seams and the third makes downstream informational events cold-readable.
