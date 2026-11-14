# Gatepass demo host: sshd that only accepts CA-signed user certificates.
FROM alpine:3.22

RUN apk add --no-cache openssh-server \
    # Host keys baked in at build time, so the host identity is stable across
    # container restarts (it changes only when the image is rebuilt).
 && ssh-keygen -A \
    # Login user. adduser -D leaves the account locked ("!"), which sshd treats
    # as "no login at all"; "*" means "no valid password" but pubkey/cert is OK.
 && adduser -D -s /bin/sh renter \
 && echo 'renter:*' | chpasswd -e

COPY sshd_config /etc/ssh/sshd_config

# Session-deadline wrapper: every certificate's force-command points here.
# Root-owned and not writable by renter, so a session cannot replace it.
COPY --chown=root:root --chmod=0755 gatepass-session /usr/local/bin/gatepass-session

# Root-side backstop for the wrapper (the user can stop or kill the wrapper):
#   gatepass-principals  run by sshd as root at login; records the deadline
#                        found in the certificate (see sshd_config)
#   gatepass-reaper      root loop that kills a connection past its deadline
COPY --chown=root:root --chmod=0755 gatepass-principals /usr/local/bin/gatepass-principals
COPY --chown=root:root --chmod=0755 gatepass-reaper /usr/local/bin/gatepass-reaper
COPY --chown=root:root --chmod=0755 entrypoint.sh /usr/local/bin/gatepass-entrypoint

EXPOSE 22

# Starts gatepass-reaper, then execs `sshd -D -e`: sshd is pid 1, in the
# foreground, logging to stderr (=> `docker compose logs host`).
CMD ["/usr/local/bin/gatepass-entrypoint"]
