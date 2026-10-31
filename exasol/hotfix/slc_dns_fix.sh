#!/bin/bash
# Fix: Java virtual schema adapters cannot resolve database host names.
#
# Symptom: the JDBC adapter behind VS_CBS fails with an unknown-host error for the RDS endpoint,
# although the Exasol node itself resolves it.
# Cause:   the java-17 script language container has no /etc/resolv.conf or /etc/hosts.
# Fix:     link both to the node's /conf files inside the container. Re-run after an Exasol restart.
set -euo pipefail

CTR=$(podman ps --filter name=exasol-db- --format '{{.Names}}' | head -n1)
[ -n "$CTR" ] || { echo "no running exasol-db-* container" >&2; exit 1; }

T=$(mktemp -d)
ln -s /conf/resolv.conf "$T/resolv.conf"
ln -s /conf/hosts       "$T/hosts"
tar -C "$T" -cf - resolv.conf hosts | podman cp - "$CTR":/exa/slc/java-17/etc/
rm -r "$T"

podman cp "$CTR":/exa/slc/java-17/etc - | tar -tvf - | grep -E 'etc/(resolv.conf|hosts)$'
