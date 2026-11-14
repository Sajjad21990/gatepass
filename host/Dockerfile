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

EXPOSE 22

# -D: stay in the foreground, -e: log to stderr (=> `docker compose logs host`).
CMD ["/usr/sbin/sshd", "-D", "-e"]
