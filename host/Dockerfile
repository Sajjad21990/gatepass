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

# Something useful to rent: Python for the renter's jobs. Kept in its own layer
# AFTER the one above, so the host key (pinned on-chain by the owner) survives
# changes here.
RUN apk add --no-cache python3

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

# Clean slate between passes: wipes everything renter can write when a pass
# ends, and before a different pass logs in (see the script's header).
COPY --chown=root:root --chmod=0755 gatepass-wipe /usr/local/bin/gatepass-wipe

# No setuid/setgid programs: renter must have no way to become anyone else.
# (docker-compose.yml also sets no-new-privileges and drops capabilities.)
# NOTE: every layer added to this file must stay BELOW the first RUN, which
# generates the ssh host keys; changing that RUN or anything above it makes
# Docker run it again and gives the machine a new host key.
RUN find / -xdev -type f -perm /6000 -exec chmod a-s {} + ; \
    find / -xdev -type d -perm /2000 -exec chmod g-s {} + ; \
    true

EXPOSE 22

# Starts gatepass-reaper, then execs `sshd -D -e`: sshd is pid 1, in the
# foreground, logging to stderr (=> `docker compose logs host`).
CMD ["/usr/local/bin/gatepass-entrypoint"]
