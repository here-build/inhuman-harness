ARG DENO_BASE=denoland/deno:2.8.3@sha256:438618d8c0678c3154fc77ad6edad61f38cbc42803a181e7908d3e2c9e645022
FROM ${DENO_BASE}

USER root
WORKDIR /runtime
ENV DENO_DIR=/runtime/cache
COPY deno.json deno.lock dependencies.ts ./
RUN deno cache --frozen --config=/runtime/deno.json dependencies.ts \
    && chmod -R a+rX /runtime
USER 1000:1000
