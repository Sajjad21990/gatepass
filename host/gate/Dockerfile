# Gatepass gate: the only door into a machine.
#
# A machine's sshd container sits on a Docker network with no way out (see
# docker-compose.yml). This container stands in front of it: it listens on the
# published port and copies bytes to the machine's port 22 and back. Nothing
# else. It is a plain TCP forwarder: SSH runs end to end between the renter
# and the machine's sshd, so the gate never sees a key, a certificate's
# private half, or any plaintext, and has nothing to configure or to steal.
FROM alpine:3.22

RUN apk add --no-cache socat

# Not root: the gate needs no privilege at all. It listens on 2222 inside the
# container (an unprivileged port); docker-compose.yml maps the public port.
USER 65534:65534
EXPOSE 2222

ENTRYPOINT ["socat"]
# Overridden per machine in docker-compose.yml (the target differs).
CMD ["-d", "-d", "TCP-LISTEN:2222,fork,reuseaddr,keepalive,max-children=64", "TCP:host:22,keepalive,connect-timeout=10"]
