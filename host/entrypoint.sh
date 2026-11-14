#!/bin/sh
# Container entrypoint: start the deadline reaper, then become sshd.
#
# sshd stays pid 1 in the foreground with its log on stderr, so `docker compose
# logs` shows it, SIGTERM stops the container as before, and sshd dying ends
# the container. The reaper runs beside it; if it ever exits it is started
# again a second later.

# Per-connection deadlines, written by gatepass-principals. Root only. Old
# records are dropped on every start: their pids mean nothing after a restart.
mkdir -p /run/gatepass/conn
chmod 700 /run/gatepass /run/gatepass/conn
find /run/gatepass -type f -delete

(
    while :; do
        /usr/local/bin/gatepass-reaper
        echo "gatepass-reaper: exited with status $?, restarting" >&2
        sleep 1
    done
) &

# -D: stay in the foreground, -e: log to stderr.
exec /usr/sbin/sshd -D -e
