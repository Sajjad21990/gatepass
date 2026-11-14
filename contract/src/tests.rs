use super::*;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId};

// Deterministic test CA (RFC 8032 test vector 1 secret key), used only to make
// a signature the contract will accept in place of the MPC network.
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

/// A contract with a CA key set and one machine at 0.01 NEAR per minute.
fn setup(ca_pk: [u8; 32]) -> Gatepass {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);
    let key: PublicKey = [vec![0u8], ca_pk.to_vec()].concat().try_into().unwrap();
    c.on_ca_key(Ok(String::from(&key)));
    ctx("owner.testnet", NearToken::from_yoctonear(0));
    c.register_machine("gpu-1".into(), "127.0.0.1".into(), 2222, "renter".into(), near(10));
    c
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
    let line = c.ca_public_key().unwrap();
    assert!(line.starts_with("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI"));
    assert!(line.ends_with(" gatepass-ca"));
    assert_eq!(cert::parse_pubkey_line(&line).unwrap(), [0xEF; 32]);
}

#[test]
#[should_panic(expected = "CA key not set yet")]
fn buying_before_the_ca_key_is_known_is_rejected() {
    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let mut c = Gatepass::new(acc("v1.signer-prod.testnet"), None, None);
    ctx("alice.testnet", near(20));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
}

#[test]
#[should_panic(expected = "underpaid")]
fn underpayment_is_rejected() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(19)); // 2 minutes cost 0.020 NEAR
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
    ctx("alice.testnet", near(20));
    let _ = c.buy_pass("gpu-1".into(), "ssh-rsa AAAAB3NzaC1yc2E= x".into(), 2);
}

#[test]
#[should_panic(expected = "not accepting passes")]
fn paused_machines_do_not_sell() {
    let mut c = setup([1; 32]);
    ctx("owner.testnet", NearToken::from_yoctonear(0));
    c.set_machine_active("gpu-1".into(), false);
    ctx("alice.testnet", near(20));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
}

#[test]
fn buy_pass_fixes_user_expiry_and_serial_and_asks_the_mpc_to_sign() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(25)); // 5 milliNEAR too much
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
    assert_eq!(args["request"]["path"], "gatepass-ca-v1");
    assert_eq!(args["request"]["domain_id"], 1);
    assert_eq!(args["request"]["payload_v2"]["Eddsa"], hex(&body));

    // Nothing is earned until the signature arrives.
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().earnings, near(0));
}

#[test]
fn failed_signature_refunds_the_buyer() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(20));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);

    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let pass = c.on_pass_signed(1, Err(PromiseError::Failed));
    assert_eq!(pass.status, PassStatus::Failed);
    assert_eq!(pass.certificate, None);
    assert_eq!(transfers(), vec![(acc("alice.testnet"), near(20))]);
    assert_eq!(c.get_machine("gpu-1".into()).unwrap().earnings, near(0));
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"pass_failed\"")));
}

#[test]
fn a_signature_that_does_not_verify_is_treated_as_a_failure() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(20));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);

    ctx("gatepass.testnet", NearToken::from_yoctonear(0));
    let pass = c.on_pass_signed(1, Ok(SignResponse { scheme: "Ed25519".into(), signature: vec![9; 64] }));
    assert_eq!(pass.status, PassStatus::Failed);
    assert_eq!(transfers(), vec![(acc("alice.testnet"), near(20))]);
}

#[test]
#[should_panic(expected = "pass is not pending")]
fn a_pass_cannot_be_settled_twice() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(20));
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
    ctx("alice.testnet", near(20));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2); // still pending
    ctx("owner.testnet", NearToken::from_yoctonear(0));
    let _ = c.withdraw("gpu-1".into());
}

#[test]
#[should_panic(expected = "already exists")]
fn machine_ids_are_unique() {
    let mut c = setup([1; 32]);
    ctx("mallory.testnet", NearToken::from_yoctonear(0));
    c.register_machine("gpu-1".into(), "evil.example".into(), 22, "renter".into(), near(1));
}

#[test]
#[should_panic(expected = "login_user must be a plain unix user name")]
fn login_user_cannot_smuggle_extra_principals() {
    let mut c = setup([1; 32]);
    ctx("mallory.testnet", NearToken::from_yoctonear(0));
    c.register_machine("gpu-2".into(), "h.example".into(), 22, "renter,root".into(), near(1));
}

#[test]
#[should_panic(expected = "too early")]
fn stuck_refund_is_not_available_while_the_pass_could_still_be_signed() {
    let mut c = setup([1; 32]);
    ctx("alice.testnet", near(20));
    let _ = c.buy_pass("gpu-1".into(), USER_PUB.into(), 2);
    ctx("alice.testnet", NearToken::from_yoctonear(0));
    let _ = c.refund_stuck_pass(1);
}
