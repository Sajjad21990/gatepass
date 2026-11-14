//! OpenSSH user certificate encoding (`ssh-ed25519-cert-v01@openssh.com`).
//!
//! Follows PROTOCOL.certkeys in the OpenSSH source. A `string` is a 4-byte
//! big-endian length followed by the bytes; integers are big-endian.
//! The CA signs fields 1..13 exactly as serialised, with plain Ed25519.

use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};

pub const CERT_TYPE: &str = "ssh-ed25519-cert-v01@openssh.com";
pub const KEY_TYPE: &str = "ssh-ed25519";
const USER_CERT: u32 = 1;

fn put_u32(buf: &mut Vec<u8>, n: u32) {
    buf.extend_from_slice(&n.to_be_bytes());
}

fn put_u64(buf: &mut Vec<u8>, n: u64) {
    buf.extend_from_slice(&n.to_be_bytes());
}

fn put_str(buf: &mut Vec<u8>, bytes: &[u8]) {
    put_u32(buf, bytes.len() as u32);
    buf.extend_from_slice(bytes);
}

/// One name/data pair of the critical options or extensions list.
/// Non-empty data is itself wrapped as a string; empty data is an empty string.
fn put_option(buf: &mut Vec<u8>, name: &str, value: &str) {
    put_str(buf, name.as_bytes());
    if value.is_empty() {
        put_str(buf, &[]);
    } else {
        let mut data = Vec::with_capacity(4 + value.len());
        put_str(&mut data, value.as_bytes());
        put_str(buf, &data);
    }
}

/// `string "ssh-ed25519"` followed by `string <32-byte key>`.
pub fn key_blob(pk: &[u8; 32]) -> Vec<u8> {
    let mut blob = Vec::with_capacity(51);
    put_str(&mut blob, KEY_TYPE.as_bytes());
    put_str(&mut blob, pk);
    blob
}

pub struct CertFields<'a> {
    pub nonce: &'a [u8; 32],
    pub renter_pk: &'a [u8; 32],
    pub serial: u64,
    pub key_id: &'a str,
    /// The single login user this certificate is valid for.
    pub principal: &'a str,
    pub valid_after: u64,
    pub valid_before: u64,
    /// `force-command` critical option: the host runs this instead of the
    /// renter's command, which is how the paid time is enforced.
    pub force_command: &'a str,
    pub ca_pk: &'a [u8; 32],
}

/// Fields 1..13: the exact bytes the CA signs.
pub fn cert_body(f: &CertFields) -> Vec<u8> {
    let mut b = Vec::with_capacity(400);
    put_str(&mut b, CERT_TYPE.as_bytes()); // 1  type string
    put_str(&mut b, f.nonce); // 2  nonce
    put_str(&mut b, f.renter_pk); // 3  renter public key
    put_u64(&mut b, f.serial); // 4  serial
    put_u32(&mut b, USER_CERT); // 5  type
    put_str(&mut b, f.key_id.as_bytes()); // 6  key id

    let mut principals = Vec::new(); // 7  valid principals
    put_str(&mut principals, f.principal.as_bytes());
    put_str(&mut b, &principals);

    put_u64(&mut b, f.valid_after); // 8  valid after
    put_u64(&mut b, f.valid_before); // 9  valid before

    let mut critical = Vec::new(); // 10 critical options (sorted by name)
    put_option(&mut critical, "force-command", f.force_command);
    put_str(&mut b, &critical);

    let mut extensions = Vec::new(); // 11 extensions (sorted by name)
    put_option(&mut extensions, "permit-pty", "");
    put_str(&mut b, &extensions);

    put_str(&mut b, &[]); // 12 reserved
    put_str(&mut b, &key_blob(f.ca_pk)); // 13 signature key
    b
}

/// Append field 14 (the signature) and render the one-line certificate file.
pub fn cert_line(body: &[u8], signature: &[u8; 64]) -> String {
    let mut sig_blob = Vec::with_capacity(83);
    put_str(&mut sig_blob, KEY_TYPE.as_bytes());
    put_str(&mut sig_blob, signature);

    let mut full = Vec::with_capacity(body.len() + 87);
    full.extend_from_slice(body);
    put_str(&mut full, &sig_blob);
    format!("{} {}", CERT_TYPE, STANDARD.encode(full))
}

/// `ssh-ed25519 AAAA... comment`
pub fn pubkey_line(pk: &[u8; 32], comment: &str) -> String {
    format!("{} {} {}", KEY_TYPE, STANDARD.encode(key_blob(pk)), comment)
}

/// Accepts `ssh-ed25519 AAAA... [comment]` and returns the raw 32-byte key.
pub fn parse_pubkey_line(line: &str) -> Result<[u8; 32], &'static str> {
    let mut parts = line.split_whitespace();
    if parts.next() != Some(KEY_TYPE) {
        return Err("ssh_pubkey must start with ssh-ed25519");
    }
    let b64 = parts.next().ok_or("ssh_pubkey is missing the base64 key")?;
    let blob = STANDARD.decode(b64).map_err(|_| "ssh_pubkey is not valid base64")?;
    if blob.len() != 51 || blob != key_blob(&blob[19..51].try_into().unwrap()) {
        return Err("ssh_pubkey is not an Ed25519 public key blob");
    }
    Ok(blob[19..51].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Known-good vector made with OpenSSH 10.3:
    //   ssh-keygen -s ca -I "gatepass:gpu-1:alice.testnet:42" -z 42 -n renter \
    //     -V 20261114060000Z:20261114061000Z -O clear -O permit-pty \
    //     -O force-command="/usr/local/bin/gatepass-session 1794636600" user.pub
    const CA_PUB: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO9Ob7VfwiyAP193hXIXXMszSfsnj35aRnlVsnK30Mnv vector-ca";
    const USER_PUB: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL0buLI9HPnPlQiic5uWjCZl300ifty9hSjR+Qd9BjeK vector-user";
    const CERT: &str = "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIDXlDtRJ5Mory8sKQsRfip/b9pcDXjJ+UydmmKwXEbx3AAAAIL0buLI9HPnPlQiic5uWjCZl300ifty9hSjR+Qd9BjeKAAAAAAAAACoAAAABAAAAH2dhdGVwYXNzOmdwdS0xOmFsaWNlLnRlc3RuZXQ6NDIAAAAKAAAABnJlbnRlcgAAAABq9/jgAAAAAGr3+zgAAABDAAAADWZvcmNlLWNvbW1hbmQAAAAuAAAAKi91c3IvbG9jYWwvYmluL2dhdGVwYXNzLXNlc3Npb24gMTc5NDYzNjYwMAAAABIAAAAKcGVybWl0LXB0eQAAAAAAAAAAAAAAMwAAAAtzc2gtZWQyNTUxOQAAACDvTm+1X8IsgD9fd4VyF1zLM0n7J49+WkZ5VbJyt9DJ7wAAAFMAAAALc3NoLWVkMjU1MTkAAABA4QYUcKGa14qC0a0jXuEx8GtlMfOKEP3YvhPjvd+k3x5j3xoi/lEq0Jqq0Mpf/jt4TF3kiy16uVii4S3LclEkBg==";
    const NONCE_HEX: &str = "35e50ed449e4ca2bcbcb0a42c45f8a9fdbf697035e327e53276698ac1711bc77";
    const BODY_LEN: usize = 337;

    fn hex32(s: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    fn vector_body() -> Vec<u8> {
        cert_body(&CertFields {
            nonce: &hex32(NONCE_HEX),
            renter_pk: &parse_pubkey_line(USER_PUB).unwrap(),
            serial: 42,
            key_id: "gatepass:gpu-1:alice.testnet:42",
            principal: "renter",
            valid_after: 1794636000,
            valid_before: 1794636600,
            force_command: "/usr/local/bin/gatepass-session 1794636600",
            ca_pk: &parse_pubkey_line(CA_PUB).unwrap(),
        })
    }

    #[test]
    fn body_matches_ssh_keygen_vector() {
        let expected = STANDARD.decode(CERT.split(' ').nth(1).unwrap()).unwrap();
        let body = vector_body();
        assert_eq!(body.len(), BODY_LEN);
        assert_eq!(body, expected[..BODY_LEN]);
    }

    #[test]
    fn full_certificate_matches_ssh_keygen_vector() {
        let expected = STANDARD.decode(CERT.split(' ').nth(1).unwrap()).unwrap();
        // The signature is the last 64 bytes of the ssh-keygen certificate.
        let signature: [u8; 64] = expected[expected.len() - 64..].try_into().unwrap();
        assert_eq!(cert_line(&vector_body(), &signature), CERT);
    }

    #[test]
    fn pubkey_line_round_trips() {
        let pk = parse_pubkey_line(USER_PUB).unwrap();
        assert_eq!(pubkey_line(&pk, "vector-user"), USER_PUB);
        // comment is optional
        assert_eq!(parse_pubkey_line(USER_PUB.rsplit_once(' ').unwrap().0).unwrap(), pk);
    }

    #[test]
    fn rejects_other_key_types_and_garbage() {
        assert!(parse_pubkey_line("ssh-rsa AAAAB3NzaC1yc2E= x").is_err());
        assert!(parse_pubkey_line("ssh-ed25519").is_err());
        assert!(parse_pubkey_line("ssh-ed25519 not-base64!").is_err());
        assert!(parse_pubkey_line("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5").is_err());
        // a certificate is not a public key
        assert!(parse_pubkey_line(CERT).is_err());
    }
}
