# exasol-labs/exasol-scheduler: runs the SQL jobs in SCHED.SCHED_TASKS (exasol/sql/17_scheduler.sql)
# against Exasol and writes each run to SCHED.SCHED_HISTORY. The prebuilt release binary is pinned
# by tag and by its published SHA-256. It needs glibc 2.38 or newer, hence Debian 13 (trixie).
FROM debian:trixie-slim

ARG SCHEDULER_VERSION=v0.4.1
ARG SCHEDULER_SHA256=5d546dd6fdad38340562562bd5bab7097dc1a074b07dd6b7cf548bcaed50f6ec

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSLo /tmp/s.tgz "https://github.com/exasol-labs/exasol-scheduler/releases/download/${SCHEDULER_VERSION}/exasol_scheduler-${SCHEDULER_VERSION}-linux-x86_64.tar.gz" \
    && echo "${SCHEDULER_SHA256}  /tmp/s.tgz" | sha256sum -c - \
    && tar -xzf /tmp/s.tgz -C /tmp \
    && install -m 0755 /tmp/target/x86_64-unknown-linux-gnu/release/exasol_scheduler /usr/local/bin/exasol_scheduler \
    && rm -rf /tmp/s.tgz /tmp/target \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10002 scheduler

USER scheduler
# Credentials come from the environment (docker-compose.yml), never from the command line.
ENTRYPOINT ["/usr/local/bin/exasol_scheduler"]
