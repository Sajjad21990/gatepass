use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId};

use ed25519_dalek::{Signer, SigningKey};

const USER_PUB: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL0buLI9HPnPlQiic5uWjCZl300ifty9hSjR+Qd9BjeK vector-user";
const NOW: u64 = 1_794_636_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn near(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}

fn ctx(predecessor: &str, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acc("gatepass.testnet"))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .attached_deposit(deposit)
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(NOW * 1_000_000_000)
        .random_seed([7u8; 32])
        .build());
}

fn mpc_key(ca_pk: [u8; 32]) -> String {
    let key: PublicKey = [vec![0u8], ca_pk.to_vec()].concat().try_into().unwrap();
    String::from(&key)
}

/// Register a machine at 0.01 NEAR per minute and deliver its CA key, as the
/// MPC contract's answer would.
fn add_machine(c: &mut Gatepass, owner: &str, id: &str, ca_pk: [u8; 32]) {
    ctx(owner, MACHINE_STORAGE_FEE);
    let _ = c.register_machine(id.into(), "127.0.0.1".into(), 2222, "renter".into(), near(10));
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    c.on_ca_key(id.into(), Ok(mpc_key(ca_pk)));
}

/// A contract with one machine, `gpu-1`, whose CA key is `ca_pk`.
fn setup(ca_pk: [u8; 32]) -> Gatepass {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);
    add_machine(&mut c, "owner.testnet", "gpu-1", ca_pk);
    c
}

/// The JSON args of the first call the contract made to the MPC contract.
fn mpc_call(method: &str) -> near_sdk::serde_json::Value {
    get_created_receipts()
        .iter()
        .filter(|r| r.receiver_id == acc("v1.signer-prod.testnet"))
        .flat_map(|r| r.actions.iter())
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } if method_name == method.as_bytes() => {
                Some(near_sdk::serde_json::from_slice(args).unwrap())
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no {method} call to the MPC contract"))
}

fn transfers() -> Vec<(AccountId, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit)),
                _ => None,
            })
        })
        .collect()
}

#[test]
fn ca_key_is_reported_in_openssh_format() {
    let c = setup([0xEF; 32]);
    let line = c.ca_public_key("gpu-1".into()).unwrap();
    assert!(line.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI"));
    assert!(line.ends_with(" gatepass-ca:gpu-1"));
    assert_eq!(cert::parse_pubkey_line(&line).unwrap(), [0xEF; 32]);
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().ca_public_key, Some(line));
}

#[test]
fn every_machine_gets_its_own_ca_key_path() {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);

    ctx("owner.testnet", MACHINE_STORAGE_FEE);
    let _ = c.register_machine("gpu-1".into(), "127.0.0.1".into(), 2222, "renter".into(), near(10));
    let asked = mpc_call("derived_public_key");
    assert_eq!(asked["path"], "gatepass-ca-v1/gpu-1");
    assert_eq!(asked["predecessor"], "gatepass.testnet");
    assert_eq!(asked["domain_id"], 1);

    ctx("mallory.testnet", MACHINE_STORAGE_FEE);
    let _ = c.register_machine("cheap".into(), "127.0.0.1".into(), 2222, "renter".into(), near(1));
    assert_eq!(mpc_call("derived_public_key")["path"], "gatepass-ca-v1/cheap");
}

#[test]
fn a_pass_for_one_machine_is_signed_with_that_machines_key_only() {
    // Mallory registers a cheap machine with the same login user as gpu-1.
    let mut c = setup([1; 32]);
    add_machine(&mut c, "mallory.testnet", "cheap", [2; 32]);

    ctx("mallory.testnet", near(20));
    let _ = c.buy_pass("cheap".into(), USER_PUB.into(), 1);

    // The MPC is asked to sign with the cheap machine's path, and the
    // certificate names the cheap machine's CA key, not gpu-1's.
    assert_eq!(mpc_call("sign")["request"]["path"], "gatepass-ca-v1/cheap");
    let body = c.get_pass_signed_bytes(1).unwrap().0;
    let embedded_ca: [u8; 32] = body[body.len() - 32..].try_into().unwrap();
    assert_eq!(embedded_ca, [2; 32]);
}

#[test]
#[should_panic(expected = "this machine has no CA key yet")]
fn buying_before_the_ca_key_is_known_is_rejected() {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);
    ctx("owner.testnet", MACHINE_STORAGE_FEE);
    let _ = c.register_machine("gpu-1".into(), "127.0.0.1".into(), 2222, "renter".into(), near(10));
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
}

#[test]
#[should_panic(expected = "underpaid")]
fn underpayment_is_rejected() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(29)); // 2 minutes cost 0.020 NEAR plus the 0.010 storage fee
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
}

#[test]
#[should_panic(expected = "minutes must be between 1 and 240")]
fn minutes_are_capped() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(10_000));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 241);
}

#[test]
#[should_panic(expected = "ssh_pubkey must start with ssh-ed25519")]
fn non_ed25519_renter_keys_are_rejected() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), "ssh-rsa AAAAB3NzaC1yc2E= x".into(), 2);
}

#[test]
#[should_panic(expected = "not accepting passes")]
fn paused_machines_do_not_sell() {
    let mut c = setup([1; 32]);
    ctx("owner.testnet", NearToken::from_yoctonear(0));
    c.set_machine_active("gpu-1".into(), false);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
}

#[test]
fn buy_pass_fixes_user_expiry_and_serial_and_asks_the_mpc_to_sign() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(35)); // 5 milliNEAR too much
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);

    let pass = c.get_pass(1).unwrap();
    assert_eq!(pass.status, PassStatus::Pending);
    assert_eq!(pass.certificate, None);
    assert_eq!(pass.login_user, "renter");
    assert_eq!(pass.key_id, "gatepass:gpu-1:alice.testnet:1");
    assert_eq!(pass.valid_after, NOW - 60);
    assert_eq!(pass.valid_before, NOW + 120);
    assert_eq!(pass.paid, near(20));

    // The overpayment goes straight back.
    assert_eq!(transfers(), vec![(acc("alice.testnet"), near(5))]);

    // The MPC is asked to sign exactly the stored certificate bytes.
    let body = c.get_pass_signed_bytes(1).unwrap().0;
    let receipts = get_created_receipts();
    let sign = receipts.iter().find(|r| r.receiver_id == acc("v1.signer-prod.testnet")).expect("no call to the MPC contract");
    let (method, args, deposit) = sign
        .actions
        .iter()
        .find_map(|a| match a {
            near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
                Some((String::from_utf8(method_name.clone()).unwrap(), args.clone(), *attached_deposit))
            }
            _ => None,
        })
        .expect("no function call");
    assert_eq!(method, "sign");
    assert_eq!(deposit, NearToken::from_yoctonear(1));
    let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(&args).unwrap();
    assert_eq!(args["request"]["path"], "gatepass-ca-v1/gpu-1");
    assert_eq!(args["request"]["domain_id"], 1);
    assert_eq!(args["request"]["payload_v2"]["Eddsa"], hex(&body));

    // Nothing is earned until the signature arrives.
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().earnings, near(0));
}

#[test]
fn failed_signature_refunds_the_buyer() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);

    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let pass = c.on_pass_signed(1, Err(PromiseError::Failed));
    assert_eq!(pass.status, PassStatus::Failed);
    assert_eq!(pass.certificate, None);
    assert_eq!(transfers(), vec![(acc("alice.testnet"), near(30))]);
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().earnings, near(0));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"pass_failed\"")));
}

#[test]
fn a_signature_that_does_not_verify_is_treated_as_a_failure() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);

    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let pass = c.on_pass_signed(1, Ok(json!({ "scheme": "Ed25519", "signature": vec![9u8; 64] })));
    assert_eq!(pass.status, PassStatus::Failed);
    assert_eq!(transfers(), vec![(acc("alice.testnet"), near(30))]);
}

#[test]
#[should_panic(expected = "pass is not pending")]
fn a_pass_cannot_be_settled_twice() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    c.on_pass_signed(1, Err(PromiseError::Failed));
    c.on_pass_signed(1, Err(PromiseError::Failed));
}

#[test]
#[should_panic(expected = "only the machine owner can withdraw")]
fn only_the_owner_withdraws() {
    let mut c = setup([1; 32]);
    ctx("mallory.testnet", NearToken::from_yoctonear(0));
    let _ = c.withdraw("gpu-1".into());
}

#[test]
#[should_panic(expected = "nothing to withdraw")]
fn owner_cannot_withdraw_unearned_funds() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2); // still pending
    ctx("owner.testnet", NearToken::from_yoctonear(0));
    let _ = c.withdraw("gpu-1".into());
}

#[test]
#[should_panic(expected = "already exists")]
fn machine_ids_are_unique() {
    let mut c = setup([1; 32]);
    ctx("mallory.testnet", NearToken::from_yoctonear(0));
    let _ = c.register_machine("gpu-1".into(), "evil.example".into(), 22, "renter".into(), near(1));
}

#[test]
#[should_panic(expected = "login_user must be a plain unix user name")]
fn login_user_cannot_smuggle_extra_principals() {
    let mut c = setup([1; 32]);
    ctx("mallory.testnet", NearToken::from_yoctonear(0));
    let _ = c.register_machine("gpu-2".into(), "h.example".into(), 22, "renter,root".into(), near(1));
}

#[test]
#[should_panic(expected = "too early")]
fn stuck_refund_is_not_available_while_the_pass_could_still_be_signed() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    ctx("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.refund_stuck_pass(1);
}

// ---------- the happy path, with a test key standing in for the MPC ----------

fn test_ca() -> SigningKey {
    SigningKey::from_bytes(&[42u8; 32])
}

/// What the MPC contract would answer for pass `serial`.
fn mpc_signature(c: &Gatepass, serial: u64) -> Vec<u8> {
    test_ca().sign(&c.get_pass_signed_bytes(serial).unwrap().0).to_bytes().to_vec()
}

#[test]
fn a_signed_pass_yields_a_certificate_and_credits_the_owner() {
    let mut c = setup(test_ca().verifying_key().to_bytes());
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    let signature = mpc_signature(&c, 1);

    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let pass = c.on_pass_signed(1, Ok(json!({ "scheme": "Ed25519", "signature": signature })));
    assert_eq!(pass.status, PassStatus::Signed);
    let cert = pass.certificate.unwrap();
    assert!(cert.starts_with("ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29t"));
    assert!(cert.ends_with(" gatepass:gpu-1:alice.testnet:1"));
    assert!(transfers().is_empty(), "nothing is refunded on success");
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"pass_issued\"")));

    // The price goes to the owner; the storage fee stays with the contract.
    let machine = c.get_machine("gpu-1".into()).unwrap();
    assert_eq!(machine.earnings, near(20));
    assert_eq!(machine.passes_issued, 1);
    assert_eq!(c.list_passes("gpu-1".into(), None, None).len(), 1);

    ctx("owner.testnet", NearToken::from_yoctonear(0));
    let _ = c.withdraw("gpu-1".into());
    assert_eq!(transfers(), vec![(acc("owner.testnet"), near(20))]);
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().earnings, near(0));
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().total_earned, near(20));
}

#[test]
fn a_signature_made_for_another_machines_key_is_rejected() {
    // gpu-1 trusts a different key than the one that signed.
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    let signature = mpc_signature(&c, 1);
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    assert_eq!(c.on_pass_signed(1, Ok(json!({ "scheme": "Ed25519", "signature": signature }))).status, PassStatus::Failed);
}

#[test]
fn an_unexpected_mpc_answer_refunds_instead_of_getting_stuck() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let pass = c.on_pass_signed(1, Ok(json!({ "scheme": "Secp256k1", "big_r": "x" })));
    assert_eq!(pass.status, PassStatus::Failed);
    assert_eq!(transfers(), vec![(acc("alice.testnet"), near(30))]);
}

#[test]
fn anyone_can_settle_a_pending_pass_with_the_real_signature() {
    let mut c = setup(test_ca().verifying_key().to_bytes());
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    let signature = mpc_signature(&c, 1);

    ctx("owner.testnet", NearToken::from_yoctonear(0));
    let pass = c.settle_pass(1, Base64VecU8::from(signature));
    assert_eq!(pass.status, PassStatus::Signed);
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().earnings, near(20));
}

#[test]
#[should_panic(expected = "signature does not verify for this pass")]
fn settling_with_a_bad_signature_changes_nothing() {
    let mut c = setup(test_ca().verifying_key().to_bytes());
    ctx("alice.testnet", near(30));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    ctx("mallory.testnet", NearToken::from_yoctonear(0));
    c.settle_pass(1, Base64VecU8::from(vec![9u8; 64]));
}

#[test]
fn quote_is_price_plus_storage_fee() {
    let c = setup([1; 32]);
    let q = c.quote("gpu-1".into(), 3);
    assert_eq!((q.price, q.storage_fee, q.total), (near(30), near(10), near(40)));
}

#[test]
fn storage_fees_cover_the_storage_actually_used() {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);
    let cost = |bytes: u64| env::storage_byte_cost().saturating_mul(bytes as u128);

    // Worst case machine: longest id, host and login user.
    let before = env::storage_usage();
    ctx("owner-with-a-very-long-account-name-0123456789abcdef.testnet", MACHINE_STORAGE_FEE);
    let id = "m".repeat(32);
    let _ = c.register_machine(id.clone(), "h".repeat(128), 2222, "u".repeat(32), near(10));
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    c.on_ca_key(id.clone(), Ok(mpc_key(test_ca().verifying_key().to_bytes())));
    c.machines.flush();
    let machine_bytes = env::storage_usage() - before;
    assert!(cost(machine_bytes) <= MACHINE_STORAGE_FEE, "machine uses {machine_bytes} bytes");

    let before = env::storage_usage();
    ctx("buyer-with-a-very-long-account-name-0123456789abcdef.testnet", near(20));
    let _ = c.buy_pass(id, USER_PUB.into(), 1);
    let signature = mpc_signature(&c, 1);
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    c.on_pass_signed(1, Ok(json!({ "scheme": "Ed25519", "signature": signature })));
    c.machines.flush();
    c.passes.flush();
    c.machine_passes.flush();
    let pass_bytes = env::storage_usage() - before;
    assert!(cost(pass_bytes) <= PASS_STORAGE_FEE, "pass uses {pass_bytes} bytes");
}

#[test]
#[should_panic(expected = "attach the")]
fn registering_a_machine_costs_the_storage_fee() {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);
    ctx("owner.testnet", near(19));
    let _ = c.register_machine("gpu-1".into(), "127.0.0.1".into(), 2222, "renter".into(), near(10));
}

#[test]
#[should_panic(expected = "host must be a host name or IP address")]
fn host_cannot_look_like_an_ssh_option() {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);
    ctx("mallory.testnet", MACHINE_STORAGE_FEE);
    let _ = c.register_machine("evil".into(), "-oProxyCommand=id".into(), 22, "renter".into(), near(1));
}
